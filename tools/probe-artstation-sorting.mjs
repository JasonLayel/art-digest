#!/usr/bin/env node
/**
 * Does `&sorting=date` on ArtStation search really order by upload?
 *
 * It returns a completely different fifty rows from the relevance baseline —
 * zero shared, as different as page=2 — so it is doing SOMETHING. That is not
 * the same as doing what its name says, and search rows carry no date to check
 * against, which is the whole problem.
 *
 * So check it the way the latest feed was checked: sample twice with a gap. A
 * query ordered newest-first turns its head over as people upload; one ordered
 * by relevance or by likes does not move in minutes. Relevance is the control.
 *
 * The catch, learned by running it: this only answers for a query busy enough
 * to receive uploads inside the gap. The site-wide latest feed churns because
 * every upload flows through it. A subject with 41,000 results from fifteen
 * years gets one every few hours, so zero churn proves nothing about it. Read
 * a still result as "unknown", never as "not by date".
 */

const GAP_MS = Number(process.env.CHURN_GAP_MS || 150_000);
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const SEARCH = 'https://www.artstation.com/api/v2/search/projects.json';
const QUERY = encodeURIComponent(process.env.CHURN_QUERY || 'environment concept art');

const FEEDS = {
  'sorting=date': `${SEARCH}?query=${QUERY}&page=1&per_page=50&sorting=date`,
  'sorting=likes': `${SEARCH}?query=${QUERY}&page=1&per_page=50&sorting=likes`,
  'relevance (control)': `${SEARCH}?query=${QUERY}&page=1&per_page=50`,
};

async function sample(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://www.artstation.com/search' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return (body?.data ?? body?.results ?? []).map((p) => p.hash_id).filter(Boolean);
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
  '## Is ArtStation search really orderable by date?',
  '',
  `Two samples of each ordering, ${Math.round(GAP_MS / 1000)}s apart, for \`${decodeURIComponent(QUERY)}\`.`,
  '',
  '| ordering | rows | held over | new since | new in the top 10 |',
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
  const headFresh = after.slice(0, 10).filter((h) => !prior.has(h)).length;
  verdicts[name] = { held, fresh: after.length - held, headFresh, size: after.length };
  out.push(`| \`${name}\` | ${after.length} | ${held} | ${after.length - held} | ${headFresh}/10 |`);
  await new Promise((r) => setTimeout(r, 1500));
}

const date = verdicts['sorting=date'];
const control = verdicts['relevance (control)'];
if (date && control) {
  out.push(
    '',
    date.fresh > control.fresh && date.headFresh > 0
      ? `- **\`sorting=date\` is upload-ordered.** It turned over ${date.fresh} of ${date.size} rows while relevance ` +
          `turned over ${control.fresh}, and ${date.headFresh} of its top ten did not exist ${Math.round(GAP_MS / 1000)}s ` +
          'earlier. ArtStation can finally be asked for new work on a subject.'
      : date.fresh === 0
        ? '- **`sorting=date` did not move, and this test cannot say why.** A narrow subject accumulates slowly: ' +
          '"environment concept art" holds ~41,000 pieces from about fifteen years, which is one upload every few ' +
          'hours, so a date-ordered query would show zero churn in 150 seconds too. Not-date-ordered and ' +
          'date-ordered-but-quiet look identical here. Settling it needs a query busy enough to move within the gap, ' +
          'or a much longer gap — until then nothing from this ordering may be called new.'
        : `- **Inconclusive.** date turned over ${date.fresh} rows and relevance ${control.fresh}; not a clear enough ` +
          'difference. Widen CHURN_GAP_MS and ask again.'
  );
}
const likes = verdicts['sorting=likes'];
if (likes) {
  out.push(
    likes.fresh === 0
      ? '- `sorting=likes` held still, which is what an all-time popularity ordering should do.'
      : `- \`sorting=likes\` moved ${likes.fresh} rows, which an all-time popularity ordering should not.`
  );
}

const text = out.join('\n');
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}
