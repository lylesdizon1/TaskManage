'use strict';

/**
 * tests/isolation.test.cjs — Two-user cross-tenant isolation regression suite.
 *
 * Fails loudly if any shared DB helper forgets `WHERE user_id = $1`. Runs
 * directly against the same pg pool production uses, against whatever
 * DATABASE_URL is in the environment.
 *
 * Seeds two isolated users, populates userA with one of each
 * user-scoped record, asserts userB sees none of it, asserts userA (even
 * with admin role) only sees their own, then tears everything down.
 *
 * Run with:
 *   npm test
 *   # or
 *   node tests/isolation.test.cjs
 *
 * Exits non-zero on any assertion failure.
 */

const assert = require('node:assert/strict');
const db = require('../db.cjs');
const { requireOwnership } = require('../server/middleware/auth.cjs');

// Helpers — simple test runner so we don't take a dependency on jest/vitest.
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

async function run() {
  let passed = 0;
  let failed = 0;
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

// Stable suffix so repeated runs don't collide but are cleanable.
const SUFFIX = `iso${Date.now().toString(36)}`;
const userA = { id: `test-userA-${SUFFIX}`, username: `userA-${SUFFIX}`, email: `a-${SUFFIX}@test.local` };
const userB = { id: `test-userB-${SUFFIX}`, username: `userB-${SUFFIX}`, email: `b-${SUFFIX}@test.local` };

const entityA      = { id: `test-entity-A-${SUFFIX}`, name: `Entity-A-${SUFFIX}` };
const taskA        = { id: `test-task-A-${SUFFIX}`,   title: `Task-A-${SUFFIX}` };
const noteA        = { id: `test-note-A-${SUFFIX}`,   title: `Note-A-${SUFFIX}` };
const accountA     = { id: `test-fin-A-${SUFFIX}`,    name: `Acct-A-${SUFFIX}` };
let   conversationA = null; // id assigned after insert

async function setup() {
  // Seed users — admin role on userA to prove the layer doesn't leak.
  await db.upsertUser({ id: userA.id, username: userA.username, displayName: 'Test A', passwordHash: 'x', email: userA.email, role: 'admin',  entityIds: [] });
  await db.upsertUser({ id: userB.id, username: userB.username, displayName: 'Test B', passwordHash: 'x', email: userB.email, role: 'member', entityIds: [] });

  await db.createEntity({ id: entityA.id, name: entityA.name, color: '#4f4dcf', createdBy: userA.id, type: 'business', parentId: null, shared: false });

  await db.upsertTask({ id: taskA.id, title: taskA.title, description: '', priority: 'medium', status: 'pending',
    dueDate: '', dueTime: null, tags: [], visibility: 'private', completed: false, owner: userA.id, createdBy: userA.id });

  await db.createNote({ id: noteA.id, userId: userA.id, title: noteA.title, content: 'private body',
    visibility: 'private', type: 'quick', pillar: null, category: '', subcategory: '', tags: [], entityId: null });

  await db.createFinancialAccount({ id: accountA.id, userId: userA.id, name: accountA.name,
    type: 'checking', institution: 'Test Bank', currency: 'USD', entityId: null, accountClass: 'personal' });

  const conv = await db.createConversation(userA.id, 'claude');
  conversationA = conv?.id;
}

async function teardown() {
  // Best-effort cleanup. ON DELETE CASCADE from users should sweep most
  // children, but explicit deletes keep the test durable against schema
  // drift.
  const pool = db.pool;
  if (conversationA) { try { await pool.query('DELETE FROM conversations WHERE id = $1', [conversationA]); } catch {} }
  try { await pool.query('DELETE FROM financial_accounts WHERE id = $1', [accountA.id]); } catch {}
  try { await pool.query('DELETE FROM notes WHERE id = $1', [noteA.id]); } catch {}
  try { await pool.query('DELETE FROM tasks WHERE id = $1', [taskA.id]); } catch {}
  try { await pool.query('DELETE FROM entities WHERE id = $1', [entityA.id]); } catch {}
  try { await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [userA.id, userB.id]); } catch {}
  try { await pool.end(); } catch {}
}

// ── Tests — userB sees none of userA's data ────────────────────────────────

test('userB GET entities → no userA entities', async () => {
  const rows = await db.getEntitiesForUser(userB.id);
  assert.equal(rows.some((e) => e.id === entityA.id), false, `userB leaked entity via getEntitiesForUser ${entityA.id}`);

  // Also verify the Phase 2 canonical access helper is scoped the same way.
  // userB has no org → null orgId; userA's private entity must not surface
  // via the creator / org / members branches.
  const rowsWM = await db.getEntitiesForUserWithMembership(userB.id, null);
  assert.equal(rowsWM.some((e) => e.id === entityA.id), false, `userB leaked entity via getEntitiesForUserWithMembership ${entityA.id}`);
});

test('userB GET tasks → no userA tasks', async () => {
  const rows = await db.getTasksForUser(userB.id, []);
  assert.equal(rows.some((t) => t.id === taskA.id), false, `userB leaked task ${taskA.id}`);
});

test('userB GET notes → no userA notes', async () => {
  const rows = await db.getPrivateNotesForAI(userB.id);
  assert.equal(rows.some((n) => n.id === noteA.id), false, `userB leaked note ${noteA.id}`);
});

test('userB GET financial accounts → no userA accounts', async () => {
  const rows = await db.getFinancialAccounts(userB.id);
  assert.equal(rows.some((a) => a.id === accountA.id), false, `userB leaked financial_account ${accountA.id}`);
});

test('userB GET conversations → no userA conversations', async () => {
  const rows = await db.getConversations(userB.id);
  assert.equal(rows.some((c) => c.id === conversationA), false, `userB leaked conversation ${conversationA}`);
});

// ── Tests — userA (admin) still only sees own data ─────────────────────────

test('userA (admin) GET entities → only own entity visible', async () => {
  const rows = await db.getEntitiesForUser(userA.id);
  assert.ok(rows.some((e) => e.id === entityA.id), 'userA should see their own entity');
  // Should not surface entities belonging to non-userA (role=admin must not leak).
  assert.equal(rows.every((e) => e.createdBy === userA.id || e.shared === true), true,
    'admin path leaked non-own, non-shared entity');
});

test('userA (admin) GET tasks → only own tasks visible', async () => {
  const rows = await db.getTasksForUser(userA.id, []);
  assert.ok(rows.some((t) => t.id === taskA.id), 'userA should see their own task');
  assert.equal(rows.every((t) => t.owner === userA.id), true,
    'admin path leaked task belonging to another user');
});

// ── Tests — admin cannot mutate another user's data via requireOwnership ──
// Guards against regression of the P0 fix to server/middleware/auth.cjs,
// where the helper used to return true for any admin regardless of the
// actual owner field. Feeds the helper a realistic record shape owned by
// userB and a req object shaped like userA-the-admin.

test('requireOwnership: userA admin CANNOT mutate userB-owned note', async () => {
  const noteOwnedByB = { id: noteA.id, user_id: userB.id, title: 'B note' };
  const reqAdminA = { user: { id: userA.id, role: 'admin', entityIds: [] } };
  assert.equal(requireOwnership(noteOwnedByB, reqAdminA), false,
    'admin must not pass requireOwnership on another user\'s note');
});

test('requireOwnership: userA superadmin CANNOT mutate userB-owned note', async () => {
  const noteOwnedByB = { id: noteA.id, user_id: userB.id, title: 'B note' };
  const reqSuperA = { user: { id: userA.id, role: 'superadmin', entityIds: [] } };
  assert.equal(requireOwnership(noteOwnedByB, reqSuperA), false,
    'superadmin must not pass requireOwnership on another user\'s note');
});

test('requireOwnership: owner still passes', async () => {
  const noteOwnedByB = { id: noteA.id, user_id: userB.id, title: 'B note' };
  const reqUserB = { user: { id: userB.id, role: 'member', entityIds: [] } };
  assert.equal(requireOwnership(noteOwnedByB, reqUserB), true,
    'owner must pass requireOwnership');
});

// ── Tests — mutation SQL enforces user scoping (belt-and-suspenders) ──
// The note seeded in setup() is owned by userA (createNote({userId: userA.id,...})).
// Actually setup() creates noteA under userA.id, so userB (as admin) attacking
// should fail. Test: fake "admin" pretending to update userB-owned note by
// passing userB.id as target — but our userA has admin role, so we simulate a
// request where userA (admin) tries to mutate the note of userB by passing
// userA.id as userId. The SQL must return null / 0 rows.

test('updateNote: userA admin CANNOT mutate userB-owned note (SQL scoping)', async () => {
  // Create a note owned by userB for this test.
  const attackNoteId = `test-attack-note-${SUFFIX}`;
  await db.createNote({
    id: attackNoteId, userId: userB.id, title: 'B-private', content: 'do not mutate',
    visibility: 'private', type: 'quick', pillar: null, category: '', subcategory: '', tags: [], entityId: null,
  });
  try {
    // userA (admin) attempts to mutate: passes own id as userId to updateNote,
    // expecting the SQL's `AND user_id = $2` to reject.
    const updated = await db.updateNote(attackNoteId, userA.id, { title: 'pwned-by-admin' });
    assert.equal(updated, null, 'updateNote must return null when userId does not match note.user_id');

    // Verify the row is still intact.
    const row = await db.getNoteById(attackNoteId, userB.id);
    assert.ok(row, 'userB should still be able to fetch their own note');
    assert.equal(row.title, 'B-private', 'note title must not have been mutated');
  } finally {
    try { await db.pool.query('DELETE FROM notes WHERE id = $1', [attackNoteId]); } catch {}
  }
});

test('deleteNote: userA admin CANNOT delete userB-owned note (SQL scoping)', async () => {
  const attackNoteId = `test-attack-note-del-${SUFFIX}`;
  await db.createNote({
    id: attackNoteId, userId: userB.id, title: 'B-delete-target', content: 'hands off',
    visibility: 'private', type: 'quick', pillar: null, category: '', subcategory: '', tags: [], entityId: null,
  });
  try {
    // userA (admin) tries to delete userB's note by passing own id.
    await db.deleteNote(attackNoteId, userA.id);

    // The note must still exist for userB.
    const row = await db.getNoteById(attackNoteId, userB.id);
    assert.ok(row, 'deleteNote with wrong userId must not remove the row');
    assert.equal(row.id, attackNoteId, 'the original note must still be present');
  } finally {
    try { await db.pool.query('DELETE FROM notes WHERE id = $1', [attackNoteId]); } catch {}
  }
});

// ── Runner ─────────────────────────────────────────────────────────────────

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set — skipping isolation tests.');
    process.exit(0);
  }
  console.log(`\nisolation tests (suffix=${SUFFIX})\n`);
  let failed = 1;
  try {
    await setup();
    failed = await run();
  } catch (err) {
    console.error('Setup/run failed:', err.message);
  } finally {
    await teardown();
  }
  process.exit(failed > 0 ? 1 : 0);
})();
