#!/usr/bin/env node
/**
 * Digital Art Digest — collector.
 *
 * Pulls the most popular *new* digital art from ArtStation, Reddit, Pixiv and
 * DeviantArt, normalizes every post into one shape, ranks them across sources
 * and writes:
 *
 *   data/latest.json          the feed the widget reads
 *   data/archive/<date>.json  one snapshot per run, kept for history
 *   data/email.html           a ready-to-send HTML digest
 *
 * Zero dependencies, Node 20+. Runs in CI (see .github/workflows/art-digest.yml)
 * because the art sites are only reachable from an unrestricted network.
 *
 * Env knobs (all optional):
 *   ART_DIGEST_LIMIT          how many items to keep       (default 24)
 *   ART_DIGEST_WINDOW_HOURS   "new" cutoff                 (default 48)
 *   ART_DIGEST_SUBS           comma-separated subreddits
 *   ART_DIGEST_OUT            output directory             (default ./data)
 *   ART_DIGEST_PIXIV_PROXY    host that re-serves i.pximg.net thumbnails
 *   REDDIT_CLIENT_ID/SECRET   use Reddit's OAuth API instead of the public JSON
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The subreddits to read, grouped for legibility only — they are fetched
 * together. Replace the whole set with ART_DIGEST_SUBS, or keep these and add
 * to them with ART_DIGEST_EXTRA_SUBS (both comma-separated). A subreddit that
 * does not exist or has gone private is dropped and named in the digest, so a
 * bad entry never costs the rest of the list.
 */
export const DEFAULT_SUBS = {
  'fine art': ['Art', 'DigitalArt', 'painting', 'ImaginaryBestOf'],
  'concept art': ['ConceptArt', 'SpecArt', 'SciFiArt', 'FantasyArt', 'ImaginaryTechnology', 'ImaginaryArchitecture'],
  // r/battlemaps is deliberately absent: it answers 429 to anonymous feed
  // requests every time, and hunting for it costs enough requests to starve
  // the groups behind it. Reddit OAuth credentials may reach it — add it back
  // with ART_DIGEST_EXTRA_SUBS if you set them.
  'tabletop & character art': ['characterdrawing', 'DnD', 'DungeonsAndDragons', 'Pathfinder_RPG', 'Warhammer40k'],
  fandom: ['FanArt', 'ImaginaryCharacters', 'ImaginaryMonsters', 'ImaginaryWesteros', 'AnimeSketch', 'awwnime'],
  worlds: ['ImaginaryLandscapes', 'ImaginaryCityscapes', 'ImaginaryMythology', 'ImaginaryWildlands'],
  // Adult art competes on the same terms as everything else: no boost, no
  // penalty, and the same one-pick-per-subreddit rotation. It reaches the
  // digest when its top post out-scores the other subreddits' top posts.
  'adult art': ['rule34', 'hentai', 'ecchi'],
};

/**
 * Subreddits whose every post is adult, whatever the feed says. Reddit's Atom
 * feed does not reliably carry the nsfw category, so a post from one of these
 * would otherwise be labelled SFW and slip past the widget's SFW filter.
 */
export const ADULT_SUBS = new Set(
  (DEFAULT_SUBS['adult art'] || []).map((sub) => sub.toLowerCase())
);

const splitList = (value) => (value || '').split(',').map((s) => s.trim()).filter(Boolean);

const CONFIG = {
  limit: int(process.env.ART_DIGEST_LIMIT, 24),
  windowHours: int(process.env.ART_DIGEST_WINDOW_HOURS, 48),
  outDir: resolve(process.env.ART_DIGEST_OUT || join(HERE, 'data')),
  subs: [
    ...new Set([
      ...(process.env.ART_DIGEST_SUBS ? splitList(process.env.ART_DIGEST_SUBS) : Object.values(DEFAULT_SUBS).flat()),
      ...splitList(process.env.ART_DIGEST_EXTRA_SUBS),
    ]),
  ],
  // Bluesky hashtags to search, comma-separated.
  tags: splitList(process.env.ART_DIGEST_TAGS) .length
    ? splitList(process.env.ART_DIGEST_TAGS)
    : ['conceptart', 'characterart', 'dnd', 'fanart', 'digitalart'],
  sources: splitList(process.env.ART_DIGEST_SOURCES),
  // How many heat points a perfect taste match is worth. Popularity still
  // leads on a wide gap; raise this to let taste win more often.
  tasteWeight: int(process.env.ART_DIGEST_TASTE_WEIGHT, 40),
  adultSubs: new Set([
    ...ADULT_SUBS,
    ...splitList(process.env.ART_DIGEST_NSFW_SUBS).map((sub) => sub.toLowerCase()),
  ]),
  // include (default) | exclude | only. Adult work is kept and flagged rather
  // than dropped; the widget and the email label it, and can filter on it.
  nsfw: (process.env.ART_DIGEST_NSFW || 'include').trim().toLowerCase(),
  // i.pximg.net refuses hotlinks, so thumbnails go through a mirror that adds
  // the Referer Pixiv wants. Set to "" to drop Pixiv thumbnails entirely.
  pixivProxy: process.env.ART_DIGEST_PIXIV_PROXY ?? 'https://i.pixiv.re',
  // Pixiv only serves its R-18 ranking to a logged-in session; paste your own
  // PHPSESSID cookie here (as a secret) to include it.
  pixivSession: process.env.PIXIV_SESSION || '',
  siteUrl: process.env.ART_DIGEST_SITE || 'https://JasonLayel.github.io/art-digest/',
};

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BOT_UA = 'art-digest/1.0 (+https://github.com/JasonLayel/art-digest)';

/* ------------------------------------------------------------------ utils */

function int(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET with a timeout and one retry on transient failures. */
async function get(url, { headers = {}, as = 'json', attempts = 3 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': BOT_UA, ...headers },
        signal: AbortSignal.timeout(25_000),
        redirect: 'follow',
      });
      if (!res.ok) {
        const error = new Error(`HTTP ${res.status} ${res.statusText}`);
        error.status = res.status;
        throw error;
      }
      return as === 'json' ? await res.json() : await res.text();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await sleep(1500 * attempt);
    }
  }
  const failure = new Error(`${new URL(url).host}: ${lastError?.message || 'request failed'}`);
  failure.status = lastError?.status;
  throw failure;
}

/** First endpoint in the list that answers wins. */
async function getFirst(urls, options) {
  const errors = [];
  for (const url of urls) {
    try {
      return await get(url, options);
    } catch (err) {
      errors.push(err.message);
    }
  }
  throw new Error(errors.join(' | '));
}

const decodeEntities = (s = '') =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ');

const clean = (s = '') => decodeEntities(String(s)).replace(/\s+/g, ' ').trim();

const https = (url) => (url ? String(url).replace(/^http:\/\//i, 'https://') : '');

const iso = (seconds) =>
  Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;

const compact = (n) =>
  n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

/**
 * A trimmed view of a raw row, recorded only when a source returns rows but
 * none survive normalizing — which means the site changed its response shape
 * and the digest needs a fix. Without it that failure is invisible.
 */
export function sampleShape(row, depth = 1) {
  if (row == null || typeof row !== 'object') return row;
  const out = {};
  for (const [key, value] of Object.entries(row).slice(0, 40)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = depth > 0 ? sampleShape(value, depth - 1) : '{…}';
    } else if (Array.isArray(value)) {
      out[key] = `[${value.length}]`;
    } else if (typeof value === 'string') {
      out[key] = value.length > 80 ? `${value.slice(0, 80)}…` : value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** First non-empty value among several candidate paths. */
const pick = (...values) => values.find((v) => typeof v === 'string' && v.trim()) || '';

/**
 * Adult work is flagged at the source rather than dropped there, so the policy
 * lives in one place: "include" (default) keeps everything, "exclude" drops the
 * flagged items, "only" keeps just those.
 */
export function applyNsfwPolicy(items, mode = 'include') {
  if (mode === 'exclude') return items.filter((item) => !item.nsfw);
  if (mode === 'only') return items.filter((item) => item.nsfw);
  return items;
}

/* ---------------------------------------------------------------- sources */

/** Reddit: top posts of the day across the art subreddits. */
export function normalizeReddit(payload, subreddit = '', { adultSubs = ADULT_SUBS } = {}) {
  const children = payload?.data?.children ?? [];
  return children
    .map((child) => child?.data)
    .filter(Boolean)
    .filter((p) => !p.stickied && !p.is_self)
    .map((p) => {
      const preview = p.preview?.images?.[0];
      const image =
        https(decodeEntities(preview?.source?.url || '')) ||
        (/\.(jpe?g|png|gif|webp)$/i.test(p.url_overridden_by_dest || '') ? https(p.url_overridden_by_dest) : '');
      const thumb =
        https(decodeEntities(preview?.resolutions?.slice(-2)[0]?.url || '')) ||
        (/^https?:/.test(p.thumbnail || '') ? https(p.thumbnail) : '') ||
        image;
      return {
        id: `reddit:${p.id}`,
        source: 'reddit',
        title: clean(p.title) || 'Untitled',
        artist: clean(p.author ? `u/${p.author}` : ''),
        artistUrl: p.author ? `https://www.reddit.com/user/${p.author}` : '',
        url: `https://www.reddit.com${p.permalink}`,
        image,
        thumb,
        tags: [p.link_flair_text].filter(Boolean).map(String),
        value: Number(p.score) || 0,
        scoreLabel: `${compact(Number(p.score) || 0)} upvotes`,
        postedAt: iso(p.created_utc),
        nsfw: Boolean(p.over_18) || adultSubs.has(String(p.subreddit || subreddit).toLowerCase()),
        context: clean(p.subreddit_name_prefixed || (subreddit && `r/${subreddit}`) || ''),
      };
    })
    .filter((item) => item.image || item.thumb);
}

/**
 * Reddit's Atom feed, used when the JSON API refuses the request — which it
 * does from datacenter IPs like GitHub's runners. The feed is ordered by top
 * of the day but carries no vote counts, so position is the only signal.
 */
export function normalizeRedditRss(xml, subreddit = '', { adultSubs = ADULT_SUBS } = {}) {
  const entries = String(xml).split(/<entry>/).slice(1).map((b) => b.split(/<\/entry>/)[0]);
  const tag = (block, name) => {
    const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
    return m ? clean(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')) : '';
  };

  return entries
    .map((block, index) => {
      const html = decodeEntities(
        (block.match(/<content[^>]*>([\s\S]*?)<\/content>/i) || [])[1] || ''
      );
      const image = (html.match(/<img[^>]+src="([^"]+)"/i) || [])[1] || '';
      const link = (block.match(/<link[^>]+href="([^"]+)"/i) || [])[1] || '';
      const author = tag(block, 'name').replace(/^\/u\//, '');
      const id = (tag(block, 'id').match(/t3_(\w+)/) || [])[1] || String(index);
      // A multireddit feed tags every entry with the subreddit it came from.
      const categories = [...block.matchAll(/<category[^>]+term="([^"]+)"/gi)].map((m) => m[1]);
      const sub =
        subreddit ||
        categories.find((term) => !/^nsfw$/i.test(term)) ||
        (link.match(/reddit\.com\/r\/([^/]+)/i) || [])[1] ||
        '';
      return {
        id: `reddit:${id}`,
        source: 'reddit',
        title: tag(block, 'title') || 'Untitled',
        artist: author ? `u/${author}` : '',
        artistUrl: author ? `https://www.reddit.com/user/${author}` : '',
        url: https(decodeEntities(link)),
        image: https(decodeEntities(image)),
        thumb: https(decodeEntities(image)),
        value: Math.max(1, entries.length - index),
        scoreLabel: `#${index + 1} top today${sub ? ` in r/${sub}` : ''}`,
        // The feed's nsfw category is the only per-post signal here and it is
        // not always present, so an adult subreddit settles it by itself.
        nsfw:
          adultSubs.has(sub.toLowerCase()) ||
          categories.some((term) => /^nsfw$/i.test(term)) ||
          /\bnsfw\b/i.test(tag(block, 'title')),
        postedAt: (() => {
          const d = new Date(tag(block, 'updated') || tag(block, 'published'));
          return Number.isNaN(d.valueOf()) ? null : d.toISOString();
        })(),
        context: sub ? `r/${sub}` : '',
      };
    })
    .filter((item) => item.url && item.image);
}

/** App-only OAuth token, when repository secrets provide credentials. */
async function redditToken() {
  if (!process.env.REDDIT_CLIENT_ID || !process.env.REDDIT_CLIENT_SECRET) return null;
  const auth = Buffer.from(
    `${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`
  ).toString('base64');
  try {
    const res = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': BOT_UA,
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return null;
    return (await res.json()).access_token || null;
  } catch {
    return null;
  }
}

/**
 * Subreddits are asked for in one multireddit request per group. A group that
 * fails is halved and each half retried, so a name that is misspelled, private
 * or banned is isolated in a handful of requests — rather than one request per
 * subreddit, which Reddit throttles hard enough to look like 14 dead subs.
 */
export const REDDIT_DEFAULTS = {
  // Reddit rate-limits by request count, so the whole list goes out in three
  // multireddit requests rather than many small ones.
  groupSize: 9,
  budget: 36,
  pause: 5000,
  backoff: 20_000,
  retries: 1,
  // A request budget bounds how many times Reddit is asked, but not how long
  // each one takes, so the search also runs against a clock.
  deadlineMs: 240_000,
};

export async function harvestSubreddits(subs, run, options = {}) {
  const { groupSize, budget, pause, backoff, retries, deadlineMs, now = () => Date.now() } = {
    ...REDDIT_DEFAULTS,
    ...options,
  };
  const startedAt = now();
  const items = [];
  const dropped = [];
  const errors = [];
  let fetched = 0;
  let requests = 0;
  let spent = false;

  // Every drop says why, so a run distinguishes a name worth deleting from the
  // list from one that merely lost a race with Reddit's rate limiter.
  const drop = (subs, reason) => dropped.push(...subs.map((sub) => `r/${sub} (${reason})`));

  const attempt = async (group) => {
    if (requests >= budget || now() - startedAt > deadlineMs) {
      spent = true;
      return { ok: false, spent: true };
    }
    requests++;
    try {
      const result = await run(group);
      items.push(...result.items);
      fetched += result.fetched;
      return { ok: true };
    } catch (err) {
      errors.push(`${group.length === 1 ? `r/${group[0]}` : `${group.length} subs`}: ${err.message}`);
      return { ok: false, status: err.status };
    }
  };

  const halve = (group, tries) => {
    const mid = Math.ceil(group.length / 2);
    return [
      { subs: group.slice(0, mid), tries },
      { subs: group.slice(mid), tries },
    ];
  };

  /**
   * Breadth-first, one pass at a time: every group is asked for once before any
   * group is asked for twice. Depth-first meant that isolating one bad name
   * early in the list could spend the whole budget, and the subreddits at the
   * end were dropped without ever being requested — which is a scheduling
   * accident, not a judgement about those subreddits.
   *
   * Within a pass, a 404 means a name in the group is gone, so halve it and
   * find the name. Anything else — 429 above all — usually means Reddit is
   * refusing traffic, where splitting would only send more of it, so the same
   * group is asked again next pass. When the retries run out it is one
   * subreddit refusing rather than all of Reddit, and halving finds that too.
   */
  let pending = [];
  for (let i = 0; i < subs.length; i += groupSize) {
    pending.push({ subs: subs.slice(i, i + groupSize), tries: 0 });
  }

  while (pending.length) {
    const next = [];
    for (const job of pending) {
      const result = await attempt(job.subs);
      if (result.ok) continue;
      if (result.spent) {
        drop(job.subs, 'budget spent');
        continue;
      }
      if (result.status === 404) {
        // The one answer that is final: either a name in here is gone, or this
        // name is.
        if (job.subs.length > 1) next.push(...halve(job.subs, 0));
        else drop(job.subs, 'not found');
      } else if (job.tries < retries) {
        next.push({ subs: job.subs, tries: job.tries + 1 });
      } else if (job.subs.length > 1) {
        // Past its retries, so this is isolation rather than throttling: the
        // halves inherit the spent retries instead of each buying another
        // round, which roughly halves the cost of finding the bad name.
        next.push(...halve(job.subs, retries));
      } else {
        drop(job.subs, `unreachable${result.status ? ` (${result.status})` : ''}`);
      }
      await sleep(pause);
    }
    pending = next;
    // Anything left is being retried or hunted down; give Reddit a breather
    // between passes rather than between every failure.
    if (pending.length) await sleep(backoff);
  }

  return { items, fetched, dropped, errors, requests, budgetSpent: spent, elapsedMs: now() - startedAt };
}

async function collectReddit(cfg) {
  const token = await redditToken();

  // Reddit turns away unauthenticated datacenter traffic, and not always the
  // same way, so try the richest route first and fall back to the Atom feed.
  const routes = [
    token && {
      name: 'oauth',
      run: (subs) =>
        get(`https://oauth.reddit.com/r/${subs.join('+')}/top.json?t=day&limit=100&raw_json=1`, {
          headers: { Authorization: `Bearer ${token}` },
        }).then((payload) => ({
          items: normalizeReddit(payload, '', { adultSubs: cfg.adultSubs }),
          fetched: payload?.data?.children?.length ?? 0,
        })),
    },
    {
      name: 'public json',
      run: (subs) =>
        get(`https://www.reddit.com/r/${subs.join('+')}/top.json?t=day&limit=100&raw_json=1`, {
          headers: { 'User-Agent': BROWSER_UA },
          attempts: 2,
        }).then((payload) => ({
          items: normalizeReddit(payload, '', { adultSubs: cfg.adultSubs }),
          fetched: payload?.data?.children?.length ?? 0,
        })),
    },
    {
      name: 'atom feed',
      run: (subs) =>
        get(`https://www.reddit.com/r/${subs.join('+')}/top.rss?t=day&limit=100`, {
          as: 'text',
          headers: { 'User-Agent': BROWSER_UA, Accept: 'application/atom+xml,text/xml' },
          attempts: 2,
        }).then((xml) => ({
          items: normalizeRedditRss(xml, '', { adultSubs: cfg.adultSubs }),
          fetched: (String(xml).match(/<entry>/g) || []).length,
        })),
    },
  ].filter(Boolean);

  // Settle on a route with the first group, then reuse it for the rest.
  let working = null;
  const run = async (subs) => {
    if (working) return working.run(subs);
    let lastError;
    for (const route of routes) {
      try {
        const result = await route.run(subs);
        working = route;
        return result;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  };

  const harvest = await harvestSubreddits(cfg.subs, run);
  if (!harvest.items.length) throw new Error(harvest.errors.slice(0, 3).join(' | ') || 'no posts returned');

  return {
    items: harvest.items,
    fetched: harvest.fetched,
    note: [
      working && working.name !== 'oauth' ? `via ${working.name}` : '',
      `${harvest.requests} requests`,
      harvest.dropped.length ? `dropped ${harvest.dropped.join(', ')}` : '',
      harvest.budgetSpent ? 'request budget spent' : '',
    ].filter(Boolean).join(' · '),
  };
}

/**
 * ArtStation asset URLs carry the render size as the second-to-last path
 * segment (.../20260910144737/smaller_square/piece.jpg), so a bigger version
 * of a cover is one substitution away.
 */
const AS_SIZES = ['micro_square', 'smaller_square', 'small_square', 'small', 'medium', 'large'];
export function artstationSize(url, size) {
  if (!url) return '';
  return url.replace(
    new RegExp(`/(${AS_SIZES.join('|')})/([^/]+)$`),
    (match, _found, file) => `/${size}/${file}`
  );
}

/**
 * ArtStation: the community "trending" explore feed.
 *
 * That feed returns square cover URLs and no like counts, while the older
 * projects feed returns a `cover` object with likes — so covers are picked
 * from whichever keys exist, and when no counts come back at all the feed's
 * own ordering becomes the score.
 */
export function normalizeArtStation(payload) {
  const rows = payload?.data ?? payload?.projects ?? (Array.isArray(payload) ? payload : []);
  const usable = rows.filter(Boolean);
  const hasLikes = usable.some((p) => Number(p.likes_count ?? p.likes ?? 0) > 0);

  return usable
    .map((p, index) => {
      const cover = p.cover || {};
      const square = pick(
        p.smaller_square_cover_url, p.small_square_cover_url, p.square_cover_url,
        cover.smaller_square_image_url, cover.square_image_url, cover.thumb_url
      );
      const wide = pick(
        p.medium_cover_url, p.cover_url, p.large_cover_url,
        cover.medium_image_url, cover.image_url, cover.large_image_url
      );
      const hash = p.hash_id || p.hashId || p.id;
      const likes = Number(p.likes_count ?? p.likes ?? 0) || 0;
      return {
        id: `artstation:${hash}`,
        source: 'artstation',
        title: clean(p.title) || 'Untitled',
        artist: clean(p.user?.full_name || p.user?.username || p.username || ''),
        artistUrl: p.user?.username ? `https://www.artstation.com/${p.user.username}` : https(pick(p.user?.permalink)),
        url: https(pick(p.permalink, p.url, hash ? `https://www.artstation.com/artwork/${hash}` : '')),
        image: https(wide || artstationSize(square, 'large') || square),
        // Only the square covers are given; the wider renders are derived from
        // the asset path and do not exist for every piece, so offer a ladder
        // and let the collector keep the first one that actually resolves.
        thumb: https(artstationSize(square, 'medium') || wide || square),
        thumbFallbacks: [
          https(artstationSize(square, 'large')),
          https(artstationSize(square, 'small')),
          https(pick(p.small_square_cover_url, cover.square_image_url)),
          https(square),
        ].filter(Boolean),
        value: hasLikes ? likes : usable.length - index,
        scoreLabel: hasLikes ? `${compact(likes)} likes` : `#${index + 1} trending`,
        nsfw: Boolean(p.adult_content || p.hide_as_adult),
        postedAt: p.published_at ? new Date(p.published_at).toISOString() : null,
        context: 'Trending',
      };
    })
    .filter((item) => item.url && (item.image || item.thumb));
}

async function collectArtStation() {
  const payload = await getFirst(
    [
      'https://www.artstation.com/api/v2/community/explore/projects/trending.json?page=1&dimension=all&per_page=50',
      'https://www.artstation.com/projects.json?page=1&sorting=trending',
    ],
    { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json', Referer: 'https://www.artstation.com/' } }
  );
  const rows = payload?.data ?? payload?.projects ?? [];
  const items = normalizeArtStation(payload);
  return { items, fetched: rows.length, sample: sampleShape(rows[0]) };
}

/** Pixiv: the public daily illustration ranking (all-ages only). */
export function normalizePixiv(payload, { pixivProxy = '', nsfwRanking = false } = {}) {
  const proxyThumb = (url) => {
    const clean = https(url);
    if (!clean) return '';
    if (!/i\.pximg\.net/.test(clean)) return clean;
    return pixivProxy ? clean.replace(/^https:\/\/i\.pximg\.net/, pixivProxy.replace(/\/$/, '')) : '';
  };

  return (payload?.contents ?? [])
    .filter((p) => p && p.illust_type !== '2') // skip ugoira (animated) entries
    .map((p) => {
      const big = String(p.url || '').replace('/c/240x480/', '/c/600x1200_90/');
      return {
        id: `pixiv:${p.illust_id}`,
        source: 'pixiv',
        title: clean(p.title) || 'Untitled',
        artist: clean(p.user_name),
        artistUrl: p.user_id ? `https://www.pixiv.net/users/${p.user_id}` : '',
        url: `https://www.pixiv.net/artworks/${p.illust_id}`,
        image: proxyThumb(big),
        thumb: proxyThumb(p.url),
        tags: (p.tags || []).filter(Boolean).map(String),
        value: Number(p.rating_count) || 0,
        scoreLabel: `${compact(Number(p.rating_count) || 0)} bookmarks · #${p.rank} today`,
        nsfw: Boolean(nsfwRanking || p.illust_content_type?.sexual || p.illust_content_type?.grotesque),
        postedAt: iso(Number(p.illust_upload_timestamp)),
        context: `Daily ranking #${p.rank}`,
      };
    });
}

async function collectPixiv(cfg) {
  const headers = { 'User-Agent': BROWSER_UA, Referer: 'https://www.pixiv.net/', Accept: 'application/json' };
  const ranking = (mode, extra = {}) =>
    get(`https://www.pixiv.net/ranking.php?mode=${mode}&content=illust&format=json&p=1`, {
      headers: { ...headers, ...extra },
    });

  const payload = await ranking('daily');
  const items = normalizePixiv(payload, cfg);
  let fetched = (payload?.contents ?? []).length;
  let note = '';

  // The R-18 ranking is only served to a logged-in session, so it needs the
  // reader's own cookie; without one Pixiv stays all-ages.
  if (cfg.nsfw !== 'exclude' && cfg.pixivSession) {
    try {
      const adult = await ranking('daily_r18', { Cookie: `PHPSESSID=${cfg.pixivSession}` });
      const adultItems = normalizePixiv(adult, { ...cfg, nsfwRanking: true });
      items.push(...adultItems);
      fetched += (adult?.contents ?? []).length;
      note = `${adultItems.length} from the R-18 ranking`;
    } catch (err) {
      note = `R-18 ranking unavailable (${err.message})`;
    }
  }

  return { items, fetched, note, sample: sampleShape(payload?.contents?.[0]) };
}

/** DeviantArt: the popular-this-week RSS feed for digital art. */
export function normalizeDeviantArt(xml) {
  const blocks = String(xml).split(/<item>/).slice(1).map((b) => b.split(/<\/item>/)[0]);
  const attr = (block, tag, name) => {
    const m = block.match(new RegExp(`<${tag}[^>]*\\b${name}="([^"]*)"`, 'i'));
    return m ? decodeEntities(m[1]) : '';
  };
  const tag = (block, name) => {
    const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
    if (!m) return '';
    return clean(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ''));
  };

  return blocks.map((block, index) => {
      const thumbs = [...block.matchAll(/<media:thumbnail[^>]*url="([^"]*)"/gi)].map((m) => decodeEntities(m[1]));
      const full = attr(block, 'media:content', 'url');
      const author = tag(block, 'media:credit') || attr(block, 'media:credit', 'url');
      const link = tag(block, 'link');
      return {
        id: `deviantart:${(link.match(/-(\d+)$/) || [])[1] || index}`,
        source: 'deviantart',
        title: tag(block, 'title') || 'Untitled',
        artist: clean(author),
        artistUrl: author ? `https://www.deviantart.com/${author.toLowerCase()}` : '',
        url: https(link),
        image: https(full || thumbs.at(-1) || ''),
        thumb: https(thumbs.at(-1) || full || ''),
        // The feed is already ordered by popularity but carries no counts, so
        // position in the feed is the only signal available.
        value: Math.max(1, blocks.length - index),
        scoreLabel: `#${index + 1} most popular`,
        nsfw: /<media:rating>\s*adult/i.test(block),
        postedAt: (() => {
          const d = new Date(tag(block, 'pubDate'));
          return Number.isNaN(d.valueOf()) ? null : d.toISOString();
        })(),
        context: 'Popular now',
      };
    })
    .filter((item) => item.url && (item.image || item.thumb));
}

/**
 * DeviantArt's official API, used when app credentials are configured. Its RSS
 * feed is behind bot protection that turns away CI runners, so credentials are
 * the only reliable route from a datacenter.
 */
export function normalizeDeviantArtApi(payload) {
  return (payload?.results ?? [])
    .filter((d) => d && !d.is_deleted)
    .map((d) => ({
      id: `deviantart:${d.deviationid}`,
      source: 'deviantart',
      title: clean(d.title) || 'Untitled',
      artist: clean(d.author?.username || ''),
      artistUrl: d.author?.username ? `https://www.deviantart.com/${d.author.username}` : '',
      url: https(d.url || ''),
      image: https(pick(d.content?.src, d.preview?.src, d.thumbs?.at(-1)?.src)),
      thumb: https(pick(d.preview?.src, d.thumbs?.at(-1)?.src, d.content?.src)),
      tags: (d.tags || []).map((t) => (typeof t === 'string' ? t : t?.tag_name)).filter(Boolean),
      value: Number(d.stats?.favourites) || 0,
      scoreLabel: `${compact(Number(d.stats?.favourites) || 0)} favourites`,
      nsfw: Boolean(d.is_mature),
      postedAt: iso(Number(d.published_time)),
      context: 'Daily Deviation',
    }))
    .filter((item) => item.url && (item.image || item.thumb));
}

async function deviantArtToken() {
  if (!process.env.DEVIANTART_CLIENT_ID || !process.env.DEVIANTART_CLIENT_SECRET) return null;
  try {
    const url =
      'https://www.deviantart.com/oauth2/token?grant_type=client_credentials' +
      `&client_id=${encodeURIComponent(process.env.DEVIANTART_CLIENT_ID)}` +
      `&client_secret=${encodeURIComponent(process.env.DEVIANTART_CLIENT_SECRET)}`;
    return (await get(url, { attempts: 2 }))?.access_token || null;
  } catch {
    return null;
  }
}

async function collectDeviantArt(cfg = {}) {
  const token = await deviantArtToken();
  if (token) {
    const mature = cfg.nsfw === 'exclude' ? 'false' : 'true';
    const payload = await get(
      `https://www.deviantart.com/api/v1/oauth2/browse/dailydeviations?mature_content=${mature}&access_token=${token}`,
      { headers: { 'User-Agent': BROWSER_UA } }
    );
    const items = normalizeDeviantArtApi(payload);
    return {
      items,
      fetched: (payload?.results ?? []).length,
      note: 'via the API',
      sample: sampleShape(payload?.results?.[0]),
    };
  }

  const query = encodeURIComponent('boost:popular max_age:24h in:digitalart');
  const xml = await getFirst(
    [
      `https://backend.deviantart.com/rss.xml?type=deviation&q=${query}&limit=60`,
      `https://www.deviantart.com/rss.xml?type=deviation&q=${query}&limit=60`,
      // Without the age filter the feed is served from a different cache and
      // sometimes answers when the filtered one does not.
      `https://backend.deviantart.com/rss.xml?type=deviation&q=${encodeURIComponent('boost:popular in:digitalart')}&limit=60`,
    ],
    { as: 'text', headers: { 'User-Agent': BROWSER_UA, Accept: 'application/rss+xml,text/xml' } }
  );
  const items = normalizeDeviantArt(xml);
  return {
    items,
    fetched: (String(xml).match(/<item>/g) || []).length,
    note: 'via RSS',
    sample: items.length ? undefined : String(xml).slice(0, 400),
  };
}

/**
 * Bluesky: the art hashtags, ranked by likes. The public AppView needs no
 * credentials, which is why it is the one "everywhere else" outlet here that
 * works out of the box.
 */
export function normalizeBluesky(payload, tag = '') {
  return (payload?.posts ?? [])
    .map((post) => {
      const embed = post.embed?.images ? post.embed : post.embed?.media;
      const image = embed?.images?.[0];
      const handle = post.author?.handle || '';
      const rkey = String(post.uri || '').split('/').pop();
      const text = clean(post.record?.text || '');
      const labels = [
        ...(post.labels || []).map((l) => l.val),
        ...(image?.labels || []).map((l) => l.val),
      ];
      return {
        id: `bluesky:${rkey}`,
        source: 'bluesky',
        title: text.split(/[.!?\n]/)[0].slice(0, 120) || 'Untitled',
        artist: clean(post.author?.displayName || (handle ? `@${handle}` : '')),
        artistUrl: handle ? `https://bsky.app/profile/${handle}` : '',
        url: handle && rkey ? `https://bsky.app/profile/${handle}/post/${rkey}` : '',
        image: https(image?.fullsize || ''),
        thumb: https(image?.thumb || image?.fullsize || ''),
        thumbFallbacks: [https(image?.fullsize || '')].filter(Boolean),
        tags: [...text.matchAll(/#([a-z0-9_]{2,30})/gi)].map((m) => m[1]),
        value: Number(post.likeCount) || 0,
        scoreLabel: `${compact(Number(post.likeCount) || 0)} likes`,
        postedAt: post.record?.createdAt || post.indexedAt || null,
        nsfw: labels.some((val) => /porn|sexual|nudity|graphic-media/i.test(val)),
        context: tag ? `#${tag}` : 'Bluesky',
      };
    })
    .filter((item) => item.url && item.thumb);
}

async function blueskyToken() {
  const identifier = process.env.BLUESKY_IDENTIFIER;
  const password = process.env.BLUESKY_APP_PASSWORD;
  if (!identifier || !password) return null;
  try {
    const res = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': BOT_UA },
      body: JSON.stringify({ identifier, password }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return null;
    return (await res.json()).accessJwt || null;
  } catch {
    return null;
  }
}

async function collectBluesky(cfg) {
  const token = await blueskyToken();
  const search = (host, headers) => (tag) =>
    get(
      `${host}/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(`#${tag}`)}&sort=top&limit=25`,
      { headers: { Accept: 'application/json', ...headers }, attempts: 2 }
    );

  // The public AppView answers 403 to some datacenter traffic, so fall back to
  // a browser agent and then to an authenticated session when one is configured.
  const routes = [
    { name: 'public', run: search('https://public.api.bsky.app', {}) },
    { name: 'public (browser agent)', run: search('https://public.api.bsky.app', { 'User-Agent': BROWSER_UA }) },
    token && {
      name: 'signed in',
      run: search('https://bsky.social', { Authorization: `Bearer ${token}` }),
    },
  ].filter(Boolean);

  const items = [];
  const failed = [];
  let fetched = 0;
  let working = null;

  for (const tag of cfg.tags) {
    for (const route of working ? [working] : routes) {
      try {
        const payload = await route.run(tag);
        fetched += (payload?.posts ?? []).length;
        items.push(...normalizeBluesky(payload, tag));
        working = route;
        break;
      } catch (err) {
        if (route === routes.at(-1)) failed.push(`#${tag} (${err.message})`);
      }
    }
    await sleep(400);
  }

  if (!items.length) throw new Error(failed.join('; ') || 'no posts returned');
  return {
    items,
    fetched,
    note: [
      working && working.name !== 'public' ? `via ${working.name}` : '',
      failed.length ? `skipped ${failed.length} tag(s)` : '',
    ].filter(Boolean).join(' · '),
  };
}

/**
 * Danbooru: the day's highest-scoring fan art. Anonymous searches allow two
 * tags, which `order:score age:1d` uses up, so ratings are filtered here
 * instead of in the query.
 */
const DANBOORU_RATINGS = { g: 'general', s: 'sensitive', q: 'questionable', e: 'explicit' };

export function normalizeDanbooru(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((p) => p && !p.is_banned && !p.is_deleted)
    .map((p) => {
      const artist = (p.tag_string_artist || '').split(/\s+/).filter(Boolean)[0] || '';
      const fandom = (p.tag_string_copyright || '').split(/\s+/).filter(Boolean)[0] || '';
      const character = (p.tag_string_character || '').split(/\s+/).filter(Boolean)[0] || '';
      const pretty = (tag) => tag.replace(/_\(.*\)$/, '').replace(/_/g, ' ').trim();
      return {
        id: `danbooru:${p.id}`,
        source: 'danbooru',
        title: [character && pretty(character), fandom && `(${pretty(fandom)})`].filter(Boolean).join(' ') || 'Untitled',
        artist: artist ? pretty(artist) : '',
        // Prefer the artist's own posting when the uploader recorded it.
        artistUrl: /^https?:\/\//.test(p.source || '')
          ? https(p.source)
          : artist
            ? `https://danbooru.donmai.us/posts?tags=${encodeURIComponent(artist)}`
            : '',
        url: `https://danbooru.donmai.us/posts/${p.id}`,
        image: https(pick(p.large_file_url, p.file_url, p.preview_file_url)),
        thumb: https(pick(p.large_file_url, p.preview_file_url, p.file_url)),
        thumbFallbacks: [https(pick(p.preview_file_url)), https(pick(p.file_url))].filter(Boolean),
        tags: [
          ...(p.tag_string_character || '').split(/\s+/),
          ...(p.tag_string_copyright || '').split(/\s+/),
          ...(p.tag_string_general || '').split(/\s+/).slice(0, 20),
        ]
          .filter(Boolean)
          .map((t) => t.replace(/_/g, ' ')),
        value: Number(p.score) || 0,
        scoreLabel: `score ${compact(Number(p.score) || 0)} · ${compact(Number(p.fav_count) || 0)} favourites`,
        postedAt: p.created_at ? new Date(p.created_at).toISOString() : null,
        nsfw: p.rating === 'q' || p.rating === 'e',
        context: fandom ? pretty(fandom) : DANBOORU_RATINGS[p.rating] || 'Top today',
      };
    })
    .filter((item) => item.thumb);
}

async function collectDanbooru(cfg) {
  const rows = await get(
    'https://danbooru.donmai.us/posts.json?tags=order%3Ascore+age%3A1d&limit=50',
    { headers: { 'User-Agent': BOT_UA, Accept: 'application/json' } }
  );
  const items = normalizeDanbooru(rows);
  return {
    items,
    fetched: Array.isArray(rows) ? rows.length : 0,
    note: cfg.nsfw === 'exclude' ? 'general and sensitive ratings only' : '',
    sample: sampleShape(Array.isArray(rows) ? rows[0] : null),
  };
}

/**
 * ArtStation, asked for the subjects you actually care about.
 *
 * Its trending feed is whatever the whole site is looking at, and its channel
 * and medium filters are decoration — every one of them returns trending
 * verbatim. Search is the only parameter it honours, so that is what this
 * uses. The queries come from the taste profile, which means the profile
 * shapes what gets collected and not only how it is ranked.
 */
export function searchQueriesFrom(taste, limit = 4) {
  const weighted = Object.entries(taste?.keywords || {})
    .map(([term, weight]) => [term, Number(weight) || 0])
    // A phrase makes a far better search than a single word.
    .sort((a, b) => b[1] + (b[0].includes(' ') ? 1.5 : 0) - (a[1] + (a[0].includes(' ') ? 1.5 : 0)));
  return weighted.slice(0, limit).map(([term]) => term);
}

export async function collectArtStationSearch(cfg, { search = null } = {}) {
  const fetchQuery =
    search ||
    ((query) =>
      get(
        `https://www.artstation.com/api/v2/search/projects.json?query=${encodeURIComponent(query)}&page=1&per_page=50`,
        { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json', Referer: 'https://www.artstation.com/' } }
      ));
  const queries = cfg.artstationQueries || [];
  if (!queries.length) return { items: [], fetched: 0, note: 'no queries configured' };

  const items = [];
  const failed = [];
  let fetched = 0;
  let undated = 0;
  let sample;

  for (const query of queries) {
    try {
      const payload = await fetchQuery(query);
      const rows = payload?.data ?? payload?.results ?? [];
      fetched += rows.length;
      sample = sample ?? sampleShape(rows[0]);
      // The search payload is the explore payload, so the same normalizer
      // reads it; the query becomes the context, which spreads the digest's
      // picks across subjects the way subreddits spread Reddit's.
      for (const [index, item] of normalizeArtStation({ data: rows }).entries()) {
        // Search returns the whole archive ordered by relevance, not by date,
        // so an undated row here could be eleven years old — and the freshness
        // filter lets undated items through on the assumption that a feed is
        // inherently current, which is true of trending and false of this.
        // Anything that cannot prove its age does not belong in a digest of
        // new work.
        if (!item.postedAt) {
          undated++;
          continue;
        }
        const likes = Number(item.value) || 0;
        items.push({
          ...item,
          source: 'artsearch',
          id: item.id.replace('artstation:', 'artsearch:'),
          context: query,
          // And relevance rank is not popularity: say which it is.
          scoreLabel: likes && !/trending/.test(item.scoreLabel) ? item.scoreLabel : `#${index + 1} for "${query}"`,
        });
      }
    } catch (err) {
      failed.push(`${query} (${err.message})`);
    }
    if (!search) await sleep(800);
  }

  if (!items.length && failed.length) throw new Error(failed.join('; '));
  return {
    items,
    fetched,
    note: [
      `${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}: ${queries.join(', ')}`,
      undated ? `${undated} undated results dropped as unprovable age` : '',
      failed.length ? `skipped ${failed.length}` : '',
    ]
      .filter(Boolean)
      .join(' · '),
    sample,
  };
}

export const SOURCES = [
  { id: 'artstation', label: 'ArtStation', home: 'https://www.artstation.com', collect: collectArtStation },
  { id: 'reddit', label: 'Reddit', home: 'https://www.reddit.com', collect: collectReddit },
  { id: 'pixiv', label: 'Pixiv', home: 'https://www.pixiv.net', collect: collectPixiv },
  { id: 'deviantart', label: 'DeviantArt', home: 'https://www.deviantart.com', collect: collectDeviantArt },
  { id: 'bluesky', label: 'Bluesky', home: 'https://bsky.app', collect: collectBluesky },
  { id: 'danbooru', label: 'Danbooru', home: 'https://danbooru.donmai.us', collect: collectDanbooru },
  { id: 'artsearch', label: 'Your subjects', home: 'https://www.artstation.com', collect: collectArtStationSearch },
];

/* ---------------------------------------------------------------- ranking */

/**
 * Scores are not comparable across sources (Reddit upvotes vs ArtStation
 * likes vs Pixiv bookmarks), so each source is normalized against its own top
 * post, nudged by how fresh the piece is, and then the sources are interleaved
 * so one busy site can't take over the whole digest.
 */
export function rankItems(
  bySource,
  { limit = 24, windowHours = 48, now = Date.now(), taste = null, tasteWeight = 40 } = {}
) {
  const cutoff = now - windowHours * 3600 * 1000;

  const ranked = new Map();
  for (const [source, items] of Object.entries(bySource)) {
    const fresh = items.filter((item) => {
      if (!item.postedAt) return true; // no timestamp: trust the source's own ordering
      const t = Date.parse(item.postedAt);
      return !Number.isFinite(t) || t >= cutoff;
    });
    const max = Math.max(1, ...fresh.map((i) => i.value || 0));
    const scored = fresh
      .map((item) => {
        const popularity = Math.min(1, (item.value || 0) / max);
        const ageHours = item.postedAt ? Math.max(0, (now - Date.parse(item.postedAt)) / 3.6e6) : windowHours / 2;
        const freshness = Math.max(0, 1 - ageHours / (windowHours * 1.5));
        const heat = Math.round((popularity * 0.8 + freshness * 0.2) * 100);
        if (!taste) return { ...item, heat };
        // Taste changes which piece represents a source, not how many slots
        // that source gets: the round-robin below is untouched, so a profile
        // sharpens the selection without narrowing the range.
        const { score, muted, matched } = affinityFor(item, taste);
        return { ...item, heat, affinity: Number(score.toFixed(3)), matched, muted };
      })
      .filter((item) => !item.muted)
      .map(({ muted, ...item }) => item)
      .sort(
        (a, b) =>
          b.heat + (b.affinity || 0) * tasteWeight - (a.heat + (a.affinity || 0) * tasteWeight) ||
          b.value - a.value
      );
    ranked.set(source, dedupe(scored));
  }

  // Round-robin across sources, best first — and within a source, take a
  // different subreddit or hashtag each round before repeating one, so a
  // single busy corner (r/Art, say) can't fill Reddit's whole share.
  const out = [];
  const lead = (source) => {
    const top = ranked.get(source)[0];
    return top ? top.heat + (top.affinity || 0) * tasteWeight : 0;
  };
  const order = [...ranked.keys()].sort((a, b) => lead(b) - lead(a));
  const taken = new Map(order.map((source) => [source, new Set()]));
  const used = new Set();

  const nextFrom = (source, round) => {
    const list = ranked.get(source);
    const seen = taken.get(source);
    const unseen = list.find((item) => !used.has(item.id) && !seen.has(item.context || ''));
    if (unseen) return unseen;
    // Every corner has had a turn this pass: start the next one.
    if (seen.size) {
      seen.clear();
      return list.find((item) => !used.has(item.id));
    }
    return list[round];
  };

  for (let round = 0; out.length < limit; round++) {
    let added = 0;
    for (const source of order) {
      const item = nextFrom(source, round);
      if (!item || used.has(item.id)) continue;
      used.add(item.id);
      taken.get(source).add(item.context || '');
      out.push(item);
      added++;
      if (out.length >= limit) break;
    }
    if (!added) break;
  }
  return out;
}

/* ------------------------------------------------------------------ taste */

/**
 * Words too common to say anything about what a piece is. These guard
 * vocabulary *derived* from what you liked; a keyword you write in taste.json
 * yourself is always matchable, because you meant it.
 */
const STOPWORDS = new Set(
  ('a an and are as at be by for from has in is it its of on or that the to with my me you your this ' +
   'oc art artwork digital drawing painting illustration new first finally wip commission me irl 2024 2025 2026')
    .split(' ')
);

/** Everything about a piece that a taste profile could plausibly match on. */
export function itemText(item) {
  return [item.title, item.artist, item.context, ...(item.tags || [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function itemWords(item) {
  return new Set(
    itemText(item)
      .split(/[^a-z0-9+#]+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  );
}

export const EMPTY_TASTE = { keywords: {}, artists: {}, contexts: {}, mute: [] };

/**
 * How well a piece matches the profile, as 0–1 plus the reasons why.
 *
 * Matching an artist you have named counts for much more than matching a
 * word, because naming an artist is a deliberate act and a word can turn up by
 * accident. A muted term rejects the piece outright rather than scoring it
 * down: mutes are things you said you did not want to see.
 */
export function affinityFor(item, taste = EMPTY_TASTE, { saturation = 6 } = {}) {
  const text = itemText(item);
  const matched = [];
  let total = 0;

  for (const term of taste.mute || []) {
    if (term && text.includes(String(term).toLowerCase())) {
      return { score: 0, muted: true, matched: [`muted: ${term}`] };
    }
  }

  const artist = String(item.artist || '').toLowerCase().replace(/^u\//, '');
  for (const [name, weight] of Object.entries(taste.artists || {})) {
    const known = name.toLowerCase();
    if (known && (artist === known || artist.includes(known))) {
      total += (Number(weight) || 1) * 3;
      matched.push(name);
    }
  }

  for (const [context, weight] of Object.entries(taste.contexts || {})) {
    if (context && String(item.context || '').toLowerCase() === context.toLowerCase()) {
      total += (Number(weight) || 1) * 1.5;
      matched.push(context);
    }
  }

  for (const [keyword, weight] of Object.entries(taste.keywords || {})) {
    const term = String(keyword).toLowerCase();
    if (!term) continue;
    // A phrase has to appear as one; a single word has to be a whole word, so
    // "art" matches "fan art" but not "artstation".
    const hit = term.includes(' ')
      ? text.includes(term)
      : new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(text);
    if (hit) {
      total += Number(weight) || 1;
      matched.push(keyword);
    }
  }

  return { score: Math.min(1, total / saturation), muted: false, matched };
}

/** Reads taste.json if it is there; an absent or broken profile is simply no profile. */
export async function loadTaste(dir) {
  try {
    const raw = await readFile(join(dir, 'taste.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      keywords: parsed.keywords || {},
      artists: parsed.artists || {},
      contexts: parsed.contexts || {},
      mute: Array.isArray(parsed.mute) ? parsed.mute : [],
    };
  } catch {
    return { ...EMPTY_TASTE };
  }
}

/* -------------------------------------------------------------- thumbnails */

/**
 * Does this image actually load? HEAD first, and a one-byte GET whenever that
 * is refused for any reason — some CDNs answer 403 to HEAD rather than the 405
 * the spec suggests, which silently cost every Danbooru thumbnail. The referer
 * is the page the image belongs to, which is what a browser showing it would
 * send and what hotlink checks expect.
 */
async function urlResolves(url, { referer = '' } = {}) {
  const headers = { 'User-Agent': BROWSER_UA, ...(referer ? { Referer: referer } : {}) };
  const ok = (res) => res.ok || res.status === 206;
  try {
    const head = await fetch(url, { method: 'HEAD', headers, signal: AbortSignal.timeout(12_000) });
    if (ok(head)) return true;
    const ranged = await fetch(url, {
      headers: { ...headers, Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(12_000),
    });
    return ok(ranged);
  } catch {
    return false;
  }
}

/**
 * Some thumbnails are derived rather than given: ArtStation's are upsized from
 * a square cover, Pixiv's go through a mirror. The email can't retry a broken
 * image the way the widget can, so each candidate is checked here and the
 * first one that loads wins.
 *
 * A candidate that fails is not thrown away, though. This check runs from a
 * datacenter, while the reader loads the image from their own connection or
 * through Gmail's proxy, and a CDN that refuses the former will happily serve
 * the latter — which is exactly what silently cost every Danbooru thumbnail.
 * So when nothing verifies, the best candidate still ships, marked unverified.
 */
export async function resolveThumbnails(items, { check = urlResolves, concurrency = 8 } = {}) {
  const queue = [...items];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const ladder = [item.thumb, ...(item.thumbFallbacks || [])].filter(
        (url, i, all) => url && all.indexOf(url) === i
      );
      let referer = '';
      try {
        referer = item.url ? `${new URL(item.url).origin}/` : '';
      } catch {
        referer = '';
      }
      let resolved = '';
      for (const candidate of ladder) {
        if (await check(candidate, { referer })) {
          resolved = candidate;
          break;
        }
      }
      if (resolved) {
        if (resolved === item.thumb) continue;
        item.thumb = resolved;
        // The big version is derived from the same guess as the thumbnail, so
        // when the guess was wrong fall back to what did resolve.
        item.image = resolved;
        continue;
      }
      // Nothing answered us. Keep the first candidate rather than shipping a
      // blank card: the reader's connection may well be served where ours was
      // refused, and the widget still walks the fallbacks if it isn't.
      item.thumb = ladder[0] || '';
      item.image = item.image || item.thumb;
      if (item.thumb) item.thumbVerified = false;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return items;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.source}|${item.title.toLowerCase()}|${item.artist.toLowerCase()}`;
    if (seen.has(key) || seen.has(item.id)) return false;
    seen.add(key);
    seen.add(item.id);
    return true;
  });
}

/* ------------------------------------------------------------------ email */

const esc = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SOURCE_COLORS = {
  artstation: '#13aff0',
  reddit: '#ff4500',
  pixiv: '#0096fa',
  deviantart: '#00b377',
  bluesky: '#7c5cf0',
  danbooru: '#c8860a',
};

/** Table-based HTML so it survives email clients. */
export function renderEmail(digest, { siteUrl = CONFIG.siteUrl, imageSrc = null } = {}) {
  const date = new Date(digest.generatedAt).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });

  const cards = digest.items
    .map((item, index) => {
      const color = SOURCE_COLORS[item.source] || '#8b5cf6';
      // The sender can swap in a cid: reference for an image it attached, so
      // the message carries its own pictures instead of asking the reader's
      // mail client to fetch them.
      const thumb = (imageSrc && imageSrc(item)) || item.thumb || item.image;
      return `
      <tr>
        <td style="padding:0 0 18px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e6e1ea;border-radius:12px;overflow:hidden;background:#ffffff;">
            <tr>
              <td width="120" valign="top" style="padding:0;">
                ${thumb
                  ? `<a href="${esc(item.url)}"><img src="${esc(thumb)}" width="120" alt="" style="display:block;width:120px;height:120px;object-fit:cover;border:0;"></a>`
                  : `<div style="width:120px;height:120px;background:${color};"></div>`}
              </td>
              <td valign="top" style="padding:12px 16px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;">
                <div style="font-size:11px;color:${color};font-weight:700;letter-spacing:.04em;text-transform:uppercase;">
                  ${index + 1}. ${esc(digest.sourceLabels[item.source] || item.source)}${item.context ? ` · ${esc(item.context)}` : ''}${item.nsfw ? ' <span style="color:#d6336c;">· 18+</span>' : ''}
                </div>
                <div style="margin:4px 0 2px;font-size:16px;line-height:1.3;font-weight:600;">
                  <a href="${esc(item.url)}" style="color:#1c1420;text-decoration:none;">${esc(item.title)}</a>
                </div>
                <div style="font-size:13px;color:#6b6270;">${esc(item.artist)}</div>
                <div style="margin-top:6px;font-size:12px;color:#8a8194;">🔥 ${item.heat} · ${esc(item.scoreLabel)}</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>`;
    })
    .join('');

  const sourceLine = digest.sources
    .map((s) => `${s.status === 'ok' ? '✓' : '✕'} ${esc(s.label)}${s.status === 'ok' ? ` (${s.kept})` : ''}`)
    .join(' &nbsp;·&nbsp; ');

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f7f4f9;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f4f9;padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
      <tr><td style="padding-bottom:18px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;">
        <div style="font-size:22px;font-weight:700;color:#1c1420;">🎨 Today's best new digital art</div>
        <div style="font-size:13px;color:#6b6270;margin-top:4px;">${esc(date)} · top ${digest.items.length} of ${digest.totalCollected} new pieces${digest.nsfwCount ? ` · ${digest.nsfwCount} marked 18+` : ''}</div>
      </td></tr>
      ${cards}
      <tr><td style="padding-top:6px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:12px;color:#8a8194;">
        <div>Sources: ${sourceLine}</div>
        <div style="margin-top:8px;"><a href="${esc(siteUrl)}" style="color:#e8489b;">Open the full widget →</a></div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

/* -------------------------------------------------------------------- feed */

const rfc822 = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.valueOf()) ? new Date().toUTCString() : d.toUTCString();
};

/**
 * One RSS item per artwork, so a reader tracks what has been seen piece by
 * piece rather than day by day. Readers fetch images themselves, from the
 * reader's own connection, which is why the feed can link them rather than
 * having to carry them the way the email does.
 */
export function renderFeed(digest, { siteUrl = CONFIG.siteUrl, feedUrl = `${CONFIG.siteUrl}data/feed.xml` } = {}) {
  const items = digest.items
    .map((item) => {
      const label = digest.sourceLabels?.[item.source] || item.source;
      const thumb = item.thumb || item.image;
      const body = [
        thumb ? `<p><a href="${esc(item.url)}"><img src="${esc(thumb)}" alt="" style="max-width:100%"></a></p>` : '',
        `<p>${esc(item.artist || 'Unknown artist')} · ${esc(label)}${item.context ? ` · ${esc(item.context)}` : ''}</p>`,
        `<p>🔥 ${item.heat} · ${esc(item.scoreLabel)}${item.nsfw ? ' · <strong>18+</strong>' : ''}</p>`,
      ].join('');
      return `    <item>
      <title>${esc(item.nsfw ? '[18+] ' : '')}${esc(item.title)}${item.artist ? ` — ${esc(item.artist)}` : ''}</title>
      <link>${esc(item.url)}</link>
      <guid isPermaLink="false">${esc(item.id)}</guid>
      <pubDate>${rfc822(item.postedAt || digest.generatedAt)}</pubDate>
      <category>${esc(label)}</category>
      <description><![CDATA[${body}]]></description>${
        thumb ? `\n      <media:content url="${esc(thumb)}" medium="image"/>` : ''
      }
    </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Daily Digital Art Digest</title>
    <link>${esc(siteUrl)}</link>
    <atom:link href="${esc(feedUrl)}" rel="self" type="application/rss+xml"/>
    <description>The most popular new digital art from ArtStation, Reddit, Pixiv, DeviantArt, Bluesky and Danbooru, collected daily and ranked together.</description>
    <language>en</language>
    <lastBuildDate>${rfc822(digest.generatedAt)}</lastBuildDate>
    <ttl>720</ttl>
${items}
  </channel>
</rss>
`;
}

/* ------------------------------------------------------------------- main */

export async function buildDigest(cfg = CONFIG) {
  const bySource = {};
  const report = [];
  // The profile is needed before collecting, because it decides what to search
  // ArtStation for as well as how to rank what comes back.
  const profile = await loadTaste(HERE);
  cfg.artstationQueries = splitList(process.env.ART_DIGEST_QUERIES).length
    ? splitList(process.env.ART_DIGEST_QUERIES)
    : searchQueriesFrom(profile);
  const sources = cfg.sources?.length
    ? SOURCES.filter((s) => cfg.sources.includes(s.id))
    : SOURCES;

  const results = await Promise.allSettled(sources.map((s) => s.collect(cfg)));

  sources.forEach((source, i) => {
    const result = results[i];
    if (result.status === 'fulfilled') {
      const { items: collected, fetched, note, sample } = result.value;
      const items = applyNsfwPolicy(collected, cfg.nsfw);
      bySource[source.id] = items;
      report.push({
        id: source.id,
        label: source.label,
        home: source.home,
        // Rows that all fail to normalize mean the site changed its response
        // shape: report that as a failure rather than an empty success.
        status: items.length || !fetched ? 'ok' : 'changed',
        fetched,
        kept: items.length,
        note: [note, collected.length - items.length ? `${collected.length - items.length} filtered by the ${cfg.nsfw} policy` : '']
          .filter(Boolean)
          .join(' · '),
        nsfw: items.filter((item) => item.nsfw).length,
        error: items.length || !fetched ? null : `returned ${fetched} rows, none usable — the response shape changed`,
        ...(items.length || !fetched ? {} : { sample: sample ?? null }),
      });
    } else {
      bySource[source.id] = [];
      report.push({
        id: source.id,
        label: source.label,
        home: source.home,
        status: 'failed',
        fetched: 0,
        kept: 0,
        note: '',
        error: String(result.reason?.message || result.reason).slice(0, 300),
      });
    }
  });

  const taste = profile;
  const tasteTerms =
    Object.keys(taste.keywords).length + Object.keys(taste.artists).length + Object.keys(taste.contexts).length;
  const items = await resolveThumbnails(
    rankItems(bySource, {
      limit: cfg.limit,
      windowHours: cfg.windowHours,
      taste: tasteTerms ? taste : null,
      tasteWeight: cfg.tasteWeight,
    })
  );
  const unverified = items.filter((item) => item.thumbVerified === false).length;
  const missing = items.filter((item) => !item.thumb).length;
  if (unverified) console.log(`${unverified} of ${items.length} thumbnails would not verify from CI and ship unchecked`);
  if (missing) console.log(`${missing} of ${items.length} items have no thumbnail at all`);

  return {
    generatedAt: new Date().toISOString(),
    windowHours: cfg.windowHours,
    totalCollected: Object.values(bySource).reduce((n, list) => n + list.length, 0),
    nsfwPolicy: cfg.nsfw,
    nsfwCount: items.filter((item) => item.nsfw).length,
    taste: {
      terms: tasteTerms,
      muted: taste.mute.length,
      matchedPicks: items.filter((item) => (item.matched || []).length).length,
    },
    sourceLabels: Object.fromEntries(sources.map((s) => [s.id, s.label])),
    sources: report,
    items,
  };
}

async function main() {
  const digest = await buildDigest(CONFIG);

  await mkdir(join(CONFIG.outDir, 'archive'), { recursive: true });
  const json = `${JSON.stringify(digest, null, 2)}\n`;
  const day = digest.generatedAt.slice(0, 10);
  await writeFile(join(CONFIG.outDir, 'latest.json'), json);
  await writeFile(join(CONFIG.outDir, 'archive', `${day}.json`), json);
  await writeFile(join(CONFIG.outDir, 'email.html'), `${renderEmail(digest)}\n`);
  await writeFile(join(CONFIG.outDir, 'feed.xml'), renderFeed(digest));

  for (const s of digest.sources) {
    const detail = s.status === 'ok' ? `${s.kept} kept of ${s.fetched}${s.note ? ` — ${s.note}` : ''}` : s.error;
    console.log(`${s.status === 'ok' ? '✓' : '✕'} ${s.label.padEnd(12)} ${detail}`);
    if (s.sample) console.log(`  sample row: ${JSON.stringify(s.sample).slice(0, 1200)}`);
  }
  console.log(`\n${digest.items.length} items written to ${CONFIG.outDir}`);

  const working = digest.sources.filter((s) => s.status === 'ok').length;
  if (!working || !digest.items.length) {
    console.error('No source returned usable items.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
