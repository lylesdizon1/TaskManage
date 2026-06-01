#!/usr/bin/env node
'use strict';

/**
 * scripts/migrate-cc-daily.cjs — ONE-TIME cleanup for the Command Center
 * daily-thread model. NOT wired into runMigrations(); run manually, gated.
 *
 * SELF-SUFFICIENT: does NOT require the cc_date column to exist yet (it's added
 * by the Commit 1 boot migration, which only runs on deploy — but this cleanup
 * must run BEFORE deploy so the unique index exists before the new getOrCreate
 * code goes live). Both modes derive cc_date in JS via one shared function,
 * `localDateOf()`, which mirrors getTodayLocal (Intl 'en-CA') and Commit 1's
 * SQL backfill `(created_at AT TIME ZONE COALESCE(u.timezone,'…'))::date`.
 *
 * Dry-run (default): loads (id, user_id, created_at, tz) — NO cc_date column
 * reference, ZERO writes — derives cc_date in JS, and reports counts.
 *
 * Execute (--execute): one transaction —
 *   1. ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS cc_date DATE.
 *   2. Backfill cc_date (NULLs only) using the SAME localDateOf() derivation,
 *      so the real backfill matches the dry-run exactly.
 *   3. De-dup: per (user_id, cc_date) keep the OLDEST as survivor, re-parent its
 *      group's messages into it, delete ONLY the now-empty shells. Cross-day
 *      stays separate. ZERO message deletion.
 *   4. CREATE UNIQUE INDEX … (user_id, cc_date) WHERE type='command_center'.
 * Any failure rolls back the whole transaction. Idempotent on re-run.
 *
 * Usage (prod env injected — must reach the DB):
 *   node scripts/migrate-cc-daily.cjs            # dry-run (safe, zero changes)
 *   node scripts/migrate-cc-daily.cjs --execute  # apply (transaction-wrapped)
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

/**
 * A conversation's local cc_date ('YYYY-MM-DD') from created_at + the owner's
 * timezone. Mirrors getTodayLocal (Intl 'en-CA') and the Commit 1 SQL backfill.
 * Used by BOTH dry-run grouping and --execute backfill so they agree exactly.
 */
function localDateOf(createdAt, tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || DEFAULT_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(createdAt));
}

// No cc_date reference — works against the current (pre-migration) schema.
// Oldest-first within each user so group[0] is the survivor.
const SCAN_SQL = `
  SELECT c.id,
         c.user_id,
         c.created_at,
         COALESCE(u.timezone, '${DEFAULT_TZ}') AS tz,
         (SELECT COUNT(*)::int FROM chat_messages m WHERE m.conversation_id = c.id) AS msg_count
  FROM chat_conversations c
  JOIN users u ON u.id = c.user_id
  WHERE c.type = 'command_center'
  ORDER BY c.user_id, c.created_at ASC
`;

async function main() {
  console.log(`\n[migrate-cc-daily] mode=${EXECUTE ? 'EXECUTE' : 'DRY-RUN'}\n`);

  const { rows } = await pool.query(SCAN_SQL);
  console.log(`command_center conversations scanned: ${rows.length}`);

  const noDate = rows.filter((r) => r.created_at == null).length;
  console.log(`  rows with underivable date (created_at NULL — should be 0): ${noDate}`);

  // Group by (user_id, derived cc_date). Rows arrive user+created_at ascending,
  // so each group's first element is the oldest → the survivor.
  const groups = new Map();
  for (const r of rows) {
    if (r.created_at == null) continue;
    r._d = localDateOf(r.created_at, r.tz);
    const k = `${r.user_id}|${r._d}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  const multi = [...groups.values()].filter((g) => g.length > 1);
  let shellsToDelete = 0;
  let messagesToReparent = 0;
  const plan = [];
  for (const g of multi) {
    const [survivor, ...losers] = g;
    const moved = losers.reduce((n, r) => n + r.msg_count, 0);
    shellsToDelete += losers.length;
    messagesToReparent += moved;
    plan.push({ survivorId: survivor.id, loserIds: losers.map((r) => r.id) });
  }

  console.log(`\n(user, cc_date) groups with >1 conversation: ${multi.length}`);
  console.log(`  messages that WOULD re-parent: ${messagesToReparent}`);
  console.log(`  empty shells that WOULD delete (after re-parent): ${shellsToDelete}`);
  console.log('  (zero messages are ever deleted — only moved)\n');

  if (!EXECUTE) {
    console.log('DRY-RUN — no changes made (no column add, no writes). Re-run with --execute to apply.');
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Add the column (idempotent).
    await client.query(`ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS cc_date DATE`);

    // 2. Backfill cc_date (NULLs only) using the SAME JS derivation as the
    //    dry-run, per conversation — so counts and results agree exactly.
    let backfilled = 0;
    for (const r of rows) {
      if (r.created_at == null) continue;
      const res = await client.query(
        `UPDATE chat_conversations SET cc_date = $1 WHERE id = $2 AND cc_date IS NULL`,
        [localDateOf(r.created_at, r.tz), r.id],
      );
      backfilled += res.rowCount;
    }
    console.log(`backfilled cc_date on ${backfilled} rows`);

    // 3. Merge each group: re-parent messages → survivor, delete empty shells.
    let movedTotal = 0;
    let deletedTotal = 0;
    for (const p of plan) {
      const upd = await client.query(
        `UPDATE chat_messages SET conversation_id = $1 WHERE conversation_id = ANY($2::int[])`,
        [p.survivorId, p.loserIds],
      );
      movedTotal += upd.rowCount;
      const del = await client.query(
        `DELETE FROM chat_conversations
          WHERE id = ANY($1::int[])
            AND NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.conversation_id = chat_conversations.id)`,
        [p.loserIds],
      );
      deletedTotal += del.rowCount;
    }
    console.log(`re-parented ${movedTotal} messages; deleted ${deletedTotal} empty shells`);

    // 4. Now collision-free → create the partial unique index.
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
