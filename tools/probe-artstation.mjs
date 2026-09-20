#!/usr/bin/env node
/**
 * Asks ArtStation what it will tell us about a profile without credentials.
 *
 *   node tools/probe-artstation.mjs <username>
 *
 * Reports status codes, response shapes and aggregate counts only — never the
 * liked pieces themselves, because this runs in a public repo whose logs
 * anyone can read.
 */

const user = process.argv[2];
if (!user) {
  console.error('usage: node tools/probe-artstation.mjs <username>');
  process.exit(2);
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// A fuller set of the headers a real browser sends, in case the difference
// between a refusal and an answer is simply how much we look like one.
const BROWSERISH = {
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Ch-Ua': '"Chromium";v="124", "Not:A-Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'X-Requested-With': 'XMLHttpRequest',
};

async function probe(label, url, { browserish = false } = {}) {
  try {
    const headers = browserish
      ? { ...BROWSERISH, Referer: `https://www.artstation.com/${user}` }
      : { 'User-Agent': UA, Accept: 'application/json', Referer: `https://www.artstation.com/${user}` };
    // An ArtStation session cookie, if one is configured, turns these into
    // authenticated requests the way PIXIV_SESSION does for Pixiv.
    if (process.env.ARTSTATION_COOKIE) headers.Cookie = process.env.ARTSTATION_COOKIE;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    const type = (res.headers.get('content-type') || '').split(';')[0];
    if (!res.ok) return { label, url, status: res.status, type, ok: false };
    if (!type.includes('json')) return { label, url, status: res.status, type, ok: false, note: 'not JSON' };
    return { label, url, status: res.status, type, ok: true, body: await res.json() };
  } catch (err) {
    return { label, url, status: 'error', type: '', ok: false, note: err.message.slice(0, 60) };
  }
}

const rows = (body) => body?.data ?? (Array.isArray(body) ? body : []);
const count = (values) => {
  const tally = new Map();
  for (const v of values.filter(Boolean)) tally.set(v, (tally.get(v) || 0) + 1);
  return [...tally.entries()].sort((a, b) => b[1] - a[1]);
};

const results = [];
for (const [label, url, options] of [
  // Control: the endpoint the collector already uses every day. If this
  // answers while /users/ paths refuse, the block is on the path, not on us.
  ['CONTROL explore/trending', 'https://www.artstation.com/api/v2/community/explore/projects/trending.json?page=1&dimension=all&per_page=50', {}],
  ['profile', `https://www.artstation.com/users/${user}.json`, {}],
  ['profile (browser headers)', `https://www.artstation.com/users/${user}.json`, { browserish: true }],
  ['profile (v2 api)', `https://www.artstation.com/api/v2/users/${user}/profile.json`, { browserish: true }],
  ['likes', `https://www.artstation.com/users/${user}/likes.json?page=1`, {}],
  ['likes (browser headers)', `https://www.artstation.com/users/${user}/likes.json?page=1`, { browserish: true }],
  ['following (browser headers)', `https://www.artstation.com/users/${user}/following.json?page=1`, { browserish: true }],
  ['own projects (browser headers)', `https://www.artstation.com/users/${user}/projects.json?page=1`, { browserish: true }],
]) {
  results.push(await probe(label, url, options));
  await new Promise((r) => setTimeout(r, 1500));
}

const out = [`## ArtStation probe — \`${user}\``, '', '| endpoint | status | rows | total |', '|---|---|---|---|'];
for (const r of results) {
  const list = r.ok ? rows(r.body) : [];
  const total = r.ok ? (r.body?.total_count ?? r.body?.total ?? '') : '';
  out.push(`| ${r.label} | ${r.ok ? '✅ ' + r.status : '❌ ' + r.status + (r.note ? ` (${r.note})` : '')} | ${r.ok ? list.length : '—'} | ${total} |`);
}

out.push('', process.env.ARTSTATION_COOKIE ? '_Probed with a session cookie._' : '_Probed anonymously (no ARTSTATION_COOKIE set)._');

const control = results.find((r) => r.label.startsWith('CONTROL'));
const anyUser = results.filter((r) => !r.label.startsWith('CONTROL'));
if (control?.ok && anyUser.every((r) => !r.ok)) {
  out.push(
    '',
    '> **The block is path-specific, not IP-specific.** The explore API answers this same runner',
    '> while every /users/ path refuses it, so this is ArtStation gating profile endpoints — not a',
    '> privacy setting on the profile, and not our address being blacklisted outright.'
  );
}

const likes = results.filter((r) => r.label.startsWith('likes')).find((r) => r.ok);
if (likes?.ok) {
  const list = rows(likes.body);
  out.push('', '### What a liked project carries', '', '```', `keys: ${Object.keys(list[0] || {}).sort().join(', ')}`, '```');
  out.push('', '### Aggregates (no titles or links — this log is public)', '');
  out.push(`- liked projects on page 1: **${list.length}**`);
  out.push(`- distinct artists: **${new Set(list.map((p) => p.user?.username).filter(Boolean)).size}**`);
  const cats = count(list.flatMap((p) => (p.categories || []).map((c) => c.name)));
  const soft = count(list.flatMap((p) => (p.software_items || []).map((s) => s.name)));
  const tags = count(list.flatMap((p) => p.tags || []));
  out.push(`- categories present: ${cats.length ? cats.slice(0, 6).map(([n, c]) => `${n} (${c})`).join(', ') : '_none in this payload_'}`);
  out.push(`- software present: ${soft.length ? soft.slice(0, 6).map(([n, c]) => `${n} (${c})`).join(', ') : '_none in this payload_'}`);
  out.push(`- free tags present: ${tags.length ? `${tags.length} distinct` : '_none in this payload_'}`);

  // One project detail page, to see whether tags live there instead.
  const hash = list[0]?.hash_id;
  if (hash) {
    const detail = await probe('project detail', `https://www.artstation.com/projects/${hash}.json`);
    out.push('', `- project detail endpoint: ${detail.ok ? '✅ ' + detail.status : '❌ ' + detail.status}`);
    if (detail.ok) {
      const keys = Object.keys(detail.body || {});
      out.push(`- detail carries: \`${keys.filter((k) => /tag|categor|software|medium/i.test(k)).join(', ') || 'no tag-like fields'}\``);
    }
  }
} else {
  const codes = [...new Set(results.filter((r) => r.label.startsWith('likes')).map((r) => r.status))];
  out.push(
    '',
    `> Likes did not come back (${codes.join(', ')}).`,
    '> A 403 here says the request was refused, which is not the same as the likes being private:',
    '> a private profile still serves its public endpoints. Compare against the control row above,',
    '> and against whether the daily collection is still reading the explore feed, before concluding',
    '> anything about the account itself.'
  );
}

const text = out.join('\n');
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}
