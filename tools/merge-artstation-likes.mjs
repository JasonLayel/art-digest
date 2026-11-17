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

/** Words that describe nothing, so a title cannot teach them. */
const STOPWORDS = new Set(
  ('a an and the of in on at to for with by from is it this that my our your their new art artwork ' +
    'illustration digital painting drawing design concept study sketch render final wip personal project ' +
    'fan fanart commission original character scene shot test practice')
    .split(/\s+/)
    .filter(Boolean)
);

const titleWords = (title) =>
  String(title || '')
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter((w) => w.length >= 4 && w.length <= 24 && !STOPWORDS.has(w) && !/^\d+$/.test(w));

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

export function mergeArtStationLikes(taste, likes, { subjectCount = 10 } = {}) {
  const next = {
    keywords: { ...(taste.keywords || {}) },
    artists: { ...(taste.artists || {}) },
    contexts: { ...(taste.contexts || {}) },
    sources: { ...(taste.sources || {}) },
    mute: [...(taste.mute || [])],
  };

  const bump = (table, key, by) => {
    const name = String(key || '').trim();
    if (!name) return;
    table[name] = Math.round(Math.min(MAX_WEIGHT, (Number(table[name]) || 0) + by) * 100) / 100;
  };

  const tagCounts = new Map();
  for (const like of likes) {
    const artist = like.artist || like.username;
    // Liking several pieces by one artist says far more than liking one.
    if (artist && !PLACEHOLDERS.has(artist.toLowerCase())) bump(next.artists, artist, 1);
    for (const tag of like.tags) {
      const term = tag.toLowerCase();
      bump(next.keywords, term, 1);
      tagCounts.set(term, (tagCounts.get(term) || 0) + 1);
    }
    // Titles are the weakest of the three, and only count where tags are absent.
    if (!like.tags.length) for (const word of titleWords(like.title)) bump(next.keywords, word, 0.25);
  }

  const trim = (table) =>
    Object.fromEntries(
      Object.entries(table)
        .filter(([, weight]) => weight > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_TERMS)
    );

  // The tags that recur across your likes are what ArtStation should be asked
  // for by name — far better grounded than subjects guessed from a sentence.
  const subjects = [...tagCounts.entries()]
    .filter(([term, n]) => n >= 3 && term.length >= 4)
    .sort((a, b) => b[1] - a[1])
    .slice(0, subjectCount)
    .map(([term]) => term);

  return {
    profile: {
      keywords: trim(next.keywords),
      artists: trim(next.artists),
      contexts: trim(next.contexts),
      sources: next.sources,
      mute: next.mute,
    },
    subjects,
  };
}

async function main() {
  const [likesPath, tastePath = new URL('../taste.json', import.meta.url).pathname] = process.argv.slice(2);
  if (!likesPath) {
    console.error('usage: node tools/merge-artstation-likes.mjs <likes.json> [taste.json]');
    process.exit(2);
  }

  const likes = extractArtStationLikes(await readFile(likesPath, 'utf8'));
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
  const { profile, subjects } = mergeArtStationLikes(current, likes);
  if (current._comment) profile._comment = current._comment;

  await writeFile(tastePath, `${JSON.stringify(profile, null, 2)}\n`);
  console.log(
    `Folded in ${likes.length} ArtStation likes: ${Object.keys(profile.artists).length} artists, ` +
      `${Object.keys(profile.keywords).length} keywords.`
  );
  if (subjects.length) {
    console.log(`\nSubjects worth asking ArtStation for, by how often you liked them:`);
    console.log(`  ART_DIGEST_SUBJECTS='${subjects.join(',')}'`);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
