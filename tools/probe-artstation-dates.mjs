#!/usr/bin/env node
/**
 * Can the artwork page tell us what the API won't?
 *
 * Every ArtStation JSON endpoint that answers us omits the upload date, and
 * the ones that would carry it (/projects/<hash>.json) return 403. But only
 * JSON has been asked. The page a human opens — /artwork/<hash> — is rendered
 * HTML, and pages like that usually carry a date for search engines, in a
 * JSON-LD block or an og:/article meta tag.
 *
 * Takes the current trending feed, opens the top few artwork pages, and
 * reports whether a date can be recovered and how old those pieces are.
 * Ages and counts only — no titles, no links: this log is public.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HOW_MANY = Number(process.env.DATE_SAMPLE || 12);

const html = async (url) => {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://www.artstation.com/',
    },
    signal: AbortSignal.timeout(25_000),
  });
  return { status: res.status, ok: res.ok, body: res.ok ? await res.text() : '' };
};

/** Where a date could plausibly be hiding, in rough order of trustworthiness. */
const EXTRACTORS = [
  ['JSON-LD datePublished', (t) => t.match(/"datePublished"\s*:\s*"([^"]+)"/)?.[1]],
  ['JSON-LD uploadDate', (t) => t.match(/"uploadDate"\s*:\s*"([^"]+)"/)?.[1]],
  ['meta published_time', (t) => t.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)/i)?.[1]],
  ['meta og:updated_time', (t) => t.match(/<meta[^>]+property=["']og:updated_time["'][^>]+content=["']([^"']+)/i)?.[1]],
  ['embedded published_at', (t) => t.match(/[""]published_at[""]\s*:\s*[""]([^""]+)[""]/)?.[1]],
  ['embedded created_at', (t) => t.match(/[""]created_at[""]\s*:\s*[""]([^""]+)[""]/)?.[1]],
];

const trending = await fetch(
  'https://www.artstation.com/api/v2/community/explore/projects/trending.json?page=1&dimension=all&per_page=50',
  { headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://www.artstation.com/' } }
).then((r) => (r.ok ? r.json() : null));

const hashes = (trending?.data ?? []).map((p) => p.hash_id).filter(Boolean).slice(0, HOW_MANY);

const out = [`## Can an ArtStation artwork page be dated?`, ''];
if (!hashes.length) {
  out.push('Trending did not answer, so there was nothing to open.');
} else {
  out.push(`Opened the top ${hashes.length} trending pieces as HTML.`, '');
  out.push('| # | page | date found via | age |', '|---|---|---|---|');

  const ages = [];
  let served = 0;
  for (const [i, hash] of hashes.entries()) {
    let page;
    try {
      page = await html(`https://www.artstation.com/artwork/${hash}`);
    } catch (err) {
      out.push(`| ${i + 1} | ❌ ${err.message.slice(0, 40)} | — | — |`);
      continue;
    }
    if (!page.ok) {
      out.push(`| ${i + 1} | ❌ ${page.status} | — | — |`);
      await new Promise((r) => setTimeout(r, 1200));
      continue;
    }
    served++;
    let found = null;
    for (const [label, extract] of EXTRACTORS) {
      const raw = extract(page.body);
      const t = raw ? Date.parse(raw) : NaN;
      if (Number.isFinite(t)) {
        found = { label, iso: new Date(t).toISOString() };
        break;
      }
    }
    if (found) {
      const days = (Date.now() - Date.parse(found.iso)) / 86_400_000;
      ages.push(days);
      out.push(
        `| ${i + 1} | ✅ ${page.status} | ${found.label} | ${
          days < 2 ? `${Math.round(days * 24)}h` : `${Math.round(days)} days`
        } |`
      );
    } else {
      out.push(`| ${i + 1} | ✅ ${page.status} | **none of the six patterns** | — |`);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }

  out.push('');
  if (!served) {
    out.push('- **The artwork page refuses us too.** HTML is gated the same way the project JSON is.');
  } else if (!ages.length) {
    out.push(
      `- **The page serves (${served}/${hashes.length}) but carries no date** in any of the six places checked.`,
      '  ArtStation genuinely does not publish upload dates to anyone who is not signed in.'
    );
  } else {
    const sorted = [...ages].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const within = (d) => ages.filter((a) => a <= d).length;
    out.push(
      `- **Dates are recoverable** for ${ages.length} of ${served} pages that served.`,
      `- Age of what ArtStation is currently trending: median **${
        median < 2 ? `${Math.round(median * 24)} hours` : `${Math.round(median)} days`
      }**, oldest **${Math.round(sorted[sorted.length - 1])} days**, newest **${Math.round(sorted[0] * 24)}h**.`,
      `- Within 48h: **${within(2)}/${ages.length}**. Within 7 days: **${within(7)}/${ages.length}**. Within 30 days: **${within(30)}/${ages.length}**.`,
      '',
      within(2) === ages.length
        ? '> Trending is entirely recent work. Treating it as new costs nothing, and these pages can supply real dates.'
        : within(7) >= ages.length * 0.8
          ? '> Trending is mostly recent but not all inside 48 hours. Real dates are worth fetching rather than assuming.'
          : '> Trending carries work well outside the digest window. Assuming it is new would have been wrong.'
    );
  }
}

const text = out.join('\n');
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}
