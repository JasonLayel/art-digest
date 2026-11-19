#!/usr/bin/env node
/**
 * Does Danbooru's CDN actually serve the thumbnails we ship?
 *
 * The cards are still blank after two fixes that were both real — the
 * referrer policy was being set after the fetch began, and .mp4 originals
 * were being handed to an <img>. Neither was the whole story, so this stops
 * reasoning about it and asks.
 *
 * Reads the URLs straight out of the committed digest rather than calling the
 * API, because the API call is what broke the last attempt at this.
 *
 * NOTE: this runs from a datacenter. A refusal here is suggestive, not proof,
 * and a success here does NOT prove a browser on a home connection is served.
 * The browser is the only place that settles it.
 */

import { readFile } from 'node:fs/promises';

const BROWSERISH = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const digest = JSON.parse(await readFile(new URL('../data/latest.json', import.meta.url), 'utf8'));
const danbooru = (digest.items || []).filter((i) => i.source === 'danbooru');

const out = ['## Does the Danbooru CDN serve what we ship?', ''];
if (!danbooru.length) {
  out.push('No Danbooru picks in the current digest.');
} else {
  out.push(`| url | referer sent | status | content-type | bytes |`, '|---|---|---|---|---|');
  // The first pick's thumb plus every fallback, so a working rung shows up.
  const urls = [danbooru[0].thumb, ...(danbooru[0].thumbFallbacks || []), danbooru[1]?.thumb].filter(Boolean);
  for (const url of [...new Set(urls)]) {
    for (const [label, referer] of [
      ['none', null],
      ['danbooru', 'https://danbooru.donmai.us/'],
      ['the widget', 'https://jasonlayel.github.io/art-digest/'],
    ]) {
      try {
        const headers = { ...BROWSERISH };
        if (referer) headers.Referer = referer;
        const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
        const body = res.ok ? await res.arrayBuffer() : null;
        out.push(
          `| \`${url.replace('https://cdn.donmai.us', '')}\` | ${label} | ${res.ok ? '✅' : '❌'} ${res.status} | ` +
            `${res.headers.get('content-type') || '—'} | ${body ? body.byteLength : '—'} |`
        );
        // Headers that stop a browser embedding an image even when the fetch
        // itself succeeds — the failure mode that looks like nothing at all.
        if (res.ok) {
          const corp = res.headers.get('cross-origin-resource-policy');
          const cors = res.headers.get('access-control-allow-origin');
          if (corp) out.push(`| ↳ | | \`Cross-Origin-Resource-Policy: ${corp}\` | | |`);
          if (cors) out.push(`| ↳ | | \`Access-Control-Allow-Origin: ${cors}\` | | |`);
        }
      } catch (err) {
        out.push(`| \`${url.slice(-28)}\` | ${label} | error | ${err.message.slice(0, 40)} | — |`);
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

const text = out.join('\n');
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}
