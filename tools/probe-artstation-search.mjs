#!/usr/bin/env node
/**
 * What can ArtStation search actually be asked for?
 *
 * Search is the one parameter ArtStation honours — channel and medium are
 * decoration, and the POST endpoint its own UI uses is 412-gated. So if more
 * ArtStation is wanted, search is the road, and the open questions are whether
 * it can be ordered by date (it returns the whole archive by relevance, which
 * is how an eleven-year-old piece once reached #6) and whether anything
 * narrows it beyond the query string.
 *
 * Reports status, result counts and — the part that matters — whether a
 * variant's rows actually DIFFER from the plain query. A parameter that is
 * quietly ignored answers 200 with a full page and looks like it works.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.artstation.com/search',
  'X-Requested-With': 'XMLHttpRequest',
};

const SEARCH = 'https://www.artstation.com/api/v2/search/projects.json';
const EXPLORE = 'https://www.artstation.com/api/v2/community/explore/projects';

async function get(label, url) {
  try {
    const headers = { ...HEADERS };
    if (process.env.ARTSTATION_COOKIE) headers.Cookie = process.env.ARTSTATION_COOKIE;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { label, ok: false, status: res.status };
    const body = await res.json();
    const rows = body?.data ?? body?.results ?? [];
    return {
      label,
      ok: true,
      status: res.status,
      total: body?.total_count ?? body?.total ?? null,
      ids: rows.map((p) => p.hash_id).filter(Boolean),
      keys: rows[0] ? Object.keys(rows[0]).sort() : [],
    };
  } catch (err) {
    return { label, ok: false, status: 'error', note: err.message.slice(0, 50) };
  }
}

const q = (s) => encodeURIComponent(s);
const pause = () => new Promise((r) => setTimeout(r, 1300));

// The subjects actually wanted, not the ones this repo guessed in September.
const SUBJECTS = [
  'environment concept art',
  'architecture',
  'archviz interior',
  '3d character',
  'stylized character',
  'realistic character portrait',
  'character design sheet',
  'sci-fi environment',
];

const out = [`## ArtStation search — what can it be asked for?`, ''];

// 1. Can the ordering be changed? Compare each variant against the plain query.
const base = await get('plain', `${SEARCH}?query=${q('environment concept art')}&page=1&per_page=50`);
await pause();

out.push('### Can search be ordered by date?', '');
if (!base.ok) {
  out.push(`The plain query failed (${base.status}), so nothing below means anything.`);
} else {
  out.push(`Baseline: \`environment concept art\` → ${base.ids.length} rows of ${base.total} total.`, '');
  out.push('| variant | status | rows | same rows as plain | same order |', '|---|---|---|---|---|');
  const variants = [
    ['&sorting=date', `${SEARCH}?query=${q('environment concept art')}&page=1&per_page=50&sorting=date`],
    ['&sort_by=date', `${SEARCH}?query=${q('environment concept art')}&page=1&per_page=50&sort_by=date`],
    ['&order=date', `${SEARCH}?query=${q('environment concept art')}&page=1&per_page=50&order=date`],
    ['&sorting=latest', `${SEARCH}?query=${q('environment concept art')}&page=1&per_page=50&sorting=latest`],
    ['&sorting=likes', `${SEARCH}?query=${q('environment concept art')}&page=1&per_page=50&sorting=likes`],
    ['&medium=3d', `${SEARCH}?query=${q('environment concept art')}&page=1&per_page=50&medium=3d`],
    ['&page=2 (control)', `${SEARCH}?query=${q('environment concept art')}&page=2&per_page=50`],
  ];
  const baseSet = new Set(base.ids);
  for (const [label, url] of variants) {
    const r = await get(label, url);
    await pause();
    if (!r.ok) {
      out.push(`| \`${label}\` | ❌ ${r.status} | — | — | — |`);
      continue;
    }
    const shared = r.ids.filter((id) => baseSet.has(id)).length;
    const sameOrder = r.ids.length === base.ids.length && r.ids.every((id, i) => id === base.ids[i]);
    out.push(
      `| \`${label}\` | ✅ ${r.status} | ${r.ids.length} | ${shared}/${r.ids.length} | ${sameOrder ? '**identical — ignored**' : 'different'} |`
    );
  }
  out.push(
    '',
    '> `&page=2` is the control: a parameter that genuinely works changes the rows.',
    '> Anything matching the baseline exactly is being dropped on the floor.'
  );
}

// 2. Does the explore/latest feed take a query or a channel?
out.push('', '### Can the latest feed be narrowed?', '');
const latest = await get('latest plain', `${EXPLORE}/latest.json?page=1&dimension=all&per_page=50`);
await pause();
if (latest.ok) {
  out.push(`Baseline: latest → ${latest.ids.length} rows.`, '');
  out.push('| variant | status | rows | same as plain latest |', '|---|---|---|---|');
  const latestSet = new Set(latest.ids);
  for (const [label, url] of [
    ['&query=architecture', `${EXPLORE}/latest.json?page=1&dimension=all&per_page=50&query=${q('architecture')}`],
    ['&channel=environment-concept-art', `${EXPLORE}/latest.json?page=1&dimension=all&per_page=50&channel=environment-concept-art`],
    ['&medium=3d', `${EXPLORE}/latest.json?page=1&dimension=all&per_page=50&medium=3d`],
  ]) {
    const r = await get(label, url);
    await pause();
    if (!r.ok) {
      out.push(`| \`${label}\` | ❌ ${r.status} | — | — |`);
      continue;
    }
    const shared = r.ids.filter((id) => latestSet.has(id)).length;
    out.push(`| \`${label}\` | ✅ ${r.status} | ${r.ids.length} | ${shared}/${r.ids.length}${shared === r.ids.length ? ' — **ignored**' : ''} |`);
  }
} else {
  out.push(`The latest feed did not answer (${latest.status}).`);
}

// 3. Do the subjects actually return anything, and do they return DIFFERENT
//    things from each other? One shared pool would mean search is cosmetic.
out.push('', '### Do the wanted subjects return distinct work?', '');
out.push('| query | total results | rows | overlap with the previous subject |', '|---|---|---|---|');
let previous = null;
const perSubject = [];
for (const subject of SUBJECTS) {
  const r = await get(subject, `${SEARCH}?query=${q(subject)}&page=1&per_page=50`);
  await pause();
  if (!r.ok) {
    out.push(`| ${subject} | ❌ ${r.status} | — | — |`);
    continue;
  }
  const overlap = previous ? r.ids.filter((id) => previous.has(id)).length : 0;
  out.push(`| ${subject} | ${r.total ?? '?'} | ${r.ids.length} | ${previous ? overlap : '—'} |`);
  previous = new Set(r.ids);
  perSubject.push(r);
}

if (perSubject.length) {
  out.push('', '### What a search row carries', '', '```', perSubject[0].keys.join(', '), '```');
  const dated = perSubject[0].keys.some((k) => /date|published|created/i.test(k));
  out.push(
    '',
    dated
      ? '- A date field is present after all — search results can be aged.'
      : '- Still no date field, so anything built on search is undated and cannot claim to be new.'
  );
}

const text = out.join('\n');
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}
