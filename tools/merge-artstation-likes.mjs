#!/usr/bin/env node
/**
 * Folds an ArtStation likes export into taste.json.
 *
 *   node tools/merge-artstation-likes.mjs <likes.json> [taste.json]
 *
 * The export comes from tools/grab-artstation-likes.js, run in your own
 * browser, because ArtStation refuses every /users/ path to this project.
 *
 * Likes are the strongest signal this profile can get: unlike a rating session
 * they are deliberate, they accumulated over years, and an ArtStation tag is
 * real vocabulary rather than a word scraped off a title. So artists and tags
 * here outweigh what a calibration can infer — but this still MERGES rather
 * than replaces, because a calibration carries something likes cannot: what
 * you turned down.
 */

import { readFile, writeFile } from 'node:fs/promises';

const MAX_WEIGHT = 10;
const MAX_LIKES = 3000;
const MAX_TERMS = 400;

/**
 * Words that describe nothing about a subject.
 *
 * The third group is the one that matters and was not obvious until 3,000 real
 * likes were in front of me: ArtStation descriptions are mostly artists
 * talking about their pipeline and their socials, so "unreal", "megascans",
 * "patreon" and "tutorial" outrank every actual subject. Those terms are real
 * signal about MEDIUM — they say this is real-time 3D work — which is why they
 * are allowed through to the suggested search subjects below while being kept
 * out of the ranking vocabulary, where they would match nothing on Reddit or
 * Danbooru anyway.
 */
const FILLER =
  'a an and the of in on at to for with by from is it this that my our your their as or not but if so ' +
  'just out up down over under into about after before here there what which who when where how very ' +
  'much many also been have has had will would can could should was were are be being i i\'ve it\'s ' +
  'you we they he she its me him her them these those then than some any all one two three more most ' +
  'little really while back time first last own only even still again';
const GENERIC_ART =
  'art artwork illustration digital painting drawing design concept study sketch render rendering ' +
  'final personal project commission original scene shot test practice piece series part version copy ' +
  'print prints image images picture pictures work works done like inspired based wanted created create';
const PIPELINE =
  'unreal engine ue4 ue5 unity blender substance megascans photoshop zbrush maya houdini marmoset ' +
  'quixel arnold redshift octane vray corona3d cinema4d daz procedural sculpt sculpting retopo topology ' +
  'texturing shading rigging baking lowpoly highpoly tutorial patreon instagram facebook twitter artstation ' +
  'youtube gumroad breakdown timelapse process challenge sketches doodles wip assets asset model models ' +
  'tris polys realtime workflow pipeline course lesson';
const STOPWORDS = new Set([...FILLER.split(/\s+/), ...GENERIC_ART.split(/\s+/), ...PIPELINE.split(/\s+/)].filter(Boolean));

/** Pipeline terms are poor ranking words but excellent ArtStation searches. */
const MEDIUM_TERMS = new Set(PIPELINE.split(/\s+/).slice(0, 24));

const wordsOf = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/[^a-z0-9']+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter((w) => w.length >= 4 && w.length <= 24 && !STOPWORDS.has(w) && !/^\d+$/.test(w));

/** Adjacent pairs from a title: "ancient temple" searches far better than either half. */
const phrasesOf = (title) => {
  const words = String(title || '').toLowerCase().split(/[^a-z0-9']+/).filter((w) => w.length > 2);
  const out = [];
  for (let i = 0; i < words.length - 1; i++) {
    // A medium term is allowed to anchor a phrase even though it is a
    // stopword elsewhere: "unreal engine" is a search, not a subject word.
    const ok = (w) => !STOPWORDS.has(w) || MEDIUM_TERMS.has(w);
    if (!ok(words[i]) || !ok(words[i + 1])) continue;
    out.push(`${words[i]} ${words[i + 1]}`);
  }
  return out;
};

/** ArtStation tags an unknown artist; a placeholder is not a person. */
const PLACEHOLDERS = new Set(['anon', 'anonymous', 'unknown', 'various', 'n/a', 'none']);

export function extractArtStationLikes(body) {
  let parsed;
  try {
    parsed = typeof body === 'string' ? JSON.parse(matchBlock(body)) : body;
  } catch {
    return [];
  }
  const likes = Array.isArray(parsed) ? parsed : parsed?.artstationLikes ?? parsed?.likes;
  if (!Array.isArray(likes)) return [];
  return likes.slice(0, MAX_LIKES).map((like) => ({
    hash: String(like?.hash ?? '').slice(0, 60),
    title: String(like?.title ?? '').slice(0, 200),
    artist: String(like?.artist ?? '').slice(0, 120),
    username: String(like?.username ?? '').slice(0, 80),
    tags: Array.isArray(like?.tags) ? like.tags.slice(0, 20).map((t) => String(t).slice(0, 60)) : [],
  }));
}

/** Accepts a bare JSON body or one pasted inside a fenced block. */
function matchBlock(body) {
  const fenced = String(body).match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1] : body;
}

/**
 * How much of a stream of picks a word would match.
 *
 * A word can be frequent in your likes and still rank nothing, because it is
 * frequent everywhere. "daily" earned a real weight from the likes and then
 * matched 26% of every digest, since Pixiv labels every pick "Daily ranking
 * #N". Frequency in what you like is only half the question; the other half
 * is whether the word tells two pieces apart.
 */
export function corpusShare(term, corpus) {
  if (!corpus?.length) return 0;
  const needle = String(term).toLowerCase();
  const re = needle.includes(' ')
    ? null
    : new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
  let hits = 0;
  for (const text of corpus) if (re ? re.test(text) : text.includes(needle)) hits++;
  return hits / corpus.length;
}

export function mergeArtStationLikes(taste, likes, { subjectCount = 10, corpus = [], ceiling = 0.08 } = {}) {
  const next = {
    keywords: { ...(taste.keywords || {}) },
    artists: { ...(taste.artists || {}) },
    contexts: { ...(taste.contexts || {}) },
    sources: { ...(taste.sources || {}) },
    mute: [...(taste.mute || [])],
  };

  // Deliberately uncapped while counting. Clamping to MAX_WEIGHT here threw
  // away every difference above it — across 3,000 likes dozens of words
  // reached the cap, so "forest" (51) and "ruins" (19) came out identical and
  // the scaling below had nothing left to order them by. The ceiling is
  // applied once, at the end, after the shape of the data is known.
  const bump = (table, key, by) => {
    const name = String(key || '').trim();
    if (!name) return;
    table[name] = Math.round(((Number(table[name]) || 0) + by) * 100) / 100;
  };

  const subjectCounts = new Map();
  const phraseCounts = new Map();
  const mediumCounts = new Map();
  const count = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);

  for (const like of likes) {
    const artist = like.artist || like.username;
    // Liking several pieces by one artist says far more than liking one.
    if (artist && !PLACEHOLDERS.has(artist.toLowerCase()) && !isSelf(artist, likes)) {
      bump(next.artists, artist, 1);
    }

    // ArtStation's likes endpoint carries no tags — measured against a real
    // export of 3,000 — so the vocabulary has to come from what there is.
    for (const tag of like.tags) {
      bump(next.keywords, tag.toLowerCase(), 1);
      count(subjectCounts, tag.toLowerCase());
    }
    // A title is written about the piece. A description is mostly written
    // about the pipeline, so it counts for far less and only feeds subjects.
    for (const word of wordsOf(like.title)) {
      bump(next.keywords, word, 0.5);
      count(subjectCounts, word);
    }
    for (const phrase of phrasesOf(like.title)) count(phraseCounts, phrase, 1);
    for (const word of wordsOf(like.description)) count(subjectCounts, word, 0.2);
    for (const word of String(`${like.title} ${like.description}`).toLowerCase().split(/[^a-z0-9]+/)) {
      if (MEDIUM_TERMS.has(word)) {
        count(mediumCounts, word);
        count(subjectCounts, word, 0.5);
      }
    }
  }

  /**
   * Scale a table so its heaviest term lands at `peak`, and keep the best few.
   *
   * This is the step whose absence broke the first real import. affinityFor
   * divides the total by a saturation constant of 6, so a single term at
   * weight 10 maxes the score by itself — and 3,000 likes drove dozens of
   * words to 10. The result matched 77% of the archive with 58% of it pinned
   * at the ceiling: a flat bonus on almost everything, which ranks nothing.
   *
   * Raw counts also say the wrong thing. Liking "forest" sixty times does not
   * make it sixty times the preference that liking "brutalist" twice is; it
   * mostly means forests are common. Relative order is the signal, so the
   * scale is what gets normalised and the ceiling is left well clear.
   */
  const scaleAndTrim = (table, { peak, keep }) => {
    const entries = Object.entries(table)
      .filter(([, weight]) => weight > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, keep);
    if (!entries.length) return {};
    const max = entries[0][1];
    return Object.fromEntries(
      entries.map(([name, weight]) => [name, Math.max(0.25, Math.round((weight / max) * peak * 100) / 100)])
    );
  };

  // What ArtStation should be asked for by name.
  //
  // Frequency alone is not enough, which a real export made obvious: the
  // commonest title phrases were "star wars", "blade runner", "portrait toh"
  // and "toh yasu" — two franchises and two halves of the most-liked artist's
  // name. None of them is a subject, and searching them returns a fandom or a
  // person rather than the kind of work being looked for.
  //
  // So a term has to be built of words that are themselves recurring subjects.
  // A name fails because its parts appear only alongside that one artist; a
  // franchise fails because "wars" and "runner" are not subjects on their own.
  const nameTokens = new Set();
  for (const artist of Object.keys(next.artists)) {
    for (const token of String(artist).toLowerCase().split(/[^a-z0-9]+/)) {
      if (token.length >= 3) nameTokens.add(token);
    }
  }

  // Pipeline terms are kept out of the ranking vocabulary — "unreal" matches
  // nothing on Reddit or Danbooru — but they are among the best things to
  // search ArtStation for, because they say what medium the work is. "unreal
  // engine" appeared in 53 of these titles, and real-time 3D environments are
  // exactly what that names.
  const subjectOk = (term) => !nameTokens.has(term) && (!STOPWORDS.has(term) || MEDIUM_TERMS.has(term));
  // Thresholds have to scale with the export, or they only work for the size
  // they were tuned on: twelve occurrences is a meaningful floor across three
  // thousand likes and unreachable across thirty.
  const wordFloor = Math.max(3, Math.round(likes.length * 0.004));
  const phraseFloor = Math.max(2, Math.round(likes.length * 0.0013));

  const strongWords = new Map(
    [...subjectCounts.entries()].filter(([term, n]) => n >= wordFloor && term.length >= 4 && subjectOk(term))
  );

  const topPhrases = [...phraseCounts.entries()]
    .filter(([phrase, n]) => n >= phraseFloor && phrase.split(' ').every((w) => strongWords.has(w)))
    .sort((a, b) => b[1] - a[1])
    .map(([term]) => term);
  const topWords = [...strongWords.entries()].sort((a, b) => b[1] - a[1]).map(([term]) => term);

  // A phrase is a better search than either of its halves, so once a phrase is
  // in, its words do not need their own slot.
  const spent = new Set(topPhrases.flatMap((phrase) => phrase.split(' ')));
  const subjects = [...topPhrases, ...topWords.filter((w) => !spent.has(w))].slice(0, subjectCount);

  // The tools named in descriptions say what medium the work is, which is
  // worth reporting even though it is kept out of the ranking vocabulary.
  const mediums = [...mediumCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

  return {
    profile: {
      // A keyword is worth at most a third of the saturation point, so it
      // takes three different subjects agreeing before a piece scores full
      // marks. An artist is multiplied by three inside affinityFor, so its
      // peak is a third of a keyword's to land in the same place.
      keywords: scaleAndTrim(
        // A word that matches most of the stream cannot rank any of it.
        Object.fromEntries(Object.entries(next.keywords).filter(([term]) => corpusShare(term, corpus) <= ceiling)),
        { peak: 2, keep: 80 }
      ),
      artists: scaleAndTrim(next.artists, { peak: 0.7, keep: 250 }),
      contexts: next.contexts,
      sources: next.sources,
      mute: next.mute,
    },
    subjects,
    mediums,
  };
}

/**
 * Your own work in your own likes is not a preference about other people's.
 * The commonest artist in an export can simply be its owner.
 */
function isSelf(artist, likes) {
  if (!likes.__self) {
    // The owner is whoever the export belongs to; without that we cannot tell,
    // so nothing is excluded rather than guessing at the most-liked name.
    Object.defineProperty(likes, '__self', { value: process.env.ARTSTATION_SELF || '', enumerable: false });
  }
  return Boolean(likes.__self) && artist.toLowerCase() === String(likes.__self).toLowerCase();
}

async function main() {
  const [likesPath, tastePath = new URL('../taste.json', import.meta.url).pathname] = process.argv.slice(2);
  if (!likesPath) {
    console.error('usage: node tools/merge-artstation-likes.mjs <likes.json> [taste.json]');
    process.exit(2);
  }

  const likes = extractArtStationLikes(await readFile(likesPath, 'utf8'));

  // The archive, where there is one, is the only honest measure of whether a
  // word discriminates in practice rather than in principle.
  const corpus = [];
  try {
    const dir = new URL('../data/archive/', import.meta.url).pathname;
    const { readdir } = await import('node:fs/promises');
    for (const name of (await readdir(dir)).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n))) {
      const day = JSON.parse(await readFile(dir + name, 'utf8'));
      for (const item of day.items || []) {
        corpus.push([item.title, item.artist, item.context].filter(Boolean).join(' ').toLowerCase());
      }
    }
  } catch {
    // No archive is fine: every word then passes, as it did before there was one.
  }
  if (!likes.length) {
    console.log('No usable likes found; leaving taste.json alone.');
    return;
  }

  let current = {};
  try {
    current = JSON.parse(await readFile(tastePath, 'utf8'));
  } catch {
    /* no profile yet is fine */
  }
  const { profile, subjects, mediums } = mergeArtStationLikes(current, likes, { corpus });
  if (corpus.length) console.log(`Checked each word against ${corpus.length} past picks for whether it discriminates.`);
  if (current._comment) profile._comment = current._comment;

  await writeFile(tastePath, `${JSON.stringify(profile, null, 2)}\n`);
  console.log(
    `Folded in ${likes.length} ArtStation likes: ${Object.keys(profile.artists).length} artists, ` +
      `${Object.keys(profile.keywords).length} keywords.`
  );
  if (mediums.length) {
    console.log(`\nMedium, from what the descriptions name: ${mediums.map(([m, n]) => `${m} (${n})`).join(', ')}`);
  }
  if (subjects.length) {
    console.log(`\nSubjects worth asking ArtStation for, by how often they recur in your likes:`);
    console.log(`  ART_DIGEST_SUBJECTS='${subjects.join(',')}'`);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
