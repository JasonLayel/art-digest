#!/usr/bin/env node
/**
 * Asks Pinterest what it will tell us about a profile without credentials.
 *
 *   node tools/probe-pinterest.mjs <username> [board-slug]
 *
 * Pinterest has historically served per-profile and per-board RSS. If it still
 * does, saved pins are readable with nothing but a username — and a pin is a
 * richer taste signal than a like, because it carries the board it was filed
 * under and usually a link back to the original artwork.
 *
 * Reports shapes and aggregates only: this runs in a public repo whose logs
 * anyone can read.
 */

const target = process.argv[2];
let board = process.argv[3];
if (!target) {
  console.error('usage: node tools/probe-pinterest.mjs <username | profile url | pin.it link> [board-slug]');
  process.exit(2);
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function probe(label, url, accept = 'application/rss+xml,text/xml,*/*') {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(20_000),
      redirect: 'follow',
    });
    const type = (res.headers.get('content-type') || '').split(';')[0];
    const body = res.ok ? await res.text() : '';
    return { label, url, status: res.status, type, ok: res.ok, body };
  } catch (err) {
    return { label, url, status: 'error', type: '', ok: false, body: '', note: err.message.slice(0, 60) };
  }
}

/** Follows a short link by hand so the whole chain is visible, not just its end. */
async function resolve(url, hops = 6) {
  const chain = [];
  let next = url;
  for (let i = 0; i < hops; i++) {
    let res;
    try {
      res = await fetch(next, {
        headers: { 'User-Agent': UA, Accept: 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9' },
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      chain.push(`${next} → error: ${err.message.slice(0, 50)}`);
      break;
    }
    const location = res.headers.get('location');
    chain.push(`${res.status} ${next}`);
    if (!location) break;
    next = new URL(location, next).toString();
  }
  return { final: next, chain };
}

const preamble = [];
let user = target;

if (/^https?:\/\//i.test(target)) {
  const { final, chain } = await resolve(target);
  preamble.push('### Where the link goes', '', '```', ...chain, `final: ${final}`, '```', '');
  const url = new URL(final);
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'pin') {
    // A pin URL names no profile; the page's embedded state does.
    preamble.push(`_That resolves to a single pin (${parts[1]}), not a profile._`, '');
    const page = await fetch(final, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(20_000) })
      .then((r) => (r.ok ? r.text() : ''))
      .catch(() => '');
    const owner = (page.match(/"pinner"[\s\S]{0,400}?"username"\s*:\s*"([^"]+)"/) ||
      page.match(/"username"\s*:\s*"([^"]+)"/) || [])[1];
    const boardSlug = (page.match(/"board"[\s\S]{0,600}?"url"\s*:\s*"\/([^/]+)\/([^/"]+)\//) || []);
    if (owner) {
      user = owner;
      preamble.push(`_Pinner in the page data: \`${owner}\`_`, '');
    }
    if (!board && boardSlug[2]) {
      board = boardSlug[2];
      preamble.push(`_Board in the page data: \`${boardSlug[2]}\`_`, '');
    }
    if (!owner) preamble.push('_No pinner found in the page — Pinterest may be serving a login wall to this runner._', '');
  } else if (parts.length) {
    user = parts[0];
    if (!board && parts[1]) board = parts[1];
  }
}

const results = [];
const targets = [
  ['profile feed (rss)', `https://www.pinterest.com/${user}/feed.rss`],
  ['profile page (html)', `https://www.pinterest.com/${user}/`, 'text/html'],
];
if (board) targets.push([`board "${board}" (rss)`, `https://www.pinterest.com/${user}/${board}.rss`]);

for (const [label, url, accept] of targets) {
  results.push(await probe(label, url, accept));
  await new Promise((r) => setTimeout(r, 1500));
}

const out = [`## Pinterest probe — \`${user}\``, '', ...preamble, '| endpoint | status | type | bytes |', '|---|---|---|---|'];
for (const r of results) {
  out.push(`| ${r.label} | ${r.ok ? '✅ ' + r.status : '❌ ' + r.status + (r.note ? ` (${r.note})` : '')} | ${r.type || '—'} | ${r.body.length || '—'} |`);
}

for (const r of results.filter((x) => x.ok && /xml/.test(x.type))) {
  const items = r.body.split(/<item>/).slice(1);
  const links = items.map((b) => (b.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || '').filter(Boolean);
  // Where a pin points is the useful part: it names the artist's own page.
  const hosts = new Map();
  for (const link of links) {
    try {
      const h = new URL(link.trim()).hostname.replace(/^www\./, '');
      hosts.set(h, (hosts.get(h) || 0) + 1);
    } catch {
      /* a relative or malformed link tells us nothing */
    }
  }
  out.push('', `### ${r.label}`, '');
  out.push(`- pins in the feed: **${items.length}**`);
  out.push(`- carries \`<description>\`: ${/<description>/.test(r.body) ? 'yes' : 'no'}`);
  out.push(`- carries an image (\`media:\` or \`<img\`): ${/<media:|&lt;img|<img/.test(r.body) ? 'yes' : 'no'}`);
  out.push(
    `- outbound link hosts: ${
      hosts.size ? [...hosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([h, c]) => `${h} (${c})`).join(', ') : '_none_'
    }`
  );
  out.push('', '```', r.body.slice(0, 600).replace(/</g, '&lt;'), '```');
}

const html = results.find((r) => r.label.startsWith('profile page') && r.ok);
if (html) {
  // Pinterest embeds its own state in the page; board names would come from there.
  const hasState = /__PWS_DATA__|__INITIAL_STATE__/.test(html.body);
  out.push('', `- profile HTML carries an embedded state blob: **${hasState ? 'yes' : 'no'}**`);
  const boards = [...html.body.matchAll(/"board_url"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
  out.push(`- board URLs visible in the HTML: **${new Set(boards).size}**`);
}

const text = out.join('\n');
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}
