#!/usr/bin/env node
/**
 * Can anything fetch a Danbooru thumbnail on the reader's behalf?
 *
 * cdn.donmai.us answers 403 with an HTML block page to every request from
 * here, whatever referer is sent and whatever size is asked for. That is
 * Cloudflare turning away a request with no clearance cookie, which a
 * cross-site <img> on github.io can never have. So the URL cannot be fixed;
 * something has to fetch it on the reader's behalf, the way i.pixiv.re
 * already does for Pixiv.
 *
 * Tries the candidates and reports what actually comes back as an image.
 */

import { readFile } from 'node:fs/promises';

const digest = JSON.parse(await readFile(new URL('../data/latest.json', import.meta.url), 'utf8'));
const sample = (digest.items || []).find((i) => i.source === 'danbooru')?.thumb;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const out = ['## Can a proxy fetch a Danbooru thumbnail?', ''];
if (!sample) {
  out.push('No Danbooru pick in the current digest to test with.');
} else {
  out.push(`Testing \`${sample}\``, '', '| route | status | content-type | bytes |', '|---|---|---|---|');

  const bare = sample.replace(/^https?:\/\//, '');
  const candidates = [
    ['direct (control)', sample],
    ['images.weserv.nl', `https://images.weserv.nl/?url=${encodeURIComponent(bare)}&w=400`],
    ['wsrv.nl', `https://wsrv.nl/?url=${encodeURIComponent(bare)}&w=400`],
    // Danbooru's own host rather than its CDN, in case only the CDN is gated.
    ['danbooru.donmai.us path', sample.replace('cdn.donmai.us', 'danbooru.donmai.us')],
  ];

  for (const [label, url] of candidates) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
        redirect: 'follow',
        signal: AbortSignal.timeout(25_000),
      });
      const type = res.headers.get('content-type') || '—';
      const body = res.ok ? await res.arrayBuffer() : null;
      const isImage = /^image\//.test(type) && body && body.byteLength > 1000;
      out.push(`| ${label} | ${isImage ? '✅' : '❌'} ${res.status} | ${type} | ${body ? body.byteLength : '—'} |`);
    } catch (err) {
      out.push(`| ${label} | error | ${err.message.slice(0, 44)} | — |`);
    }
    await new Promise((r) => setTimeout(r, 600));
  }

  out.push(
    '',
    '> A route counts only if it returns an `image/*` type with real bytes.',
    '> A 200 carrying HTML is a block page wearing a success code.'
  );
}

const text = out.join('\n');
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}
