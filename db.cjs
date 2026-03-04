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

  // Add new columns to users table (idempotent)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'member'`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS entity_ids JSONB DEFAULT '[]'`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS entities (
      id         TEXT PRIMARY KEY,
      name       TEXT UNIQUE NOT NULL,
      color      TEXT DEFAULT 'slate',
      created_by TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notes (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      title       TEXT DEFAULT '',
      content     TEXT DEFAULT '',
      visibility  TEXT DEFAULT 'private',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_notes_user_id ON notes (user_id, created_at DESC);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id              TEXT PRIMARY KEY REFERENCES users(id),
      theme                TEXT DEFAULT 'light',
      default_tag_filter   JSONB DEFAULT '[]',
      default_status_filter TEXT DEFAULT 'all',
      notifications_enabled BOOLEAN DEFAULT TRUE,
      updated_at           TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id         SERIAL PRIMARY KEY,
      user_id    TEXT NOT NULL,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      model      TEXT DEFAULT 'claude',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_chat_messages_user_id ON chat_messages (user_id, created_at DESC);
  `);

  console.log('[db] Tables initialised');
}

// ── Users ────────────────────────────────────────────────────────────────────

async function getUsers() {
  const { rows } = await pool.query(
    `SELECT id, username, display_name AS "displayName", password_hash AS "passwordHash",
            email, role, entity_ids AS "entityIds", active, created_at AS "createdAt"
     FROM users ORDER BY created_at ASC`,
  );
  return rows;
}

async function upsertUser({ id, username, displayName, passwordHash, email, role, entityIds }) {
  await pool.query(
    `INSERT INTO users (id, username, display_name, password_hash, email, role, entity_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE
       SET username = $2, display_name = $3, password_hash = $4,
           email = COALESCE($5, users.email),
           role = COALESCE($6, users.role),
           entity_ids = COALESCE($7, users.entity_ids)`,
    [id, username, displayName, passwordHash, email || '', role || 'member', JSON.stringify(entityIds || [])],
  );
}

async function updateUser(id, fields) {
  const sets = [];
  const vals = [id];
  let idx = 2;

  if (fields.displayName !== undefined) { sets.push(`display_name = $${idx++}`); vals.push(fields.displayName); }
  if (fields.email !== undefined) { sets.push(`email = $${idx++}`); vals.push(fields.email); }
  if (fields.role !== undefined) { sets.push(`role = $${idx++}`); vals.push(fields.role); }
  if (fields.entityIds !== undefined) { sets.push(`entity_ids = $${idx++}`); vals.push(JSON.stringify(fields.entityIds)); }
  if (fields.active !== undefined) { sets.push(`active = $${idx++}`); vals.push(fields.active); }
  if (fields.passwordHash !== undefined) { sets.push(`password_hash = $${idx++}`); vals.push(fields.passwordHash); }

  if (sets.length === 0) return null;

  const { rows } = await pool.query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $1
     RETURNING id, username, display_name AS "displayName", email, role,
               entity_ids AS "entityIds", active, created_at AS "createdAt"`,
    vals,
  );
  return rows[0] || null;
}

async function deleteUser(id) {
  await pool.query('DELETE FROM users WHERE id = $1', [id]);
}

// ── Entities ──────────────────────────────────────────────────────────────────

async function getEntities() {
  const { rows } = await pool.query(
    'SELECT id, name, color, created_by AS "createdBy", created_at AS "createdAt" FROM entities ORDER BY created_at ASC',
  );
  return rows;
}

async function createEntity({ id, name, color, createdBy }) {
  const { rows } = await pool.query(
    `INSERT INTO entities (id, name, color, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, color, created_by AS "createdBy", created_at AS "createdAt"`,
    [id, name, color || 'slate', createdBy || ''],
  );
  return rows[0];
}

async function updateEntity(id, fields) {
  const { rows } = await pool.query(
    `UPDATE entities
     SET name = COALESCE($2, name),
         color = COALESCE($3, color)
     WHERE id = $1
     RETURNING id, name, color, created_by AS "createdBy", created_at AS "createdAt"`,
    [id, fields.name ?? null, fields.color ?? null],
  );
  return rows[0] || null;
}

async function deleteEntity(id) {
  await pool.query('DELETE FROM entities WHERE id = $1', [id]);
}

async function seedEntitiesIfEmpty() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM entities');
  if (rows[0].count > 0) return;

  const defaults = [
    { id: 'entity-careific', name: 'Careific', color: 'indigo' },
    { id: 'entity-rose', name: 'Rose', color: 'pink' },
    { id: 'entity-buyflip', name: 'Buyflip', color: 'amber' },
    { id: 'entity-carehome', name: 'Care Home', color: 'teal' },
    { id: 'entity-personal', name: 'Personal', color: 'slate' },
  ];

  for (const e of defaults) {
    await pool.query(
      'INSERT INTO entities (id, name, color) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [e.id, e.name, e.color],
    );
  }
  console.log('[db] Seeded 5 default entities');
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

async function getTasksForUser(userId, userEntityIds) {
  // If no entity filter, fall back to simple owner/visibility check
  if (!userEntityIds || userEntityIds.length === 0) {
    const { rows } = await pool.query(
      `SELECT id, title, description, priority, status, due_date AS "dueDate",
              tags, visibility, completed, owner, created_by AS "createdBy",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM tasks
       WHERE owner = $1 OR visibility = 'private' AND owner = $1
       ORDER BY created_at DESC`,
      [userId],
    );
    return rows;
  }
  // Entity-based access: shared tasks visible if they share at least one entity tag,
  // plus all the user's own tasks (private or shared).
  const entityNames = userEntityIds; // these are entity name strings
  const { rows } = await pool.query(
    `SELECT id, title, description, priority, status, due_date AS "dueDate",
            tags, visibility, completed, owner, created_by AS "createdBy",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM tasks
     WHERE owner = $1
        OR (visibility = 'shared' AND tags ?| $2)
     ORDER BY created_at DESC`,
    [userId, entityNames],
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

// ── Notes (privacy-first: default private) ───────────────────────────────────

async function getNotesForUser(userId) {
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", title, content, visibility,
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM notes
     WHERE user_id = $1 OR visibility = 'shared'
     ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

async function getPrivateNotesForAI(userId) {
  const { rows } = await pool.query(
    `SELECT id, title, content, visibility
     FROM notes
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

async function createNote({ id, userId, title, content, visibility }) {
  const { rows } = await pool.query(
    `INSERT INTO notes (id, user_id, title, content, visibility)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, user_id AS "userId", title, content, visibility,
               created_at AS "createdAt", updated_at AS "updatedAt"`,
    [id, userId, title || '', content || '', visibility || 'private'],
  );
  return rows[0];
}

async function updateNote(id, userId, fields) {
  const { rows } = await pool.query(
    `UPDATE notes
     SET title = COALESCE($3, title),
         content = COALESCE($4, content),
         visibility = COALESCE($5, visibility),
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2
     RETURNING id, user_id AS "userId", title, content, visibility,
               created_at AS "createdAt", updated_at AS "updatedAt"`,
    [id, userId, fields.title ?? null, fields.content ?? null, fields.visibility ?? null],
  );
  return rows[0] || null;
}

async function deleteNote(id, userId) {
  await pool.query('DELETE FROM notes WHERE id = $1 AND user_id = $2', [id, userId]);
}

// ── User preferences ─────────────────────────────────────────────────────────

async function getUserPreferences(userId) {
  const { rows } = await pool.query(
    `SELECT user_id AS "userId", theme, default_tag_filter AS "defaultTagFilter",
            default_status_filter AS "defaultStatusFilter",
            notifications_enabled AS "notificationsEnabled", updated_at AS "updatedAt"
     FROM user_preferences WHERE user_id = $1`,
    [userId],
  );
  return rows[0] || null;
}

async function saveUserPreferences(userId, prefs) {
  await pool.query(
    `INSERT INTO user_preferences (user_id, theme, default_tag_filter, default_status_filter, notifications_enabled, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (user_id) DO UPDATE
       SET theme = $2, default_tag_filter = $3, default_status_filter = $4,
           notifications_enabled = $5, updated_at = NOW()`,
    [
      userId,
      prefs.theme || 'light',
      JSON.stringify(prefs.defaultTagFilter || []),
      prefs.defaultStatusFilter || 'all',
      prefs.notificationsEnabled !== false,
    ],
  );
}

// ── Chat messages ────────────────────────────────────────────────────────────

async function getChatHistory(userId, limit = 50) {
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", role, content, model, created_at AS "createdAt"
     FROM chat_messages
     WHERE user_id = $1
     ORDER BY created_at ASC
     LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

async function saveChatMessage({ userId, role, content, model }) {
  const { rows } = await pool.query(
    `INSERT INTO chat_messages (user_id, role, content, model)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_id AS "userId", role, content, model, created_at AS "createdAt"`,
    [userId, role, content, model || 'claude'],
  );
  return rows[0];
}

async function clearChatHistory(userId) {
  await pool.query('DELETE FROM chat_messages WHERE user_id = $1', [userId]);
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
    `SELECT id, username, display_name AS "displayName", password_hash AS "passwordHash",
            email, role, entity_ids AS "entityIds", active
     FROM users WHERE id = $1`,
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
  if (rows[0].count > 0) {
    // Ensure first user (lyle) is admin with all entities if not set
    const lyle = await getUserById('user-lyle');
    if (lyle && lyle.role === 'member') {
      const entities = await getEntities();
      const allEntityNames = entities.map((e) => e.name);
      await updateUser('user-lyle', { role: 'admin', entityIds: allEntityNames });
      console.log('[db] Upgraded user-lyle to admin with all entities');
    }
    return;
  }

  const fs   = require('fs');
  const path = require('path');
  const file = path.join(__dirname, 'users.json');
  if (!fs.existsSync(file)) return;

  try {
    const users = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entities = await getEntities();
    const allEntityNames = entities.map((e) => e.name);
    for (let i = 0; i < users.length; i++) {
      const u = users[i];
      await upsertUser({
        ...u,
        role: i === 0 ? 'admin' : 'member',
        entityIds: allEntityNames,
      });
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
  updateUser,
  deleteUser,
  getEntities,
  createEntity,
  updateEntity,
  deleteEntity,
  seedEntitiesIfEmpty,
  getTasks,
  getTasksForUser,
  replaceTasks,
  getSettings,
  saveSettings,
  getGcalTokens,
  getGcalTokensForUser,
  setGcalTokensForUser,
  deleteGcalTokensForUser,
  getNotesForUser,
  getPrivateNotesForAI,
  createNote,
  updateNote,
  deleteNote,
  getUserPreferences,
  saveUserPreferences,
  getChatHistory,
  saveChatMessage,
  clearChatHistory,
  updateTask,
  getUserById,
  updateUserPassword,
  seedUsersIfEmpty,
};
