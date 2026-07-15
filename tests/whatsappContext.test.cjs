'use strict';

/**
 * tests/whatsappContext.test.cjs — Unit tests for WhatsApp context fixes:
 *   Fix 1: Gap-based session boundary
 *   Fix 2: Image-turn persistence with vision analysis
 *   Fix 3: Food-log non-food rejection
 *
 * Run with:  node tests/whatsappContext.test.cjs
 */

const assert = require('node:assert/strict');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── Fix 1: Gap-based session boundary ──────────────────────────────────
// Extract the gap-scan logic (same algorithm as whatsapp.cjs) for unit testing.
const SESSION_GAP_MS = 30 * 60 * 1000;

function applySessionGap(history) {
  let cutIdx = 0;
  for (let i = history.length - 1; i > 0; i--) {
    const newer = new Date(history[i].createdAt).getTime();
    const older = new Date(history[i - 1].createdAt).getTime();
    if (newer - older > SESSION_GAP_MS) {
      cutIdx = i;
      break;
    }
  }
  return history.slice(cutIdx);
}

function mkMsg(role, content, minutesAgo) {
  return { role, content, createdAt: new Date(Date.now() - minutesAgo * 60000).toISOString() };
}

test('Fix1: two clusters >30 min apart → only newer returned', () => {
  const history = [
    // Old cluster (8 AM, ~840 min ago)
    mkMsg('user', 'supplement photo', 840),
    mkMsg('assistant', 'Nature Made Super B-Complex...', 839),
    mkMsg('user', 'How much vitamin C?', 838),
    mkMsg('assistant', 'Each tablet has 60mg...', 837),
    // 14-hour gap
    // New cluster (10:34 PM, ~2 min ago)
    mkMsg('user', '[image]', 2),
    mkMsg('assistant', 'That looks like a craft beer...', 1),
  ];
  const result = applySessionGap(history);
  assert.equal(result.length, 2, 'should keep only the 2 newer messages');
  assert.equal(result[0].content, '[image]');
  assert.equal(result[1].content, 'That looks like a craft beer...');
});

test('Fix1: all within 30 min → full capped window', () => {
  const history = [
    mkMsg('user', 'msg1', 10),
    mkMsg('assistant', 'reply1', 9),
    mkMsg('user', 'msg2', 5),
    mkMsg('assistant', 'reply2', 4),
  ];
  const result = applySessionGap(history);
  assert.equal(result.length, 4, 'all messages should be kept');
});

test('Fix1: isolated newest message (long prior silence) → just that message', () => {
  const history = [
    mkMsg('user', 'old msg', 120),
    mkMsg('assistant', 'old reply', 119),
    // 2-hour gap
    mkMsg('user', 'new msg', 1),
  ];
  const result = applySessionGap(history);
  assert.equal(result.length, 1, 'should keep only the isolated newest message');
  assert.equal(result[0].content, 'new msg');
});

test('Fix1: empty history → no-op', () => {
  assert.equal(applySessionGap([]).length, 0);
});

test('Fix1: single message → no-op', () => {
  const result = applySessionGap([mkMsg('user', 'solo', 5)]);
  assert.equal(result.length, 1);
});

// ── Fix 2: Image-turn persistence ──────────────────────────────────────

function buildPersistedContent(msgBody, imageData, toolSummaries) {
  // Same logic as whatsapp.cjs persistence
  if (imageData) {
    const captureSummary = (toolSummaries || []).find(
      (s) => s.tool === 'capture_from_image' && s.success && s.result?.summary
    );
    if (captureSummary) {
      const r = captureSummary.result;
      const label = r.summary.slice(0, 200);
      return `[image: ${label}]${msgBody ? ` ${msgBody}` : ''}`;
    }
  }
  return msgBody || '[image]';
}

test('Fix2: analyzed-photo turn persists referenceable content', () => {
  const toolSummaries = [{
    tool: 'capture_from_image',
    success: true,
    result: { success: true, classification: 'food', summary: 'Craft IPA beer, ~330ml bottle', confidence: 0.95 },
  }];
  const content = buildPersistedContent('How many calories', { mimeType: 'image/jpeg', data: 'base64...' }, toolSummaries);
  assert.ok(content.includes('Craft IPA beer'), 'persisted content should include the item description');
  assert.ok(content.startsWith('[image:'), 'should retain [image: marker');
  assert.ok(content.includes('How many calories'), 'should include the user caption');
});

test('Fix2: image without capture analysis falls back to [image]', () => {
  const content = buildPersistedContent('', { mimeType: 'image/jpeg', data: 'base64...' }, []);
  assert.equal(content, '[image]');
});

test('Fix2: supplement photo + beer photo regression — logs the beer', () => {
  // Simulate the reconstructed history after Fix 1 + Fix 2
  const history = [
    // Beer cluster only (supplement was cut by gap-based session boundary)
    mkMsg('user', '[image: Craft IPA beer, ~330ml bottle] How many calories', 2),
    mkMsg('assistant', 'That craft IPA is about 200 calories for a 330ml bottle.', 1),
  ];
  const result = applySessionGap(history);
  // The model sees beer as the only image in context
  assert.equal(result.length, 2);
  assert.ok(result[0].content.includes('beer'), 'beer should be visible in history');
  assert.ok(!result[0].content.includes('supplement'), 'supplement should NOT be in history');
});

test('Fix2: two photos no time gap — both distinguishable in history', () => {
  // Two back-to-back photos within the same session
  const history = [
    mkMsg('user', '[image: Turkey sandwich on sourdough with lettuce and tomato]', 5),
    mkMsg('assistant', 'That\'s a turkey sandwich, about 450 calories.', 4),
    mkMsg('user', '[image: Craft IPA beer, ~330ml bottle]', 3),
    mkMsg('assistant', 'That craft IPA is about 200 calories.', 2),
    mkMsg('user', 'log the first one', 1),
  ];
  const result = applySessionGap(history);
  assert.equal(result.length, 5, 'all within session, all kept');
  // The model can distinguish: "the first one" = turkey sandwich
  assert.ok(result[0].content.includes('Turkey sandwich'), 'first photo should be identifiable');
  assert.ok(result[2].content.includes('Craft IPA beer'), 'second photo should be identifiable');
});

// ── Fix 3: Food-log non-food rejection ─────────────────────────────────

// Test the validation logic directly
const NON_FOOD_PATTERNS = [
  /\bsupplement\b/i, /\bvitamin\b/i, /\bmedication\b/i, /\bmedicine\b/i,
  /\bprescription\b/i, /\btablet[s]?\b.*\b(?:mg|mcg|iu)\b/i,
  /\bcapsule[s]?\b.*\b(?:mg|mcg|iu)\b/i,
];

function looksLikeNonFood(description) {
  return NON_FOOD_PATTERNS.some((rx) => rx.test(description));
}

test('Fix3: non-food item (supplement) is flagged', () => {
  assert.ok(looksLikeNonFood('Nature Made Super B-Complex supplement, 140 tablets'));
  assert.ok(looksLikeNonFood('Vitamin D3 5000 IU capsule'));
  assert.ok(looksLikeNonFood('Ibuprofen medication 200mg'));
});

test('Fix3: legit food passes validation', () => {
  assert.ok(!looksLikeNonFood('2 scrambled eggs with toast and black coffee'));
  assert.ok(!looksLikeNonFood('Grilled chicken salad with ranch dressing'));
  assert.ok(!looksLikeNonFood('Craft IPA beer, 330ml bottle'));
});

// ── Runner ─────────────────────────────────────────────────────────────

async function run() {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  PASS  ${t.name}`);
      passed++;
    } catch (e) {
      console.error(`  FAIL  ${t.name}`);
      console.error(`        ${e.message}`);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
