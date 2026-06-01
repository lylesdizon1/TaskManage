#!/usr/bin/env node
'use strict';

/**
 * scripts/migrate-cc-daily.cjs — ONE-TIME cleanup for the Command Center
 * daily-thread model. NOT wired into runMigrations(); run manually, gated.
 *
 * What it does (under --execute, transaction-wrapped):
 *   1. Backfill chat_conversations.cc_date for command_center rows from
 *      created_at → the OWNER'S LOCAL date (AT TIME ZONE the user's tz; never
 *      UTC). Idempotent (NULLs only).
 *   2. For each (user_id, cc_date) group with >1 command_center conversation,
 *      pick the OLDEST as the survivor, RE-PARENT every message from the others
 *      into it (UPDATE chat_messages SET conversation_id = <survivor>), then
 *      DELETE only the now-empty shells. Cross-day conversations stay separate.
 *      ZERO message deletion — messages are moved, never dropped.
 *   3. Create the partial unique index idx_cc_daily_conv (user_id, cc_date)
 *      WHERE type='command_center' (now collision-free).
 *
 * SAFETY:
 *   - Default is --dry-run: reports counts only, makes ZERO changes.
 *   - A real run requires the explicit --execute flag and runs in ONE
 *     transaction (rolls back on any error).
 *   - Re-runnable: after a clean run, groups are size 1 → no-op.
 *
 * Usage (with prod env injected, e.g. via `railway run`):
 *   node scripts/migrate-cc-daily.cjs              # dry-run (safe)
 *   node scripts/migrate-cc-daily.cjs --execute    # apply (transaction-wrapped)
 */

const { Pool } = require('pg');

const EXECUTE = process.argv.includes('--execute');
const DEFAULT_TZ = 'America/Los_Angeles';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : undefined,
});

// One row per command_center conversation with its effective LOCAL cc_date,
// ordered so the OLDEST per (user, day) comes first (the survivor).
const SCAN_SQL = `
  SELECT c.id,
         c.user_id,
         (c.created_at AT TIME ZONE COALESCE(u.timezone, $1))::date::text AS d,
         c.created_at,
         c.cc_date,
         (SELECT COUNT(*)::int FROM chat_messages m WHERE m.conversation_id = c.id) AS msg_count
  FROM chat_conversations c
  JOIN users u ON u.id = c.user_id
  WHERE c.type = 'command_center'
  ORDER BY c.user_id, d, c.created_at ASC
`;

async function main() {
  const mode = EXECUTE ? 'EXECUTE' : 'DRY-RUN';
  console.log(`\n[migrate-cc-daily] mode=${mode}\n`);

  const { rows } = await pool.query(SCAN_SQL, [DEFAULT_TZ]);
  console.log(`command_center conversations scanned: ${rows.length}`);
  const nullCcDate = rows.filter((r) => r.cc_date == null).length;
  console.log(`  rows with NULL cc_date (would backfill): ${nullCcDate}`);

  // Group by (user_id, effective date).
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.user_id}|${r.d}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r); // already oldest-first
  }

  const multi = [...groups.values()].filter((g) => g.length > 1);
  let shellsToDelete = 0;
  let messagesToReparent = 0;
  const plan = []; // { survivorId, loserIds: [], movedMsgs }
  for (const g of multi) {
    const [survivor, ...losers] = g;
    const moved = losers.reduce((n, r) => n + r.msg_count, 0);
    shellsToDelete += losers.length;
    messagesToReparent += moved;
    plan.push({ survivorId: survivor.id, loserIds: losers.map((r) => r.id), movedMsgs: moved });
  }

  console.log(`\n(user, day) groups with >1 conversation: ${multi.length}`);
  console.log(`  messages that WOULD re-parent: ${messagesToReparent}`);
  console.log(`  empty shells that WOULD delete (after re-parent): ${shellsToDelete}`);
  console.log(`  (zero messages are ever deleted — only moved)\n`);

  if (!EXECUTE) {
    console.log('DRY-RUN — no changes made. Re-run with --execute to apply.');
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Backfill cc_date (NULLs only).
    const bf = await client.query(
      `UPDATE chat_conversations c
          SET cc_date = (c.created_at AT TIME ZONE COALESCE(u.timezone, $1))::date
         FROM users u
        WHERE c.user_id = u.id AND c.type = 'command_center' AND c.cc_date IS NULL`,
      [DEFAULT_TZ],
    );
    console.log(`backfilled cc_date on ${bf.rowCount} rows`);

    // 2. Merge each group: re-parent messages → survivor, delete empty shells.
    let movedTotal = 0;
    let deletedTotal = 0;
    for (const p of plan) {
      const upd = await client.query(
        `UPDATE chat_messages SET conversation_id = $1 WHERE conversation_id = ANY($2::int[])`,
        [p.survivorId, p.loserIds],
      );
      movedTotal += upd.rowCount;
      // Safety: only delete conversations that are now empty.
      const del = await client.query(
        `DELETE FROM chat_conversations
          WHERE id = ANY($1::int[])
            AND NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.conversation_id = chat_conversations.id)`,
        [p.loserIds],
      );
      deletedTotal += del.rowCount;
    }
    console.log(`re-parented ${movedTotal} messages; deleted ${deletedTotal} empty shells`);

    // 3. Now collision-free → create the partial unique index.
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_daily_conv
         ON chat_conversations(user_id, cc_date) WHERE type = 'command_center'`,
    );
    console.log('created idx_cc_daily_conv');

    await client.query('COMMIT');
    console.log('\nEXECUTE complete — committed.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\nEXECUTE failed — rolled back. No changes applied.\n', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('fatal:', err.message);
  process.exit(1);
});
