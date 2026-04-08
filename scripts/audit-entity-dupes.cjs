'use strict';

/**
 * Dry-run script: find case-insensitive duplicate entities and show
 * which canonical name would be kept (earliest created_at wins).
 *
 * Run on Railway:  railway run node scripts/audit-entity-dupes.cjs
 * Or locally with: DATABASE_URL=... node scripts/audit-entity-dupes.cjs
 */

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : undefined,
});

(async () => {
  // 1. Find case-insensitive duplicates
  const { rows: dupes } = await pool.query(`
    SELECT LOWER(name) AS lower_name,
           array_agg(json_build_object(
             'id', id, 'name', name, 'color', color,
             'created_by', created_by, 'created_at', created_at
           ) ORDER BY created_at ASC) AS variants
    FROM entities
    GROUP BY LOWER(name)
    HAVING COUNT(*) > 1
    ORDER BY LOWER(name)
  `);

  if (dupes.length === 0) {
    console.log('No case-insensitive duplicates found.');
    await pool.end();
    return;
  }

  console.log(`Found ${dupes.length} duplicate group(s):\n`);

  for (const d of dupes) {
    const keep = d.variants[0]; // earliest created
    const drop = d.variants.slice(1);

    console.log(`Group: "${d.lower_name}"`);
    console.log(`  KEEP: id=${keep.id}  name=${JSON.stringify(keep.name)}  color=${keep.color}  created=${keep.created_at}`);
    for (const v of drop) {
      // Count tasks referencing the duplicate name
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS count FROM tasks WHERE tags @> $1::jsonb`,
        [JSON.stringify([v.name])],
      );
      console.log(`  DROP: id=${v.id}  name=${JSON.stringify(v.name)}  color=${v.color}  created=${v.created_at}  (${rows[0].count} tasks tagged)`);
    }

    // Also count tasks referencing the canonical name
    const { rows: keepCount } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM tasks WHERE tags @> $1::jsonb`,
      [JSON.stringify([keep.name])],
    );
    console.log(`  Canonical "${keep.name}" has ${keepCount[0].count} tasks tagged`);
    console.log('');
  }

  console.log('To apply: run the entity dedup migration in runMigrations()');
  await pool.end();
})().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
