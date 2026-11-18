#!/usr/bin/env node
/**
 * Why don't Danbooru thumbnails show?
 *
 * The cards have been blank for weeks. Two candidate causes, and they need
 * telling apart before anything is changed:
 *
 *   1. We ship the wrong URL. `large_file_url` is first choice for the thumb,
 *      and on a video post that is an .mp4 — which no <img> will ever render.
 *   2. The CDN refuses us. Plenty of image hosts reject hotlinks.
 *
 * Fetches a page of the same query the collector uses, prints what fields a
 * row really carries, and then actually requests each candidate URL to see
 * what comes back. Status and content-type only — no titles, this log is public.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const rows = await fetch('https://danbooru.donmai.us/posts.json?tags=order%3Ascore+age%3A1d&limit=12', {
  headers: { 'User-Agent': UA, Accept: 'application/json' },
}).then((r) => (r.ok ? r.json() : null));

const out = ['## Danbooru thumbnails', ''];
if (!Array.isArray(rows) || !rows.length) {
  out.push('The API did not answer, so nothing below means anything.');
} else {
  const first = rows[0];
  out.push('### What a row carries', '', '```', Object.keys(first).sort().join(', ').slice(0, 900), '```', '');
  if (first.media_asset) {
    out.push(
      '`media_asset.variants` is present:',
      '',
      '```',
      (first.media_asset.variants || []).map((v) => `${v.type}  ${v.file_ext}  ${v.width}x${v.height}`).join('\n'),
      '```',
      ''
    );
  } else {
    out.push('_No `media_asset` on the row — only the flat \\*_file_url fields._', '');
  }

  // How often is the field we pick first not even an image?
  const ext = (u) => String(u || '').split('.').pop().toLowerCase().slice(0, 5);
  const notImage = rows.filter((p) => !['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext(p.large_file_url)));
  out.push(
    `### Is the chosen field even an image?`,
    '',
    `- rows whose \`large_file_url\` is **not** an image: **${notImage.length} of ${rows.length}** ` +
      `(${[...new Set(notImage.map((p) => ext(p.large_file_url)))].join(', ') || 'none'})`,
    ''
  );

  out.push('### Does the CDN actually serve us?', '', '| candidate | referer | status | content-type |', '|---|---|---|---|');
  const candidates = [
    ['preview_file_url', first.preview_file_url],
    ['large_file_url', first.large_file_url],
    ['360x360 variant', (first.media_asset?.variants || []).find((v) => v.type === '360x360')?.url],
    ['720x720 variant', (first.media_asset?.variants || []).find((v) => v.type === '720x720')?.url],
  ];
  for (const [label, url] of candidates) {
    if (!url) {
      out.push(`| ${label} | — | _absent_ | — |`);
      continue;
    }
    for (const [name, referer] of [['none', null], ['danbooru', 'https://danbooru.donmai.us/'], ['the widget', 'https://jasonlayel.github.io/']]) {
      try {
        const headers = { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' };
        if (referer) headers.Referer = referer;
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
        out.push(`| ${label} | ${name} | ${res.ok ? '✅' : '❌'} ${res.status} | ${res.headers.get('content-type') || '—'} |`);
      } catch (err) {
        out.push(`| ${label} | ${name} | error | ${err.message.slice(0, 40)} |`);
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
