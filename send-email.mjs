#!/usr/bin/env node
/**
 * Emails the current digest.
 *
 * Reads what collect.mjs wrote and sends it as a multipart (plain + HTML)
 * message over SMTP. Zero dependencies — node:tls speaks SMTP directly — so
 * the workflow needs no third-party action holding the mail credentials.
 *
 * Required to actually send (repository secrets):
 *   DIGEST_SMTP_USER   e.g. you@gmail.com
 *   DIGEST_SMTP_PASS   an app password, never your account password
 * Optional:
 *   DIGEST_TO          recipient (default: DIGEST_SMTP_USER)
 *   DIGEST_SMTP_HOST   default smtp.gmail.com
 *   DIGEST_SMTP_PORT   default 465 (implicit TLS)
 *   DIGEST_FROM_NAME   default "Daily Art Digest"
 *
 * With no credentials it prints what it would have sent and exits 0, so the
 * collection workflow still succeeds.
 *
 *   node art-digest/send-email.mjs [--dry-run]
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connect } from 'node:tls';
import { renderEmail } from './collect.mjs';
import { randomUUID } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const DATA = process.env.ART_DIGEST_OUT || join(HERE, 'data');
const SITE = process.env.ART_DIGEST_SITE || 'https://JasonLayel.github.io/art-digest/';

/* ------------------------------------------------------------ attachments */

const IMAGE_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
};

/**
 * Downloads each thumbnail so the message can carry it.
 *
 * Remote images in an email are fetched by the reader's mail client — Gmail
 * routes them through its own proxy, which is a datacenter address that some
 * art CDNs refuse, and which never runs at all if the reader has "ask before
 * displaying external images" switched on. Either way the picture is missing.
 * An attached image is part of the message and always renders.
 */
export async function collectInlineImages(items, options = {}) {
  const { maxBytes = 200_000, totalBytes = 8_000_000, fetchImpl = fetch, timeout = 15_000 } = options;
  const attachments = [];
  const byItem = new Map();
  let used = 0;

  for (const [index, item] of items.entries()) {
    const url = item.thumb || item.image;
    if (!url || used >= totalBytes) continue;
    try {
      const res = await fetchImpl(url, {
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
          // Hotlink checks expect the page the image belongs to.
          ...(item.url ? { Referer: `${new URL(item.url).origin}/` } : {}),
        },
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) continue;

      const declared = Number(res.headers.get('content-length') || 0);
      if (declared > maxBytes) continue;
      const body = Buffer.from(await res.arrayBuffer());
      if (!body.length || body.length > maxBytes || used + body.length > totalBytes) continue;

      const type =
        (res.headers.get('content-type') || '').split(';')[0].trim() ||
        IMAGE_TYPES[(url.split('?')[0].split('.').pop() || '').toLowerCase()] ||
        'image/jpeg';
      if (!type.startsWith('image/')) continue;

      const cid = `art-${index + 1}@art-digest`;
      attachments.push({ cid, type, body, filename: `art-${index + 1}.${type.split('/')[1] || 'jpg'}` });
      byItem.set(item.id ?? item.url, cid);
      used += body.length;
    } catch {
      // One unreachable thumbnail is not worth failing the digest over; the
      // card falls back to the remote URL.
    }
  }

  return { attachments, bytes: used, srcFor: (item) => {
    const cid = byItem.get(item.id ?? item.url);
    return cid ? `cid:${cid}` : '';
  } };
}

/* ---------------------------------------------------------------- message */

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const wrap = (text) => b64(text).replace(/(.{76})/g, '$1\r\n');
/** RFC 2047, so emoji and non-Latin titles survive the subject line. */
const encodeHeader = (text) =>
  /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${b64(text)}?=`;

export function plainTextDigest(digest) {
  const lines = [
    `Today's best new digital art — ${digest.items.length} picks${digest.nsfwCount ? ` (${digest.nsfwCount} marked 18+)` : ''}`,
    '',
  ];
  digest.items.forEach((item, i) => {
    lines.push(
      `${i + 1}. ${item.title}${item.artist ? ` — ${item.artist}` : ''}${item.nsfw ? ' [18+]' : ''}`,
      `   ${digest.sourceLabels?.[item.source] || item.source} · ${item.scoreLabel} · heat ${item.heat}`,
      `   ${item.url}`,
      ''
    );
  });
  const trouble = (digest.sources || []).filter((s) => s.status !== 'ok');
  if (trouble.length) {
    lines.push(`Unavailable in this run: ${trouble.map((s) => s.label).join(', ')}`, '');
  }
  lines.push(`All of it, filterable: ${SITE}`);
  return lines.join('\n');
}

export function buildMessage({ digest, html, from, fromName, to, date = new Date(), attachments = [] }) {
  const alt = `=_alt_${randomUUID()}`;
  const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

  const body = [
    `--${alt}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(plainTextDigest(digest)),
    `--${alt}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(html),
    `--${alt}--`,
  ];

  const headers = [
    `From: ${encodeHeader(fromName)} <${from}>`,
    `To: ${to}`,
    `Subject: ${encodeHeader(`🎨 Today's best new digital art — ${digest.items.length} picks (${day})`)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${randomUUID()}@art-digest>`,
    'MIME-Version: 1.0',
  ];

  if (!attachments.length) {
    return [...headers, `Content-Type: multipart/alternative; boundary="${alt}"`, '', ...body, ''].join('\r\n');
  }

  // The pictures belong to the HTML part rather than being separate downloads,
  // which is what multipart/related means and what makes them render inline.
  const rel = `=_rel_${randomUUID()}`;
  return [
    ...headers,
    `Content-Type: multipart/related; type="multipart/alternative"; boundary="${rel}"`,
    '',
    `--${rel}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    ...body,
    ...attachments.flatMap((file) => [
      `--${rel}`,
      `Content-Type: ${file.type}`,
      'Content-Transfer-Encoding: base64',
      `Content-ID: <${file.cid}>`,
      `Content-Disposition: inline; filename="${file.filename}"`,
      '',
      file.body.toString('base64').replace(/(.{76})/g, '$1\r\n'),
    ]),
    `--${rel}--`,
    '',
  ].join('\r\n');
}

/* ------------------------------------------------------------------- smtp */

/** Minimal SMTP over implicit TLS: greeting, EHLO, AUTH LOGIN, MAIL/RCPT/DATA. */
export async function sendSmtp({ host, port, user, pass, from, to, message, timeout = 30_000, tlsOptions = {} }) {
  const socket = connect({ host, port, servername: host, ...tlsOptions });
  socket.setEncoding('utf8');

  let buffer = '';
  let waiting = null;
  const complete = () => /(?:^|\n)\d{3} [^\n]*\n$/.test(buffer);

  socket.on('data', (chunk) => {
    buffer += chunk;
    if (waiting && complete()) {
      const response = buffer;
      buffer = '';
      const { resolve } = waiting;
      waiting = null;
      resolve(response);
    }
  });

  const fail = (err) => {
    if (waiting) waiting.reject(err);
    waiting = null;
  };
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('SMTP connection closed early')));
  socket.setTimeout(timeout, () => fail(new Error('SMTP timed out')));

  const read = () =>
    new Promise((resolve, reject) => {
      if (complete()) {
        const response = buffer;
        buffer = '';
        resolve(response);
        return;
      }
      waiting = { resolve, reject };
    });

  const say = async (line, expect, redact = false) => {
    socket.write(`${line}\r\n`);
    const response = await read();
    const code = Number(response.trim().split(/\r?\n/).at(-1).slice(0, 3));
    if (!expect.includes(code)) {
      throw new Error(`SMTP ${redact ? '<credentials>' : line.split(':')[0]} → ${response.trim()}`);
    }
    return response;
  };

  try {
    await read(); // 220 greeting
    await say(`EHLO ${host}`, [250]);
    await say('AUTH LOGIN', [334]);
    await say(b64(user), [334], true);
    await say(b64(pass), [235], true);
    await say(`MAIL FROM:<${from}>`, [250]);
    await say(`RCPT TO:<${to}>`, [250, 251]);
    await say('DATA', [354]);
    // Dot-stuffing: a lone "." would end the message early.
    socket.write(`${message.replace(/\r\n\./g, '\r\n..')}\r\n.\r\n`);
    const result = await read();
    if (!/^2\d\d/m.test(result.trim())) throw new Error(`SMTP DATA → ${result.trim()}`);
    socket.write('QUIT\r\n');
    return result.trim();
  } finally {
    socket.end();
  }
}

/* ------------------------------------------------------------------- main */

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const digest = JSON.parse(await readFile(join(DATA, 'latest.json'), 'utf8'));
  const html = await readFile(join(DATA, 'email.html'), 'utf8');

  const user = process.env.DIGEST_SMTP_USER;
  const pass = process.env.DIGEST_SMTP_PASS;
  const to = process.env.DIGEST_TO || user;

  const ageHours = (Date.now() - Date.parse(digest.generatedAt)) / 3.6e6;
  if (ageHours > 48) {
    console.error(`Digest is ${Math.round(ageHours)}h old; refusing to send stale art.`);
    process.exitCode = 1;
    return;
  }
  if (!digest.items.length) {
    console.error('Digest is empty; nothing to send.');
    process.exitCode = 1;
    return;
  }

  // Carry the pictures in the message rather than asking the reader's mail
  // client to fetch them; anything that won't download keeps its remote URL.
  const inline = process.env.DIGEST_INLINE_IMAGES === 'off'
    ? { attachments: [], bytes: 0, srcFor: () => '' }
    : await collectInlineImages(digest.items);
  const body = inline.attachments.length
    ? renderEmail(digest, { imageSrc: inline.srcFor })
    : html;
  console.log(
    `${inline.attachments.length} of ${digest.items.length} thumbnails attached inline (${Math.round(inline.bytes / 1024)} KB)`
  );

  const message = buildMessage({
    digest,
    html: body,
    from: user || 'art-digest@localhost',
    fromName: process.env.DIGEST_FROM_NAME || 'Daily Art Digest',
    to: to || 'nobody@localhost',
    attachments: inline.attachments,
  });

  if (dryRun || !user || !pass) {
    console.log(
      dryRun
        ? '--dry-run: not sending. Message follows.\n'
        : 'DIGEST_SMTP_USER / DIGEST_SMTP_PASS are not set, so no email was sent.\n' +
            'See art-digest/README.md to turn the daily email on. Preview:\n'
    );
    console.log(plainTextDigest(digest));
    if (dryRun) console.log(`\n--- headers ---\n${message.slice(0, message.indexOf('\r\n\r\n'))}`);
    return;
  }

  const result = await sendSmtp({
    host: process.env.DIGEST_SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.DIGEST_SMTP_PORT) || 465,
    user,
    pass,
    from: user,
    to,
    message,
  });
  console.log(`Sent ${digest.items.length} picks to ${to} (${result})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
