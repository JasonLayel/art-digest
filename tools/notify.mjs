#!/usr/bin/env node
/**
 * Pushes a line about today's digest to your phone.
 *
 *   node tools/notify.mjs [data/latest.json]
 *
 * Email is gone and was never wanted. This uses ntfy.sh, which needs no
 * account on either side: you subscribe to a topic in the ntfy app, and this
 * POSTs to that topic. The topic name IS the credential — anyone who knows it
 * can send you notifications — so it lives in ART_DIGEST_NTFY_TOPIC as a
 * repository secret and is never printed.
 *
 * With no topic set it prints what it would have sent and exits 0, so the
 * daily run is never broken by a notification.
 */

import { readFile } from 'node:fs/promises';

const topic = (process.env.ART_DIGEST_NTFY_TOPIC || '').trim();
const server = (process.env.ART_DIGEST_NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
const site = process.env.ART_DIGEST_SITE || 'https://JasonLayel.github.io/art-digest/';

/** One line that is worth reading on a lock screen. */
export function summarize(digest) {
  const items = digest?.items || [];
  const onTaste = items.filter((i) => (i.matched || []).length).length;
  const sources = digest?.sources || [];
  const down = sources.filter((s) => s.status !== 'ok').map((s) => s.label || s.id);
  const top = items[0];

  const title = top?.title ? `${top.title}${top.artist ? ` — ${top.artist}` : ''}` : 'Today\'s digest';
  const lines = [`${items.length} picks · ${onTaste} on your subjects`];
  // A source that quietly stopped is the thing worth being told about.
  if (down.length) lines.push(`not answering: ${down.join(', ')}`);

  return { title: title.slice(0, 120), body: lines.join('\n'), thumb: top?.thumb || '' };
}

async function main() {
  const [path = new URL('../data/latest.json', import.meta.url).pathname] = process.argv.slice(2);
  const digest = JSON.parse(await readFile(path, 'utf8'));
  const { title, body, thumb } = summarize(digest);

  if (!topic) {
    console.log('No ART_DIGEST_NTFY_TOPIC set, so nothing was sent. It would have been:');
    console.log(`  ${title}\n  ${body.replace(/\n/g, '\n  ')}`);
    return;
  }

  const headers = {
    Title: title,
    Click: site,
    Tags: 'art',
    'Content-Type': 'text/plain; charset=utf-8',
  };
  // A picture on the lock screen is most of the point.
  if (/^https:\/\//.test(thumb)) headers.Attach = thumb;

  const res = await fetch(`${server}/${encodeURIComponent(topic)}`, { method: 'POST', headers, body });
  if (!res.ok) {
    // Never fail the digest over a notification.
    console.error(`ntfy refused the push: HTTP ${res.status}`);
    return;
  }
  console.log(`Pushed: ${title}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    console.error(`Could not notify: ${err.message}`);
  });
}
