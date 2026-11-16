#!/usr/bin/env node
/**
 * Builds a rating sample out of the archive.
 *
 *   node tools/build-calibration.mjs [count] [data/archive] [data/calibration.json]
 *
 * The profile in taste.json was guessed from a couple of probes, and two months
 * of digests say it is mostly wrong: 93% of picks matched none of it. The way
 * out is to ask about real pieces rather than invent more keywords.
 *
 * The sample is deliberately NOT a copy of what the digest serves. The digest
 * gives every source an equal share, so a straight sample would be half anime
 * fan art and would teach the profile that that is the question. Instead every
 * source and every context gets a turn before any gets a second, which is the
 * same round-robin the digest ranks with — so a subreddit that appeared twice
 * in two months still gets asked about, and a dominant one cannot crowd it out.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Only what a card needs to be judged — the archive keeps the rest. */
const forRating = (item) => ({
  id: item.id,
  source: item.source,
  context: item.context || '',
  title: item.title || 'Untitled',
  artist: item.artist || '',
  thumb: item.thumb || item.image || '',
  url: item.url || '',
  nsfw: Boolean(item.nsfw),
});

/**
 * Equal shares per source, and within a source one pick per context before any
 * context repeats. Two levels, because context granularity is wildly uneven:
 * ArtStation files all 388 of its picks under "Trending" while Pixiv gives
 * every single pick its own ("Daily ranking #17"), so a one-level round-robin
 * over contexts hands Pixiv thirty slots and ArtStation one.
 *
 * Within a context the picks are spread across days, so a subreddit that ran
 * for weeks does not contribute five pieces from one afternoon.
 */
export function sampleItems(items, count = 60) {
  const bySource = new Map();
  for (const item of items) {
    if (!bySource.has(item.source)) bySource.set(item.source, new Map());
    const contexts = bySource.get(item.source);
    const key = item.context || '';
    if (!contexts.has(key)) contexts.set(key, []);
    contexts.get(key).push(item);
  }

  const spreadByDay = (list, take) => {
    const sorted = [...list].sort((a, b) => String(a.day).localeCompare(String(b.day)));
    const step = Math.max(1, Math.floor(sorted.length / take));
    const picked = [];
    for (let i = 0; i < sorted.length && picked.length < take; i += step) picked.push(sorted[i]);
    return picked;
  };

  // Each source becomes one queue, itself round-robinned over its contexts.
  // A source with one context (ArtStation files everything under "Trending")
  // has to be allowed to go deep into it, or it runs out after one pass and
  // forfeits its share to sources that happen to label their picks finely.
  const queues = [...bySource.entries()].map(([source, contexts]) => {
    const perContext = Math.min(20, Math.max(4, Math.ceil(count / contexts.size)));
    const ordered = [];
    const lists = [...contexts.values()].map((list) => spreadByDay(list, perContext));
    for (let round = 0; ; round++) {
      let added = 0;
      for (const list of lists) {
        if (list[round]) {
          ordered.push(list[round]);
          added++;
        }
      }
      if (!added) break;
    }
    return { source, ordered };
  });

  const seen = new Set();
  const out = [];
  for (let round = 0; out.length < count; round++) {
    let added = 0;
    for (const queue of queues) {
      if (out.length >= count) break;
      const item = queue.ordered[round];
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(forRating(item));
      added++;
    }
    if (!added) break; // every source is exhausted
  }
  return out;
}

export async function loadArchive(dir, { read = readFile, list = readdir } = {}) {
  const names = (await list(dir)).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
  const items = [];
  for (const name of names) {
    try {
      const day = JSON.parse(await read(join(dir, name), 'utf8'));
      for (const item of day.items || []) if (item?.id) items.push({ ...item, day: name.slice(0, 10) });
    } catch {
      // A half-written day is skipped, as everywhere else that reads these.
    }
  }
  return items;
}

async function main() {
  const [countArg, dir = 'data/archive', out = 'data/calibration.json'] = process.argv.slice(2);
  const count = Number(countArg) || 60;
  const items = await loadArchive(dir);
  const sample = sampleItems(items, count);
  const contexts = new Set(sample.map((i) => `${i.source}::${i.context}`));
  await writeFile(
    out,
    `${JSON.stringify({ builtAt: new Date().toISOString(), drawnFrom: items.length, items: sample }, null, 2)}\n`
  );
  console.log(`${sample.length} pieces from ${contexts.size} contexts, drawn from ${items.length} picks → ${out}`);
  const bySource = {};
  for (const i of sample) bySource[i.source] = (bySource[i.source] || 0) + 1;
  for (const [s, n] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) console.log(`  ${s.padEnd(12)} ${n}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
