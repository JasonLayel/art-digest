#!/usr/bin/env node
/**
 * Folds pieces you hearted in the gallery into taste.json.
 *
 *   node tools/merge-taste.mjs <issue-body-file> [taste.json]
 *
 * The gallery cannot POST anywhere, so it hands you a prefilled issue and this
 * reads the JSON block out of it. The body is untrusted input — anyone can open
 * an issue on a public repo — so the workflow checks who wrote it and this
 * takes only the fields it understands, with every weight bounded.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { itemWords } from '../collect.mjs';

const MAX_WEIGHT = 10;
const MAX_LIKES = 200;
const MAX_TERMS = 400;

/** The first fenced JSON block, or nothing. */
export function extractLikes(body) {
  const block = String(body || '').match(/```json\s*([\s\S]*?)```/i);
  if (!block) return [];
  let parsed;
  try {
    parsed = JSON.parse(block[1]);
  } catch {
    return [];
  }
  const likes = Array.isArray(parsed) ? parsed : parsed?.likes;
  if (!Array.isArray(likes)) return [];
  return likes.slice(0, MAX_LIKES).map((like) => ({
    id: String(like?.id ?? '').slice(0, 200),
    artist: String(like?.artist ?? '').slice(0, 120),
    context: String(like?.context ?? '').slice(0, 120),
    title: String(like?.title ?? '').slice(0, 300),
    tags: Array.isArray(like?.tags) ? like.tags.slice(0, 12).map((t) => String(t).slice(0, 60)) : [],
  }));
}

const bump = (table, key, by = 1) => {
  const name = String(key || '').trim();
  if (!name) return;
  table[name] = Math.min(MAX_WEIGHT, (Number(table[name]) || 0) + by);
};

/** Adds what the likes say to a profile, without disturbing what is already there. */
export function mergeLikes(taste, likes) {
  const next = {
    keywords: { ...(taste.keywords || {}) },
    artists: { ...(taste.artists || {}) },
    contexts: { ...(taste.contexts || {}) },
    mute: [...(taste.mute || [])],
  };

  for (const like of likes) {
    if (like.artist) bump(next.artists, like.artist.replace(/^u\//, ''), 1);
    if (like.context) bump(next.contexts, like.context, 1);
    // Tags are deliberate vocabulary; words from a title are a weaker guess.
    for (const tag of like.tags) bump(next.keywords, String(tag).toLowerCase(), 1);
    for (const word of itemWords({ title: like.title })) bump(next.keywords, word, 0.5);
  }

  // Keep the profile from growing without bound: the heaviest terms survive.
  const trim = (table) =>
    Object.fromEntries(
      Object.entries(table)
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_TERMS)
        .map(([k, v]) => [k, Math.round(v * 100) / 100])
    );

  return { keywords: trim(next.keywords), artists: trim(next.artists), contexts: trim(next.contexts), mute: next.mute };
}

async function main() {
  const [bodyPath, tastePath = new URL('../taste.json', import.meta.url).pathname] = process.argv.slice(2);
  if (!bodyPath) {
    console.error('usage: node tools/merge-taste.mjs <issue-body-file> [taste.json]');
    process.exit(2);
  }

  const likes = extractLikes(await readFile(bodyPath, 'utf8'));
  if (!likes.length) {
    console.log('No usable likes block found; leaving taste.json alone.');
    return;
  }

  let current = {};
  try {
    current = JSON.parse(await readFile(tastePath, 'utf8'));
  } catch {
    /* no profile yet is fine */
  }
  const comment = current._comment;
  const merged = mergeLikes(current, likes);
  if (comment) merged._comment = comment;

  await writeFile(tastePath, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(
    `Merged ${likes.length} like(s): ${Object.keys(merged.artists).length} artists, ` +
      `${Object.keys(merged.keywords).length} keywords, ${Object.keys(merged.contexts).length} contexts.`
  );
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
