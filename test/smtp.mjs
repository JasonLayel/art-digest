/**
 * End-to-end test of the mail path: runs a throwaway TLS SMTP server, sends a
 * digest through send-email.mjs, and checks what the server received.
 *
 *   node art-digest/test/smtp.mjs
 *
 * Needs a certificate; generate one anywhere and point CERT_DIR at it:
 *   openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=localhost \
 *     -keyout key.pem -out cert.pem
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:tls';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildMessage, plainTextDigest, sendSmtp } from '../send-email.mjs';

const CERT_DIR = process.env.CERT_DIR;
if (!CERT_DIR) {
  console.log('CERT_DIR not set — skipping the SMTP round-trip test.');
  process.exit(0);
}

const digest = {
  generatedAt: new Date().toISOString(),
  sourceLabels: { pixiv: 'Pixiv', reddit: 'Reddit' },
  sources: [
    { id: 'pixiv', label: 'Pixiv', status: 'ok', kept: 2 },
    { id: 'deviantart', label: 'DeviantArt', status: 'failed', kept: 0 },
  ],
  items: [
    { source: 'pixiv', title: '夜明けの街角', artist: 'kaze', url: 'https://www.pixiv.net/artworks/1', scoreLabel: '18.4k bookmarks', heat: 99 },
    // A line that is just a dot must survive SMTP's end-of-message marker.
    { source: 'reddit', title: '.', artist: 'u/dot', url: 'https://www.reddit.com/r/Art/comments/2/', scoreLabel: '900 upvotes', heat: 80 },
  ],
};

const received = { commands: [], message: '' };

const server = createServer(
  {
    key: await readFile(join(CERT_DIR, 'key.pem')),
    cert: await readFile(join(CERT_DIR, 'cert.pem')),
  },
  (socket) => {
    let inData = false;
    let body = '';
    socket.setEncoding('utf8');
    socket.write('220 test-smtp ready\r\n');
    socket.on('data', (chunk) => {
      if (inData) {
        body += chunk;
        if (body.includes('\r\n.\r\n')) {
          received.message = body.slice(0, body.indexOf('\r\n.\r\n'));
          inData = false;
          socket.write('250 2.0.0 OK queued\r\n');
        }
        return;
      }
      for (const line of chunk.split('\r\n').filter(Boolean)) {
        received.commands.push(line);
        if (/^EHLO/i.test(line)) socket.write('250-test-smtp\r\n250 AUTH LOGIN\r\n'); // multi-line reply
        else if (/^AUTH LOGIN/i.test(line)) socket.write('334 VXNlcm5hbWU6\r\n');
        else if (/^MAIL FROM/i.test(line)) socket.write('250 2.1.0 OK\r\n');
        else if (/^RCPT TO/i.test(line)) socket.write('250 2.1.5 OK\r\n');
        else if (/^DATA/i.test(line)) {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (/^QUIT/i.test(line)) socket.write('221 Bye\r\n');
        else if (received.commands.filter((c) => !/^(EHLO|AUTH|MAIL|RCPT|DATA|QUIT)/i.test(c)).length === 1)
          socket.write('334 UGFzc3dvcmQ6\r\n'); // username accepted, ask for password
        else socket.write('235 2.7.0 Accepted\r\n');
      }
    });
  }
);

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

// A one-pixel PNG standing in for a downloaded thumbnail.
const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const attachments = [
  { cid: 'art-1@art-digest', type: 'image/png', body: pixel, filename: 'art-1.png' },
  { cid: 'art-2@art-digest', type: 'image/png', body: pixel, filename: 'art-2.png' },
];

const message = buildMessage({
  digest,
  html: '<html><body><h1>digest</h1><img src="cid:art-1@art-digest"><img src="cid:art-2@art-digest"></body></html>',
  from: 'sender@example.com',
  fromName: 'Daily Art Digest',
  to: 'reader@example.com',
  attachments,
});

const result = await sendSmtp({
  host: '127.0.0.1',
  port,
  user: 'sender@example.com',
  pass: 'app-password',
  from: 'sender@example.com',
  to: 'reader@example.com',
  message,
  tlsOptions: { rejectUnauthorized: false },
});

server.close();

const decodePart = (type) => {
  const part = received.message.split(/--=_(?:alt|rel)_[^\r\n]*/).find((p) => p.includes(`Content-Type: ${type}`));
  assert.ok(part, `${type} part is present`);
  const body = part.slice(part.indexOf('\r\n\r\n') + 4).replace(/\s/g, '');
  return Buffer.from(body, 'base64');
};

const checks = [
  ['server accepted the message', () => assert.match(result, /250/)],
  ['authenticated with base64 credentials', () => {
    assert.ok(received.commands.includes('AUTH LOGIN'));
    assert.ok(received.commands.includes(Buffer.from('sender@example.com').toString('base64')));
    assert.ok(received.commands.includes(Buffer.from('app-password').toString('base64')));
  }],
  ['envelope addresses are set', () => {
    assert.ok(received.commands.includes('MAIL FROM:<sender@example.com>'));
    assert.ok(received.commands.includes('RCPT TO:<reader@example.com>'));
  }],
  ['subject survives emoji as encoded-words', () => {
    const subject = received.message.match(/^Subject: (.*)$/m)[1];
    assert.match(subject, /^=\?UTF-8\?B\?/);
    assert.match(Buffer.from(subject.slice(10, -2), 'base64').toString('utf8'), /🎨 Today's best new digital art — 2 picks/);
  }],
  ['the message is multipart/related so the pictures belong to the HTML', () => {
    assert.match(received.message, /Content-Type: multipart\/related; type="multipart\/alternative"/);
    assert.match(received.message, /Content-Type: multipart\/alternative/);
  }],
  ['each image rides along as an inline part the HTML points at', () => {
    for (const file of attachments) {
      assert.ok(received.message.includes(`Content-ID: <${file.cid}>`), `${file.cid} is attached`);
      assert.ok(received.message.includes(`Content-Disposition: inline; filename="${file.filename}"`));
      assert.ok(decodePart('text/html').toString('utf8').includes(`cid:${file.cid}`), 'and the HTML references it');
    }
    // The bytes survive the trip: the part decodes back to the exact PNG.
    const part = received.message.split(/--=_rel_[^\r\n]*/).find((p) => p.includes('Content-ID: <art-1@art-digest>'));
    const body = part.slice(part.indexOf('\r\n\r\n') + 4).replace(/\s/g, '');
    assert.ok(Buffer.from(body, 'base64').equals(pixel), 'the image arrives byte for byte');
  }],
  ['both alternatives are present and decode', () => {
    const text = decodePart('text/plain').toString('utf8');
    const html = decodePart('text/html').toString('utf8');
    assert.match(text, /1\. 夜明けの街角 — kaze/);
    assert.match(text, /Unavailable in this run: DeviantArt/);
    assert.match(text, /https:\/\/www\.pixiv\.net\/artworks\/1/);
    assert.match(html, /<h1>digest<\/h1>/);
  }],
  ['a line that is only a dot is stuffed, not treated as end-of-message', () => {
    assert.ok(plainTextDigest(digest).includes('\n2. .'), 'the fixture really does contain a bare dot line');
    assert.match(decodePart('text/plain').toString('utf8'), /2\. \. — u\/dot/, 'and it arrives intact');
  }],
];

let failed = 0;
for (const [name, check] of checks) {
  try {
    check();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✕ ${name}\n    ${err.message}`);
  }
}
console.log(`\n${checks.length - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
