#!/usr/bin/env node
/**
 * Does ArtStation's "latest" feed actually order by upload time?
 *
 * The endpoint exists and returns rows disjoint from trending, but so did
 * `?channel=`, which turned out to be trending verbatim. A name is not
 * evidence. If a feed is ordered newest-first, its head turns over as people
 * upload; if it is ordered by anything else, two samples minutes apart are
 * identical.
 *
 * Samples each feed twice with a gap in between and reports the churn. Counts
 * only — no titles, no links: this log is public.
 */

const GAP_MS = Number(process.env.CHURN_GAP_MS || 150_000);
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const FEEDS = {
  latest: 'https://www.artstation.com/api/v2/community/explore/projects/latest.json?page=1&dimension=all&per_page=50',
  trending: 'https://www.artstation.com/api/v2/community/explore/projects/trending.json?page=1&dimension=all&per_page=50',
};

async function sample(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://www.artstation.com/' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return (body?.data ?? []).map((p) => p.hash_id).filter(Boolean);
}

const first = {};
for (const [name, url] of Object.entries(FEEDS)) {
  try {
    first[name] = await sample(url);
  } catch (err) {
    first[name] = { error: err.message };
  }
  await new Promise((r) => setTimeout(r, 1500));
}

await new Promise((r) => setTimeout(r, GAP_MS));

const out = [
  `## ArtStation: is \`latest\` ordered by upload?`,
  '',
  `Two samples of each feed, ${Math.round(GAP_MS / 1000)}s apart.`,
  '',
  '| feed | rows | held over | new since | new rows in the top 10 |',
  '|---|---|---|---|---|',
];
const verdicts = {};
for (const [name, url] of Object.entries(FEEDS)) {
  const before = first[name];
  if (!Array.isArray(before)) {
    out.push(`| ${name} | — | — | — | first sample failed (${before.error}) |`);
    continue;
  }
  let after;
  try {
    after = await sample(url);
  } catch (err) {
    out.push(`| ${name} | ${before.length} | — | — | second sample failed (${err.message}) |`);
    continue;
  }
  const prior = new Set(before);
  const held = after.filter((h) => prior.has(h)).length;
  const fresh = after.length - held;
  const headFresh = after.slice(0, 10).filter((h) => !prior.has(h)).length;
  verdicts[name] = { held, fresh, headFresh, size: after.length };
  out.push(`| ${name} | ${after.length} | ${held} | ${fresh} | ${headFresh}/10 |`);
  await new Promise((r) => setTimeout(r, 1500));
}

const l = verdicts.latest;
const t = verdicts.trending;
if (l && t) {
  out.push(
    '',
    l.fresh > t.fresh && l.headFresh > 0
      ? `- **\`latest\` is upload-ordered.** It turned over ${l.fresh} of ${l.size} rows while trending turned over ` +
          `${t.fresh}, and ${l.headFresh} of its top ten did not exist in the sample taken ` +
          `${Math.round(GAP_MS / 1000)} seconds earlier. Work taken from its head is new because of how the feed is ` +
          'built, not because we assumed it.'
      : l.fresh === 0
        ? '- **`latest` did not move.** Whatever orders it, it is not upload time on this timescale, so its rows are ' +
          'no more provably new than trending\'s. Do not call anything from it new.'
        : `- **Inconclusive.** \`latest\` turned over ${l.fresh} rows and trending ${t.fresh}; that is not a clear ` +
          'enough difference to rest a freshness claim on. Widen CHURN_GAP_MS and ask again.'
  );
}

const text = out.join('\n');
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}
