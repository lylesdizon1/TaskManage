'use strict';

/**
 * tests/emailBodyExtractor.test.cjs
 *
 * Pure-function tests for the Gmail provider's body-selection heuristic
 * (server/lib/providers/googleEmailProvider.cjs::_extractBody).
 *
 * Three fixture cases per Phase 2 report:
 *   1. Marketing-email-with-noisy-plain → returns HTML
 *   2. Outlook-cid-plain (the Kat Egli regression) → returns HTML
 *   3. Plain-text-only-email-no-html → returns plaintext
 *
 * Plus negative + edge cases that lock the contract.
 *
 * Run with:
 *   npm test
 *   # or directly:
 *   node tests/emailBodyExtractor.test.cjs
 */

// Crypto / google providers in the require chain check for env vars at
// load time. Provide harmless dummy values so the require resolves.
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(32);

const assert = require('node:assert/strict');
const { _extractBody, _cidRefRe } = require('../server/lib/providers/googleEmailProvider.cjs');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

async function run() {
  let passed = 0, failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${t.name}`);
      console.error('    ' + (err.stack || err.message).split('\n').join('\n    '));
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  return failed;
}

// Helpers — Gmail base64url encoding, fixture builders.
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

function multipartAlternative(plain, html) {
  return {
    mimeType: 'multipart/alternative',
    parts: [
      { mimeType: 'text/plain', body: { data: b64(plain) } },
      { mimeType: 'text/html',  body: { data: b64(html) } },
    ],
  };
}

function plainOnly(plain) {
  return { mimeType: 'text/plain', body: { data: b64(plain) } };
}

function htmlOnly(html) {
  return { mimeType: 'text/html', body: { data: b64(html) } };
}

// ── CID detector regex ──────────────────────────────────────────────────
test('CID_REF_RE matches Outlook-style image refs', () => {
  assert.ok(_cidRefRe.test('Hi\n[cid:image001.png@01DCDD74.D9130740]\nThanks'));
  assert.ok(_cidRefRe.test('[cid:logo@example.com]'));
  // Case-insensitive
  assert.ok(_cidRefRe.test('[CID:upper.png@x.com]'));
});

test('CID_REF_RE does not match non-cid bracketed text', () => {
  assert.equal(_cidRefRe.test('See [the docs] for more info'), false);
  assert.equal(_cidRefRe.test('[Click here](https://example.com)'), false);
  assert.equal(_cidRefRe.test('[ ] empty checkbox'), false);
});

// ── Spec test 1: marketing email with noisy plaintext → returns HTML ──
test('marketing email with [link](url) markdown → returns HTML', () => {
  const plain = 'Click [Shop now](https://tracker.example.com/click?id=abc) for 50% off!';
  const html = '<html><body><a href="https://tracker.example.com/click?id=abc">Shop now</a></body></html>';
  const out = _extractBody(multipartAlternative(plain, html));
  assert.ok(out.includes('<html>'), 'expected HTML body');
});

test('marketing email with long tracking URL → returns HTML', () => {
  const longUrl = 'https://email.example.com/u/eJxNkM' + 'x'.repeat(80) + '?utm=tracker';
  const plain = `Hello\n${longUrl}\nThanks`;
  const html = '<p>Hello <a href="' + longUrl + '">click</a></p>';
  const out = _extractBody(multipartAlternative(plain, html));
  assert.ok(out.includes('<p>'), 'expected HTML body');
});

test('marketing email with === separator lines → returns HTML', () => {
  const plain = 'Header\n===========\nBody text\n===========\nFooter';
  const html = '<div>Header</div><hr/><div>Body text</div><hr/><div>Footer</div>';
  const out = _extractBody(multipartAlternative(plain, html));
  assert.ok(out.includes('<div>'), 'expected HTML body');
});

// ── Spec test 2: Outlook-cid plain → returns HTML ──────────────────────
test('Outlook-with-cid plaintext → returns HTML (the Kat Egli regression)', () => {
  const plain = `Hi Lyle,

[cid:image001.png@01DCDD74.D9130740]

Please join us for Rose's 70th birthday at Blackhawk Country Club.

Thanks,
Kat`;
  const html = `<html><body><p>Hi Lyle,</p><img src="cid:image001.png@01DCDD74.D9130740"/><p>Please join us for Rose's 70th birthday at Blackhawk Country Club.</p><p>Thanks,<br/>Kat</p></body></html>`;
  const out = _extractBody(multipartAlternative(plain, html));
  assert.ok(out.includes('<html>'), 'expected HTML body, not plaintext with cid markers');
  assert.ok(!out.includes('[cid:image001'), 'plaintext cid markers should not survive');
});

test('Outlook-with-cid plaintext but NO html alternate → returns plaintext (degenerate fallback)', () => {
  const plain = 'Hi\n[cid:logo.png@x.com]\nBye';
  const out = _extractBody(plainOnly(plain));
  assert.equal(out, plain);
});

// ── Spec test 3: plain-text-only email → returns plaintext ─────────────
test('plain-only email (no html alternate) → returns plaintext', () => {
  const plain = 'Hey, just a quick note. No formatting needed.';
  const out = _extractBody(plainOnly(plain));
  assert.equal(out, plain);
});

test('clean plaintext WITH html alternate (no noise signals) → returns plaintext (current preference)', () => {
  // Clean plain — no md links, no long URLs, no separators, no cid refs.
  // Heuristic returns plaintext per the existing "prefer-plain-when-clean"
  // design. Locks the contract: this fix narrows when plain wins, doesn't
  // flip the default.
  const plain = 'Hi Lyle, just confirming our 3pm meeting tomorrow. Thanks!';
  const html = '<p>Hi Lyle, just confirming our 3pm meeting tomorrow. Thanks!</p>';
  const out = _extractBody(multipartAlternative(plain, html));
  assert.equal(out, plain);
});

// ── HTML-only edge cases ────────────────────────────────────────────────
test('HTML-only email (no plain alternate) → returns HTML', () => {
  const html = '<html><body><h1>Hello</h1></body></html>';
  const out = _extractBody(htmlOnly(html));
  assert.equal(out, html);
});

test('empty payload → empty string', () => {
  assert.equal(_extractBody(null), '');
  assert.equal(_extractBody(undefined), '');
  assert.equal(_extractBody({}), '');
});

test('payload with body.data but no parts → returns body data', () => {
  // Single-part email at the top level (rare but valid).
  const out = _extractBody({ body: { data: b64('plain text top-level') } });
  assert.equal(out, 'plain text top-level');
});

// ── Nested multipart (Outlook-with-attachments) ────────────────────────
test('multipart/related wrapping multipart/alternative → still extracts correctly', () => {
  // Outlook commonly produces this shape when there are inline images:
  // multipart/related
  //   ├ multipart/alternative
  //   │   ├ text/plain
  //   │   └ text/html
  //   └ image/png (inline attachment)
  const plain = 'Body\n[cid:image001@x.com]\n';
  const html = '<p>Body</p><img src="cid:image001@x.com"/>';
  const payload = {
    mimeType: 'multipart/related',
    parts: [
      multipartAlternative(plain, html),
      { mimeType: 'image/png', body: { attachmentId: 'attach123' } },
    ],
  };
  const out = _extractBody(payload);
  assert.ok(out.includes('<p>Body</p>'), 'expected HTML from nested alternative');
  assert.ok(!out.includes('[cid:image001'), 'plaintext cid markers should not survive');
});

run().then((failed) => process.exit(failed > 0 ? 1 : 0)).catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
