'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.app')
    ? { rejectUnauthorized: false }
    : undefined,
});

/**
 * Create all tables if they don't exist yet.
 * Called once at server startup.
 */
async function initTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      display_name  TEXT,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      description TEXT DEFAULT '',
      priority    TEXT DEFAULT 'medium',
      status      TEXT DEFAULT 'pending',
      due_date    TEXT DEFAULT '',
      tags        JSONB DEFAULT '[]',
      visibility  TEXT DEFAULT 'shared',
      completed   BOOLEAN DEFAULT FALSE,
      owner       TEXT DEFAULT '',
      created_by  TEXT DEFAULT '',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS gcal_tokens (
      user_id    TEXT PRIMARY KEY,
      tokens     JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log('[db] Tables initialised');
}

// ── Users ────────────────────────────────────────────────────────────────────

async function getUsers() {
  const { rows } = await pool.query(
    'SELECT id, username, display_name AS "displayName", password_hash AS "passwordHash" FROM users',
  );
  return rows;
}

async function upsertUser({ id, username, displayName, passwordHash }) {
  await pool.query(
    `INSERT INTO users (id, username, display_name, password_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE
       SET username = $2, display_name = $3, password_hash = $4`,
    [id, username, displayName, passwordHash],
  );
}

// ── Tasks ────────────────────────────────────────────────────────────────────

async function getTasks() {
  const { rows } = await pool.query(
    `SELECT id, title, description, priority, status, due_date AS "dueDate",
            tags, visibility, completed, owner, created_by AS "createdBy",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM tasks ORDER BY created_at DESC`,
  );
  return rows;
}

/**
 * Replace ALL tasks in the database with the provided array.
 * This mirrors the original "overwrite tasks.json" behaviour.
 */
async function replaceTasks(tasks) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM tasks');
    for (const t of tasks) {
      await client.query(
        `INSERT INTO tasks (id, title, description, priority, status, due_date,
                            tags, visibility, completed, owner, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW())`,
        [
          t.id,
          t.title || '',
          t.description || '',
          t.priority || 'medium',
          t.status || 'pending',
          t.dueDate || '',
          JSON.stringify(t.tags || []),
          t.visibility || 'shared',
          !!t.completed,
          t.owner || '',
          t.createdBy || t.owner || '',
          t.createdAt || new Date().toISOString(),
        ],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Settings ─────────────────────────────────────────────────────────────────

async function getSettings() {
  const { rows } = await pool.query('SELECT key, value FROM settings');
  const result = {};
  for (const r of rows) {
    result[r.key] = r.value;
  }
  return result;
}

async function saveSettings(data) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [key, value] of Object.entries(data)) {
      await client.query(
        `INSERT INTO settings (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [key, JSON.stringify(value)],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Google Calendar tokens ───────────────────────────────────────────────────

async function getGcalTokens() {
  const { rows } = await pool.query('SELECT user_id, tokens FROM gcal_tokens');
  const result = {};
  for (const r of rows) {
    result[r.user_id] = r.tokens;
  }
  return result;
}

async function getGcalTokensForUser(userId) {
  const { rows } = await pool.query(
    'SELECT tokens FROM gcal_tokens WHERE user_id = $1',
    [userId],
  );
  return rows.length ? rows[0].tokens : null;
}

async function setGcalTokensForUser(userId, tokens) {
  await pool.query(
    `INSERT INTO gcal_tokens (user_id, tokens, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET tokens = $2, updated_at = NOW()`,
    [userId, JSON.stringify(tokens)],
  );
}

async function deleteGcalTokensForUser(userId) {
  await pool.query('DELETE FROM gcal_tokens WHERE user_id = $1', [userId]);
}

// ── Single-task update ───────────────────────────────────────────────────────

async function updateTask(id, fields) {
  const { rows } = await pool.query(
    `UPDATE tasks
     SET title       = COALESCE($2, title),
         description = COALESCE($3, description),
         priority    = COALESCE($4, priority),
         due_date    = COALESCE($5, due_date),
         tags        = COALESCE($6, tags),
         visibility  = COALESCE($7, visibility),
         completed   = COALESCE($8, completed),
         updated_at  = NOW()
     WHERE id = $1
     RETURNING id, title, description, priority, status, due_date AS "dueDate",
               tags, visibility, completed, owner, created_by AS "createdBy",
               created_at AS "createdAt", updated_at AS "updatedAt"`,
    [
      id,
      fields.title ?? null,
      fields.description ?? null,
      fields.priority ?? null,
      fields.dueDate ?? null,
      fields.tags ? JSON.stringify(fields.tags) : null,
      fields.visibility ?? null,
      fields.completed !== undefined ? fields.completed : null,
    ],
  );
  return rows[0] || null;
}

// ── Password update ──────────────────────────────────────────────────────────

async function getUserById(id) {
  const { rows } = await pool.query(
    'SELECT id, username, display_name AS "displayName", password_hash AS "passwordHash" FROM users WHERE id = $1',
    [id],
  );
  return rows[0] || null;
}

async function updateUserPassword(id, newHash) {
  await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [id, newHash]);
}

// ── Seed users from users.json (one-time migration) ──────────────────────────

async function seedUsersIfEmpty() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM users');
  if (rows[0].count > 0) return;

  const fs   = require('fs');
  const path = require('path');
  const file = path.join(__dirname, 'users.json');
  if (!fs.existsSync(file)) return;

  try {
    const users = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const u of users) {
      await upsertUser(u);
    }
    console.log(`[db] Seeded ${users.length} users from users.json`);
  } catch (err) {
    console.error('[db] Failed to seed users:', err.message);
  }
}

module.exports = {
  pool,
  initTables,
  getUsers,
  upsertUser,
  getTasks,
  replaceTasks,
  getSettings,
  saveSettings,
  getGcalTokens,
  getGcalTokensForUser,
  setGcalTokensForUser,
  deleteGcalTokensForUser,
  updateTask,
  getUserById,
  updateUserPassword,
  seedUsersIfEmpty,
};
