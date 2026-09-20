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

async function probe(label, url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json', Referer: `https://www.artstation.com/${user}` },
      signal: AbortSignal.timeout(20_000),
    });
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
for (const [label, url] of [
  ['profile', `https://www.artstation.com/users/${user}.json`],
  ['likes', `https://www.artstation.com/users/${user}/likes.json?page=1`],
  ['following', `https://www.artstation.com/users/${user}/following.json?page=1`],
  ['followers', `https://www.artstation.com/users/${user}/followers.json?page=1`],
  ['own projects', `https://www.artstation.com/users/${user}/projects.json?page=1`],
]) {
  results.push(await probe(label, url));
  await new Promise((r) => setTimeout(r, 1200));
}

const out = [`## ArtStation probe — \`${user}\``, '', '| endpoint | status | rows | total |', '|---|---|---|---|'];
for (const r of results) {
  const list = r.ok ? rows(r.body) : [];
  const total = r.ok ? (r.body?.total_count ?? r.body?.total ?? '') : '';
  out.push(`| ${r.label} | ${r.ok ? '✅ ' + r.status : '❌ ' + r.status + (r.note ? ` (${r.note})` : '')} | ${r.ok ? list.length : '—'} | ${total} |`);
}

const likes = results.find((r) => r.label === 'likes');
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
  out.push('', '> Likes are not readable anonymously — either the endpoint is gone or the profile keeps likes private.');
}

const text = out.join('\n');
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}
