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
  // The first attempt returned 400 with a JSON body from weserv itself, which
  // is its own complaint about the parameter rather than Danbooru refusing —
  // so try the forms its documentation actually describes.
  const candidates = [
    ['direct (control)', sample],
    ['weserv, bare host', `https://images.weserv.nl/?url=${bare}`],
    ['weserv, ssl: prefix', `https://images.weserv.nl/?url=ssl:${bare}`],
    ['weserv, full url encoded', `https://images.weserv.nl/?url=${encodeURIComponent(sample)}`],
    ['wsrv.nl, bare host', `https://wsrv.nl/?url=${bare}`],
    ['wsrv.nl, ssl: prefix, resized', `https://wsrv.nl/?url=ssl:${bare}&w=400`],
  ];

  for (const [label, url] of candidates) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
        redirect: 'follow',
        signal: AbortSignal.timeout(25_000),
      });
      const type = res.headers.get('content-type') || '—';
      const body = await res.arrayBuffer().catch(() => null);
      const isImage = res.ok && /^image\//.test(type) && body && body.byteLength > 1000;
      out.push(`| ${label} | ${isImage ? '✅' : '❌'} ${res.status} | ${type} | ${body ? body.byteLength : '—'} |`);
      // A proxy that refuses says why; print it, since the reason is the lead.
      if (!isImage && /json|text/.test(type) && body) {
        out.push(`| ↳ said | | \`${new TextDecoder().decode(body).slice(0, 90).replace(/\n/g, ' ')}\` | |`);
      }
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
