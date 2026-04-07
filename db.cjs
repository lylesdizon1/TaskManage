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
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS persona VARCHAR(50) DEFAULT 'executive_assistant'`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS assistant_name VARCHAR(50) DEFAULT 'Aria'`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_phone TEXT DEFAULT NULL`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_name TEXT DEFAULT NULL`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_businesses TEXT DEFAULT NULL`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_household TEXT DEFAULT NULL`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_location TEXT DEFAULT NULL`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_notes TEXT DEFAULT NULL`);

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
      id              TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      description     TEXT DEFAULT '',
      priority        TEXT DEFAULT 'medium',
      status          TEXT DEFAULT 'pending',
      due_date        TEXT DEFAULT '',
      due_time        VARCHAR(5) DEFAULT NULL,
      tags            JSONB DEFAULT '[]',
      visibility      TEXT DEFAULT 'shared',
      completed       BOOLEAN DEFAULT FALSE,
      owner           TEXT DEFAULT '',
      created_by      TEXT DEFAULT '',
      google_event_id VARCHAR(255) DEFAULT NULL,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Add columns if they don't exist (for existing databases)
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_time VARCHAR(5) DEFAULT NULL`);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS google_event_id VARCHAR(255) DEFAULT NULL`);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ DEFAULT NULL`);
  await pool.query(`ALTER TABLE notes ADD COLUMN IF NOT EXISTS entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL`);

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
    CREATE TABLE IF NOT EXISTS gmail_tokens (
      user_id    TEXT PRIMARY KEY,
      tokens     JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS gmail_config (
      user_id    TEXT PRIMARY KEY,
      config     JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS inbox_items (
      id               TEXT PRIMARY KEY,
      user_id          TEXT NOT NULL,
      type             TEXT NOT NULL,
      title            TEXT NOT NULL DEFAULT '',
      summary          TEXT DEFAULT '',
      source           TEXT NOT NULL,
      source_id        TEXT,
      gmail_thread_id  TEXT,
      gmail_link       TEXT,
      action_taken     TEXT DEFAULT NULL,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE inbox_items ADD COLUMN IF NOT EXISTS sender TEXT DEFAULT NULL`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notes (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      title       TEXT DEFAULT '',
      content     TEXT DEFAULT '',
      visibility  TEXT DEFAULT 'private',
      type        TEXT DEFAULT 'quick',
      pillar      TEXT,
      category    TEXT DEFAULT '',
      subcategory TEXT DEFAULT '',
      tags        JSONB DEFAULT '[]',
      pinned      BOOLEAN DEFAULT FALSE,
      archived    BOOLEAN DEFAULT FALSE,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_notes_user_id ON notes (user_id, created_at DESC);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS note_images (
      id            TEXT PRIMARY KEY,
      note_id       TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      user_id       TEXT NOT NULL,
      filename      TEXT NOT NULL,
      original_name TEXT DEFAULT '',
      mime_type     TEXT DEFAULT '',
      size          INTEGER DEFAULT 0,
      url           TEXT NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_note_images_note_id ON note_images (note_id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS note_categories (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      name       TEXT NOT NULL,
      parent_id  TEXT,
      pillar     TEXT,
      color      TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_note_categories_user ON note_categories (user_id);
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
      conversation_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_chat_messages_user_id ON chat_messages (user_id, created_at DESC);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_conversations (
      id         SERIAL PRIMARY KEY,
      user_id    TEXT NOT NULL,
      title      TEXT DEFAULT '',
      model      TEXT DEFAULT 'claude',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_chat_conversations_user_id ON chat_conversations (user_id, updated_at DESC);
  `);

  // ── Financial tables ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS financial_accounts (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      name          TEXT NOT NULL,
      type          TEXT NOT NULL DEFAULT 'checking',
      institution   TEXT DEFAULT '',
      currency      TEXT DEFAULT 'USD',
      entity_id     TEXT DEFAULT '',
      account_class TEXT DEFAULT 'personal',
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id            TEXT PRIMARY KEY,
      account_id    TEXT NOT NULL,
      user_id       TEXT NOT NULL,
      date          TEXT NOT NULL,
      description   TEXT DEFAULT '',
      amount        NUMERIC(12,2) NOT NULL DEFAULT 0,
      type          TEXT NOT NULL DEFAULT 'debit',
      category      TEXT DEFAULT 'Uncategorized',
      entity_id     TEXT DEFAULT '',
      account_class TEXT DEFAULT 'personal',
      notes         TEXT DEFAULT '',
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_fin_accounts_user ON financial_accounts (user_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions (account_id, date DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions (user_id, date DESC);`);

  // ── Org hierarchy tables ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS organizations (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      type       TEXT NOT NULL DEFAULT 'household',
      active     BOOLEAN DEFAULT TRUE,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_members (
      org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role       TEXT NOT NULL DEFAULT 'member',
      invited_by TEXT NOT NULL,
      joined_at  TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (org_id, user_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_links (
      id         TEXT PRIMARY KEY,
      org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      label      TEXT NOT NULL,
      url        TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS invites (
      id          TEXT PRIMARY KEY,
      token       TEXT UNIQUE NOT NULL,
      email       TEXT NOT NULL,
      org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      role        TEXT NOT NULL DEFAULT 'member',
      invited_by  TEXT NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      accepted_at TIMESTAMPTZ DEFAULT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_tasks (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id),
      type        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      payload     JSONB DEFAULT '{}',
      result      JSONB DEFAULT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ DEFAULT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_approvals (
      id           TEXT PRIMARY KEY,
      agent_task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
      user_id      TEXT NOT NULL REFERENCES users(id),
      action       TEXT NOT NULL,
      description  TEXT DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'pending',
      decided_at   TIMESTAMPTZ DEFAULT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_assignees (
      task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      assigned_by TEXT NOT NULL,
      assigned_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (task_id, user_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id                 SERIAL PRIMARY KEY,
      super_admin_user_id TEXT NOT NULL,
      action             TEXT NOT NULL,
      target_type        TEXT,
      target_id          TEXT,
      metadata           JSONB DEFAULT '{}',
      created_at         TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_memory (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type        TEXT NOT NULL DEFAULT 'action',
      content     TEXT NOT NULL,
      tool        TEXT DEFAULT NULL,
      metadata    JSONB DEFAULT '{}',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_agent_memory_user_created
      ON agent_memory(user_id, created_at DESC);
  `);

  // ── scheduled_alerts table (server-side cron-fired reminders) ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduled_alerts (
      id          SERIAL PRIMARY KEY,
      user_id     TEXT NOT NULL,
      task_id     TEXT,
      alert_key   TEXT,
      message     TEXT NOT NULL,
      channels    JSONB NOT NULL DEFAULT '[]',
      fire_at     TIMESTAMPTZ NOT NULL,
      fired       BOOLEAN DEFAULT FALSE,
      fired_at    TIMESTAMPTZ,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS scheduled_alerts_fire_at
      ON scheduled_alerts(fire_at) WHERE fired = FALSE;
  `);

  // ── alert_cadence_config table (per-user priority-based alert timing) ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS alert_cadence_config (
      id          SERIAL PRIMARY KEY,
      user_id     TEXT NOT NULL,
      priority    TEXT NOT NULL CHECK (priority IN ('high', 'medium', 'low', 'floating')),
      offsets     JSONB NOT NULL DEFAULT '[]',
      channels    JSONB NOT NULL DEFAULT '["whatsapp"]',
      enabled     BOOLEAN DEFAULT TRUE,
      updated_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, priority)
    );
  `);

  // ── fired_alerts table (server-side alert deduplication) ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fired_alerts (
      id          SERIAL PRIMARY KEY,
      user_id     TEXT NOT NULL,
      alert_key   TEXT NOT NULL,
      fired_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS fired_alerts_user_key
      ON fired_alerts(user_id, alert_key);
  `);
  // Cleanup: remove entries older than 7 days
  await pool.query(`DELETE FROM fired_alerts WHERE fired_at < NOW() - INTERVAL '7 days'`);

  // ── Seed default org ──
  const { rows: orgRows } = await pool.query('SELECT COUNT(*)::int AS count FROM organizations');
  if (orgRows[0].count === 0) {
    await pool.query(
      `INSERT INTO organizations (id, name, type, created_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      ['org-dizon-household', 'Dizon Household', 'household', 'user-lyle']
    );
    await pool.query(
      `INSERT INTO org_members (org_id, user_id, role, invited_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      ['org-dizon-household', 'user-lyle', 'admin', 'user-lyle']
    );
    console.log('[seed] Created default org: Dizon Household');
  }

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
  if (fields.persona !== undefined) { sets.push(`persona = $${idx++}`); vals.push(fields.persona); }
  if (fields.assistantName !== undefined) { sets.push(`assistant_name = $${idx++}`); vals.push(fields.assistantName); }
  if (fields.whatsappPhone !== undefined) { sets.push(`whatsapp_phone = $${idx++}`); vals.push(fields.whatsappPhone || null); }
  if (fields.profileName !== undefined) { sets.push(`profile_name = $${idx++}`); vals.push(fields.profileName); }
  if (fields.profileBusinesses !== undefined) { sets.push(`profile_businesses = $${idx++}`); vals.push(fields.profileBusinesses); }
  if (fields.profileHousehold !== undefined) { sets.push(`profile_household = $${idx++}`); vals.push(fields.profileHousehold); }
  if (fields.profileLocation !== undefined) { sets.push(`profile_location = $${idx++}`); vals.push(fields.profileLocation); }
  if (fields.profileNotes !== undefined) { sets.push(`profile_notes = $${idx++}`); vals.push(fields.profileNotes); }

  if (sets.length === 0) return null;

  const { rows } = await pool.query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $1
     RETURNING id, username, display_name AS "displayName", email, role,
               entity_ids AS "entityIds", active, created_at AS "createdAt",
               persona, assistant_name AS "assistantName", whatsapp_phone AS "whatsappPhone",
               profile_name AS "profileName", profile_businesses AS "profileBusinesses",
               profile_household AS "profileHousehold", profile_location AS "profileLocation",
               profile_notes AS "profileNotes"`,
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
    `SELECT e.id, e.name, e.color, e.created_by AS "createdBy", e.created_at AS "createdAt",
            e.type, e.parent_id AS "parentId", e.shared,
            p.name AS "parentName"
     FROM entities e
     LEFT JOIN entities p ON e.parent_id = p.id
     ORDER BY e.created_at ASC`,
  );
  return rows;
}

async function getEntitiesForUser(userId) {
  const { rows } = await pool.query(
    `SELECT e.id, e.name, e.color, e.created_by AS "createdBy", e.created_at AS "createdAt",
            e.type, e.parent_id AS "parentId", e.shared,
            p.name AS "parentName",
            (e.created_by = $1) AS "isOwner"
     FROM entities e
     LEFT JOIN entities p ON e.parent_id = p.id
     WHERE e.created_by = $1 OR e.shared = true
     ORDER BY e.created_at ASC`,
    [userId],
  );
  return rows;
}

async function createEntity({ id, name, color, createdBy, type, parentId, shared }) {
  const { rows } = await pool.query(
    `INSERT INTO entities (id, name, color, created_by, type, parent_id, shared)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, name, color, created_by AS "createdBy", created_at AS "createdAt",
               type, parent_id AS "parentId", shared`,
    [id, name, color || 'slate', createdBy || '', type || 'business', parentId || null, shared || false],
  );
  return rows[0];
}

async function updateEntity(id, fields) {
  const sets = [];
  const vals = [id];
  let idx = 2;

  if (fields.name !== undefined) { sets.push(`name = $${idx++}`); vals.push(fields.name); }
  if (fields.color !== undefined) { sets.push(`color = $${idx++}`); vals.push(fields.color); }
  if (fields.type !== undefined) { sets.push(`type = $${idx++}`); vals.push(fields.type); }
  if (fields.parentId !== undefined) { sets.push(`parent_id = $${idx++}`); vals.push(fields.parentId || null); }
  if (fields.shared !== undefined) { sets.push(`shared = $${idx++}`); vals.push(fields.shared); }

  if (sets.length === 0) return null;

  const { rows } = await pool.query(
    `UPDATE entities SET ${sets.join(', ')} WHERE id = $1
     RETURNING id, name, color, created_by AS "createdBy", created_at AS "createdAt",
               type, parent_id AS "parentId", shared`,
    vals,
  );
  return rows[0] || null;
}

async function getEntityById(id) {
  const { rows } = await pool.query(
    `SELECT id, name, color, created_by AS "createdBy", type, parent_id AS "parentId", shared
     FROM entities WHERE id = $1`,
    [id],
  );
  return rows[0] || null;
}

async function deleteEntity(id, userId) {
  await pool.query('DELETE FROM entities WHERE id = $1 AND created_by = $2', [id, userId]);
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
              due_time AS "dueTime", tags, visibility, completed, completed_at AS "completedAt", owner, created_by AS "createdBy",
              google_event_id AS "googleEventId", created_at AS "createdAt", updated_at AS "updatedAt"
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
            due_time AS "dueTime", tags, visibility, completed, completed_at AS "completedAt", owner, created_by AS "createdBy",
            google_event_id AS "googleEventId", created_at AS "createdAt", updated_at AS "updatedAt"
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
async function replaceTasks(tasks, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Delete by user ownership AND by incoming IDs to prevent duplicate key on stale rows
    await client.query('DELETE FROM tasks WHERE created_by = $1 OR owner = $1', [userId]);
    if (tasks.length > 0) {
      const ids = tasks.map(t => t.id);
      await client.query('DELETE FROM tasks WHERE id = ANY($1::text[])', [ids]);
    }
    for (const t of tasks) {
      await client.query(
        `INSERT INTO tasks (id, title, description, priority, status, due_date, due_time,
                            tags, visibility, completed, owner, created_by, google_event_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, NOW())`,
        [
          t.id,
          t.title || '',
          t.description || '',
          t.priority || 'medium',
          t.status || 'pending',
          t.dueDate || '',
          t.dueTime || null,
          JSON.stringify(t.tags || []),
          t.visibility || 'shared',
          !!t.completed,
          t.owner || '',
          t.createdBy || t.owner || '',
          t.googleEventId || null,
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

async function upsertTask(t) {
  const { rows } = await pool.query(
    `INSERT INTO tasks (id, title, description, priority, status, due_date, due_time,
                        tags, visibility, completed, owner, created_by, google_event_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, NOW())
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title,
       description = EXCLUDED.description,
       priority = EXCLUDED.priority,
       status = EXCLUDED.status,
       due_date = EXCLUDED.due_date,
       due_time = EXCLUDED.due_time,
       tags = EXCLUDED.tags,
       visibility = EXCLUDED.visibility,
       completed = EXCLUDED.completed,
       google_event_id = EXCLUDED.google_event_id,
       updated_at = NOW()
     RETURNING *`,
    [
      t.id,
      t.title || '',
      t.description || '',
      t.priority || 'medium',
      t.status || 'pending',
      t.dueDate || '',
      t.dueTime || null,
      JSON.stringify(t.tags || []),
      t.visibility || 'shared',
      !!t.completed,
      t.owner || '',
      t.createdBy || t.owner || '',
      t.googleEventId || null,
      t.createdAt || new Date().toISOString(),
    ],
  );
  return rows[0];
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

// ── Gmail tokens & config ─────────────────────────────────────────────────────

async function getGmailTokensForUser(userId) {
  const { rows } = await pool.query(
    'SELECT tokens FROM gmail_tokens WHERE user_id = $1',
    [userId],
  );
  return rows.length ? rows[0].tokens : null;
}

async function setGmailTokensForUser(userId, tokens) {
  await pool.query(
    `INSERT INTO gmail_tokens (user_id, tokens, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET tokens = $2, updated_at = NOW()`,
    [userId, JSON.stringify(tokens)],
  );
}

async function deleteGmailTokensForUser(userId) {
  await pool.query('DELETE FROM gmail_tokens WHERE user_id = $1', [userId]);
}

async function getGmailConfigForUser(userId) {
  const { rows } = await pool.query(
    'SELECT config FROM gmail_config WHERE user_id = $1',
    [userId],
  );
  return rows.length ? rows[0].config : null;
}

async function setGmailConfigForUser(userId, config) {
  await pool.query(
    `INSERT INTO gmail_config (user_id, config, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET config = $2, updated_at = NOW()`,
    [userId, JSON.stringify(config)],
  );
}

// ── Inbox items ───────────────────────────────────────────────────────────────

async function getInboxItemsForUser(userId) {
  const { rows } = await pool.query(
    'SELECT * FROM inbox_items WHERE user_id = $1 ORDER BY created_at DESC',
    [userId],
  );
  return rows;
}

async function createInboxItem(item) {
  await pool.query(
    `INSERT INTO inbox_items (id, user_id, type, title, summary, source, source_id, gmail_thread_id, gmail_link, sender, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
    [item.id, item.userId, item.type, item.title, item.summary, item.source, item.sourceId, item.gmailThreadId || null, item.gmailLink || null, item.sender || null],
  );
}

async function inboxItemExistsBySourceId(userId, sourceId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM inbox_items WHERE user_id = $1 AND source_id = $2 LIMIT 1',
    [userId, sourceId],
  );
  return rows.length > 0;
}

async function updateInboxItemAction(id, action) {
  await pool.query(
    'UPDATE inbox_items SET action_taken = $2 WHERE id = $1',
    [id, action],
  );
}

// ── Notes (privacy-first: default private) ───────────────────────────────────

// ── Notes ─────────────────────────────────────────────────────────────────────

const NOTE_RETURNING = `id, user_id AS "userId", title, content, visibility,
  type, pillar, category, subcategory, tags, pinned, archived, entity_id AS "entityId",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

async function getNotesForUser(userId, filters = {}) {
  const where = ['user_id = $1', "type != 'digest'"];
  const vals = [userId];
  let idx = 2;
  if (filters.pillar) { where.push(`pillar = $${idx++}`); vals.push(filters.pillar); }
  if (filters.entityId) { where.push(`entity_id = $${idx++}`); vals.push(filters.entityId); }
  if (filters.category) { where.push(`category = $${idx++}`); vals.push(filters.category); }
  if (filters.pinned !== undefined) { where.push(`pinned = $${idx++}`); vals.push(filters.pinned); }
  if (filters.archived !== undefined) { where.push(`archived = $${idx++}`); vals.push(filters.archived); }
  else { where.push('archived = FALSE'); }
  const { rows } = await pool.query(
    `SELECT ${NOTE_RETURNING} FROM notes WHERE ${where.join(' AND ')} ORDER BY pinned DESC, created_at DESC`,
    vals,
  );
  return rows;
}

async function getNoteById(id, userId) {
  const { rows } = await pool.query(
    `SELECT ${NOTE_RETURNING} FROM notes WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0] || null;
}

async function getPrivateNotesForAI(userId) {
  const { rows } = await pool.query(
    `SELECT id, title, content, visibility, pillar, category
     FROM notes WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

async function createNote({ id, userId, title, content, visibility, type, pillar, category, subcategory, tags, entityId }) {
  const { rows } = await pool.query(
    `INSERT INTO notes (id, user_id, title, content, visibility, type, pillar, category, subcategory, tags, entity_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${NOTE_RETURNING}`,
    [id, userId, title || '', content || '', visibility || 'private',
     type || 'quick', pillar || null, category || '', subcategory || '',
     JSON.stringify(tags || []), entityId || null],
  );
  return rows[0];
}

async function updateNote(id, userId, fields) {
  const sets = [];
  const vals = [id, userId];
  let idx = 3;
  if (fields.title !== undefined) { sets.push(`title = $${idx++}`); vals.push(fields.title); }
  if (fields.content !== undefined) { sets.push(`content = $${idx++}`); vals.push(fields.content); }
  if (fields.visibility !== undefined) { sets.push(`visibility = $${idx++}`); vals.push(fields.visibility); }
  if (fields.type !== undefined) { sets.push(`type = $${idx++}`); vals.push(fields.type); }
  if (fields.pillar !== undefined) { sets.push(`pillar = $${idx++}`); vals.push(fields.pillar); }
  if (fields.category !== undefined) { sets.push(`category = $${idx++}`); vals.push(fields.category); }
  if (fields.subcategory !== undefined) { sets.push(`subcategory = $${idx++}`); vals.push(fields.subcategory); }
  if (fields.tags !== undefined) { sets.push(`tags = $${idx++}`); vals.push(JSON.stringify(fields.tags)); }
  if (fields.pinned !== undefined) { sets.push(`pinned = $${idx++}`); vals.push(fields.pinned); }
  if (fields.archived !== undefined) { sets.push(`archived = $${idx++}`); vals.push(fields.archived); }
  if (fields.entityId !== undefined) { sets.push(`entity_id = $${idx++}`); vals.push(fields.entityId || null); }
  if (sets.length === 0) return null;
  sets.push('updated_at = NOW()');
  const { rows } = await pool.query(
    `UPDATE notes SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2 RETURNING ${NOTE_RETURNING}`,
    vals,
  );
  return rows[0] || null;
}

async function deleteNote(id, userId) {
  await pool.query('DELETE FROM notes WHERE id = $1 AND user_id = $2', [id, userId]);
}

// ── Note Images ──────────────────────────────────────────────────────────────

async function getNoteImages(noteId, userId) {
  const { rows } = await pool.query(
    `SELECT id, note_id AS "noteId", user_id AS "userId", filename, original_name AS "originalName",
            mime_type AS "mimeType", size, url, created_at AS "createdAt"
     FROM note_images WHERE note_id = $1 AND user_id = $2 ORDER BY created_at ASC`,
    [noteId, userId],
  );
  return rows;
}

async function createNoteImage({ id, noteId, userId, filename, originalName, mimeType, size, url }) {
  const { rows } = await pool.query(
    `INSERT INTO note_images (id, note_id, user_id, filename, original_name, mime_type, size, url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, note_id AS "noteId", user_id AS "userId", filename, original_name AS "originalName",
               mime_type AS "mimeType", size, url, created_at AS "createdAt"`,
    [id, noteId, userId, filename, originalName || '', mimeType || '', size || 0, url],
  );
  return rows[0];
}

async function deleteNoteImage(id, userId) {
  const { rows } = await pool.query(
    'DELETE FROM note_images WHERE id = $1 AND user_id = $2 RETURNING *',
    [id, userId],
  );
  return rows[0] || null;
}

// ── Note Search ──────────────────────────────────────────────────────────────

async function searchNotes(userId, query) {
  const q = `%${query}%`;
  const { rows } = await pool.query(
    `SELECT ${NOTE_RETURNING} FROM notes
     WHERE user_id = $1 AND archived = FALSE
     AND (title ILIKE $2 OR content ILIKE $2 OR category ILIKE $2)
     ORDER BY updated_at DESC LIMIT 50`,
    [userId, q],
  );
  return rows;
}

// ── Note Categories ───────────────────────────────────────────────────────────

async function getNoteCategories(userId) {
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", name, parent_id AS "parentId", pillar, color,
            created_at AS "createdAt"
     FROM note_categories WHERE user_id = $1 ORDER BY pillar, name`,
    [userId],
  );
  return rows;
}

async function createNoteCategory({ id, userId, name, parentId, pillar, color }) {
  const { rows } = await pool.query(
    `INSERT INTO note_categories (id, user_id, name, parent_id, pillar, color)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, user_id AS "userId", name, parent_id AS "parentId", pillar, color, created_at AS "createdAt"`,
    [id, userId, name, parentId || null, pillar || null, color || ''],
  );
  return rows[0];
}

async function seedNoteCategoriesIfEmpty(userId) {
  const existing = await getNoteCategories(userId);
  if (existing.length > 0) return;

  const tree = {
    hustle: ['Careific', 'Rose Motors', 'Buyflip', 'Care Homes', 'AutoVision', 'General Business'],
    home: ['Family', 'Liz', 'Kids', 'Personal'],
    move: ['Workouts', 'Health', 'Nutrition', 'Recovery'],
    grow: ['Ideas', 'Journal', 'Learnings', 'Goals', 'Braindump'],
  };
  const pillarLabels = { hustle: 'Hustle', home: 'Home', move: 'Move', grow: 'Grow' };

  for (const [pillar, children] of Object.entries(tree)) {
    const parentId = `ncat-${pillar}`;
    await createNoteCategory({ id: parentId, userId, name: pillarLabels[pillar], parentId: null, pillar, color: '' });
    for (const child of children) {
      const childId = `ncat-${pillar}-${child.toLowerCase().replace(/\s+/g, '-')}`;
      await createNoteCategory({ id: childId, userId, name: child, parentId, pillar, color: '' });
    }
  }
  console.log(`[db] Seeded default note categories for user ${userId}`);
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

// ── Chat Conversations ──────────────────────────────────────────────────────

async function getConversations(userId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.title, c.model, c.created_at AS "createdAt", c.updated_at AS "updatedAt",
            (SELECT content FROM chat_messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS "lastMessage"
     FROM chat_conversations c
     WHERE c.user_id = $1
     ORDER BY c.updated_at DESC`,
    [userId],
  );
  return rows.map((r) => ({
    ...r,
    lastMessage: r.lastMessage ? r.lastMessage.slice(0, 60) : null,
  }));
}

async function getConversation(id, userId) {
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", title, model, created_at AS "createdAt", updated_at AS "updatedAt"
     FROM chat_conversations WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0] || null;
}

async function createConversation(userId, model) {
  const { rows } = await pool.query(
    `INSERT INTO chat_conversations (user_id, model) VALUES ($1, $2)
     RETURNING id, user_id AS "userId", title, model, created_at AS "createdAt", updated_at AS "updatedAt"`,
    [userId, model || 'claude'],
  );
  return rows[0];
}

async function updateConversationTitle(id, userId, title) {
  const { rows } = await pool.query(
    `UPDATE chat_conversations SET title = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2
     RETURNING id, title, model, updated_at AS "updatedAt"`,
    [id, userId, title],
  );
  return rows[0] || null;
}

async function deleteConversation(id, userId) {
  await pool.query('DELETE FROM chat_messages WHERE conversation_id = $1 AND user_id = $2', [id, userId]);
  await pool.query('DELETE FROM chat_conversations WHERE id = $1 AND user_id = $2', [id, userId]);
}

async function getConversationMessages(conversationId, userId) {
  const { rows } = await pool.query(
    `SELECT id, role, content, model, created_at AS "createdAt"
     FROM chat_messages WHERE conversation_id = $1 AND user_id = $2
     ORDER BY created_at ASC`,
    [conversationId, userId],
  );
  return rows;
}

async function addConversationMessage(conversationId, userId, role, content, model) {
  const { rows } = await pool.query(
    `INSERT INTO chat_messages (conversation_id, user_id, role, content, model)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, conversation_id AS "conversationId", role, content, model, created_at AS "createdAt"`,
    [conversationId, userId, role, content, model || 'claude'],
  );
  // Update conversation timestamp
  await pool.query('UPDATE chat_conversations SET updated_at = NOW() WHERE id = $1', [conversationId]);
  // Auto-title: set title from first user message if empty
  if (role === 'user') {
    await pool.query(
      `UPDATE chat_conversations SET title = $2 WHERE id = $1 AND (title IS NULL OR title = '')`,
      [conversationId, content.slice(0, 50)],
    );
  }
  return rows[0];
}

/**
 * Gets or creates a command center conversation for a user for a given date.
 * @param {string} userId
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {Promise<object>} conversation row
 */
async function getOrCreateCommandCenterConversation(userId, dateStr) {
  const title = `Command Center — ${dateStr}`;

  // Always delete existing command center conversations for today and start fresh
  const existing = await pool.query(
    `SELECT id FROM chat_conversations
     WHERE user_id = $1 AND type = 'command_center' AND title = $2`,
    [userId, title]
  );

  if (existing.rows.length > 0) {
    const ids = existing.rows.map(r => r.id);
    await pool.query(
      `DELETE FROM chat_messages WHERE conversation_id = ANY($1)`,
      [ids]
    );
    await pool.query(
      `DELETE FROM chat_conversations WHERE id = ANY($1)`,
      [ids]
    );
  }

  // Always create fresh
  const result = await pool.query(
    `INSERT INTO chat_conversations (user_id, title, model, type, created_at, updated_at)
     VALUES ($1, $2, 'claude', 'command_center', NOW(), NOW())
     RETURNING *`,
    [userId, title]
  );
  return result.rows[0];
}

// ── Single-task update ───────────────────────────────────────────────────────

async function updateTask(id, fields) {
  const { rows } = await pool.query(
    `UPDATE tasks
     SET title           = COALESCE($2, title),
         description     = COALESCE($3, description),
         priority        = COALESCE($4, priority),
         due_date        = COALESCE($5, due_date),
         due_time        = COALESCE($6, due_time),
         tags            = COALESCE($7, tags),
         visibility      = COALESCE($8, visibility),
         completed       = COALESCE($9, completed),
         google_event_id = COALESCE($10, google_event_id),
         completed_at    = CASE WHEN $11::text = '__null__' THEN NULL WHEN $11::text IS NOT NULL THEN $11::timestamptz ELSE completed_at END,
         updated_at      = NOW()
     WHERE id = $1
     RETURNING id, title, description, priority, status, due_date AS "dueDate",
               due_time AS "dueTime", tags, visibility, completed, completed_at AS "completedAt", owner, created_by AS "createdBy",
               google_event_id AS "googleEventId", created_at AS "createdAt", updated_at AS "updatedAt"`,
    [
      id,
      fields.title ?? null,
      fields.description ?? null,
      fields.priority ?? null,
      fields.dueDate ?? null,
      fields.dueTime ?? null,
      fields.tags ? JSON.stringify(fields.tags) : null,
      fields.visibility ?? null,
      fields.completed !== undefined ? fields.completed : null,
      fields.googleEventId ?? null,
      fields.completedAt !== undefined ? (fields.completedAt === null ? '__null__' : fields.completedAt) : null,
    ],
  );
  return rows[0] || null;
}

// ── Password update ──────────────────────────────────────────────────────────

async function getUserById(id) {
  const { rows } = await pool.query(
    `SELECT id, username, display_name AS "displayName", password_hash AS "passwordHash",
            email, role, entity_ids AS "entityIds", active,
            persona, assistant_name AS "assistantName", whatsapp_phone AS "whatsappPhone",
            profile_name AS "profileName", profile_businesses AS "profileBusinesses",
            profile_household AS "profileHousehold", profile_location AS "profileLocation",
            profile_notes AS "profileNotes"
     FROM users WHERE id = $1`,
    [id],
  );
  return rows[0] || null;
}

async function getUserByWhatsAppPhone(normalizedPhone) {
  const { rows } = await pool.query(
    `SELECT id, username, display_name AS "displayName",
            email, role, entity_ids AS "entityIds", active,
            persona, assistant_name AS "assistantName", whatsapp_phone AS "whatsappPhone",
            profile_name AS "profileName", profile_businesses AS "profileBusinesses",
            profile_household AS "profileHousehold", profile_location AS "profileLocation",
            profile_notes AS "profileNotes"
     FROM users WHERE REGEXP_REPLACE(whatsapp_phone, '[^0-9]', '', 'g') = $1`,
    [normalizedPhone],
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

/**
 * Robust migration that runs on EVERY startup.
 * Ensures entities exist, lyle is admin with all entities assigned,
 * and all users have the new columns populated.
 */
async function runMigrations() {
  // ── 0. Add entity columns FIRST (before any query that references them) ──
  const entityColAlters = [
    `ALTER TABLE entities ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'business'`,
    `ALTER TABLE entities ADD COLUMN IF NOT EXISTS parent_id TEXT`,
    `ALTER TABLE entities ADD COLUMN IF NOT EXISTS shared BOOLEAN DEFAULT FALSE`,
  ];
  for (const sql of entityColAlters) {
    await pool.query(sql).catch((err) => console.warn('[migration] entity col:', err.message));
  }

  // Add FK constraint separately (safe if already exists)
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE entities ADD CONSTRAINT entities_parent_id_fkey
        FOREIGN KEY (parent_id) REFERENCES entities(id) ON DELETE SET NULL;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;
  `).catch((err) => console.warn('[migration] entity FK:', err.message));

  // Seed entity types for existing entities (idempotent)
  await pool.query(`
    UPDATE entities SET type = 'personal'
    WHERE LOWER(name) IN ('personal', 'home', 'family', 'kids')
      AND (type IS NULL OR type = 'business')
  `).catch(() => {});

  // 1. Seed default entities if the table is empty
  await seedEntitiesIfEmpty();

  // 2. Get all entity names (now safe — columns exist)
  const entities = await getEntities();
  const allEntityNames = entities.map((e) => e.name);

  // 3. Find lyle — always ensure admin + all entities
  const lyle = await getUserById('user-lyle');
  if (lyle) {
    const needsUpdate =
      (lyle.role !== 'admin' && lyle.role !== 'superadmin') ||
      !Array.isArray(lyle.entityIds) ||
      lyle.entityIds.length !== allEntityNames.length ||
      !allEntityNames.every((n) => lyle.entityIds.includes(n));

    if (needsUpdate) {
      await updateUser('user-lyle', { role: 'admin', entityIds: allEntityNames });
      console.log('[db] Migration: set user-lyle as admin with all entities');
    }
  }

  // 3b. Promote lyle to superadmin (idempotent)
  if (lyle && lyle.role !== 'superadmin') {
    await updateUser('user-lyle', { role: 'superadmin' });
    console.log('[db] Migration: promoted user-lyle to superadmin');
  }

  // 4. Legacy: only assign all entities to Lyle (superadmin)
  // New users start with empty entityIds and own only their created entities

  // 5. Add new columns to notes table (idempotent)
  const noteCols = [
    `ALTER TABLE notes ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'quick'`,
    `ALTER TABLE notes ADD COLUMN IF NOT EXISTS pillar TEXT`,
    `ALTER TABLE notes ADD COLUMN IF NOT EXISTS category TEXT DEFAULT ''`,
    `ALTER TABLE notes ADD COLUMN IF NOT EXISTS subcategory TEXT DEFAULT ''`,
    `ALTER TABLE notes ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'`,
    `ALTER TABLE notes ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE notes ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT FALSE`,
  ];
  for (const sql of noteCols) {
    await pool.query(sql).catch(() => {});
  }

  // 6. Create note_images table if not exists (idempotent)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS note_images (
      id            TEXT PRIMARY KEY,
      note_id       TEXT NOT NULL,
      user_id       TEXT NOT NULL,
      filename      TEXT NOT NULL,
      original_name TEXT DEFAULT '',
      mime_type     TEXT DEFAULT '',
      size          INTEGER DEFAULT 0,
      url           TEXT NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_note_images_note_id ON note_images (note_id)`).catch(() => {});

  // 7. Full text search index on notes
  await pool.query(`
    CREATE INDEX IF NOT EXISTS notes_search_idx ON notes
    USING gin(to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,'')))
  `).catch(() => {});

  // 8. Add conversation_id column to chat_messages (idempotent)
  await pool.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS conversation_id INTEGER`).catch(() => {});

  // 9. Add type column to chat_conversations (command_center, general, etc.)
  await pool.query(`ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'general'`).catch(() => {});
}

// ── Financial Accounts ────────────────────────────────────────────────────────

async function getFinancialAccounts(userId, role) {
  if (role === 'admin') {
    const { rows } = await pool.query(
      `SELECT id, user_id AS "userId", name, type, institution, currency,
              entity_id AS "entityId", account_class AS "accountClass", created_at AS "createdAt"
       FROM financial_accounts ORDER BY created_at DESC`,
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", name, type, institution, currency,
            entity_id AS "entityId", account_class AS "accountClass", created_at AS "createdAt"
     FROM financial_accounts WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

async function createFinancialAccount({ id, userId, name, type, institution, currency, entityId, accountClass }) {
  const { rows } = await pool.query(
    `INSERT INTO financial_accounts (id, user_id, name, type, institution, currency, entity_id, account_class)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, user_id AS "userId", name, type, institution, currency,
               entity_id AS "entityId", account_class AS "accountClass", created_at AS "createdAt"`,
    [id, userId, name, type || 'checking', institution || '', currency || 'USD', entityId || '', accountClass || 'personal'],
  );
  return rows[0];
}

async function updateFinancialAccount(id, fields) {
  const sets = [];
  const vals = [id];
  let idx = 2;
  if (fields.name !== undefined) { sets.push(`name = $${idx++}`); vals.push(fields.name); }
  if (fields.type !== undefined) { sets.push(`type = $${idx++}`); vals.push(fields.type); }
  if (fields.institution !== undefined) { sets.push(`institution = $${idx++}`); vals.push(fields.institution); }
  if (fields.currency !== undefined) { sets.push(`currency = $${idx++}`); vals.push(fields.currency); }
  if (fields.entityId !== undefined) { sets.push(`entity_id = $${idx++}`); vals.push(fields.entityId); }
  if (fields.accountClass !== undefined) { sets.push(`account_class = $${idx++}`); vals.push(fields.accountClass); }
  if (sets.length === 0) return null;
  const { rows } = await pool.query(
    `UPDATE financial_accounts SET ${sets.join(', ')} WHERE id = $1
     RETURNING id, user_id AS "userId", name, type, institution, currency,
               entity_id AS "entityId", account_class AS "accountClass", created_at AS "createdAt"`,
    vals,
  );
  return rows[0] || null;
}

async function deleteFinancialAccount(id) {
  await pool.query('DELETE FROM transactions WHERE account_id = $1', [id]);
  await pool.query('DELETE FROM financial_accounts WHERE id = $1', [id]);
}

// ── Transactions ──────────────────────────────────────────────────────────────

async function getTransactions(userId, role, filters = {}) {
  const where = [];
  const vals = [];
  let idx = 1;

  if (role !== 'admin') {
    where.push(`t.user_id = $${idx++}`);
    vals.push(userId);
  }
  if (filters.accountId) {
    where.push(`t.account_id = $${idx++}`);
    vals.push(filters.accountId);
  }
  if (filters.entityId) {
    where.push(`t.entity_id = $${idx++}`);
    vals.push(filters.entityId);
  }
  if (filters.accountClass) {
    where.push(`t.account_class = $${idx++}`);
    vals.push(filters.accountClass);
  }
  if (filters.category) {
    where.push(`t.category = $${idx++}`);
    vals.push(filters.category);
  }
  if (filters.startDate) {
    where.push(`t.date >= $${idx++}`);
    vals.push(filters.startDate);
  }
  if (filters.endDate) {
    where.push(`t.date <= $${idx++}`);
    vals.push(filters.endDate);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT t.id, t.account_id AS "accountId", t.user_id AS "userId", t.date, t.description,
            t.amount::float, t.type, t.category, t.entity_id AS "entityId",
            t.account_class AS "accountClass", t.notes, t.created_at AS "createdAt"
     FROM transactions t ${whereClause} ORDER BY t.date DESC, t.created_at DESC`,
    vals,
  );
  return rows;
}

async function createTransaction({ id, accountId, userId, date, description, amount, type, category, entityId, accountClass, notes }) {
  const { rows } = await pool.query(
    `INSERT INTO transactions (id, account_id, user_id, date, description, amount, type, category, entity_id, account_class, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, account_id AS "accountId", user_id AS "userId", date, description,
               amount::float, type, category, entity_id AS "entityId",
               account_class AS "accountClass", notes, created_at AS "createdAt"`,
    [id, accountId, userId, date, description || '', amount, type || 'debit', category || 'Uncategorized', entityId || '', accountClass || 'personal', notes || ''],
  );
  return rows[0];
}

async function bulkCreateTransactions(txns) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const results = [];
    for (const t of txns) {
      const { rows } = await client.query(
        `INSERT INTO transactions (id, account_id, user_id, date, description, amount, type, category, entity_id, account_class, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id, account_id AS "accountId", user_id AS "userId", date, description,
                   amount::float, type, category, entity_id AS "entityId",
                   account_class AS "accountClass", notes, created_at AS "createdAt"`,
        [t.id, t.accountId, t.userId, t.date, t.description || '', t.amount, t.type || 'debit', t.category || 'Uncategorized', t.entityId || '', t.accountClass || 'personal', t.notes || ''],
      );
      results.push(rows[0]);
    }
    await client.query('COMMIT');
    return results;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function deleteTransaction(id) {
  await pool.query('DELETE FROM transactions WHERE id = $1', [id]);
}

async function updateTransaction(id, fields) {
  const sets = [];
  const vals = [id];
  let idx = 2;
  if (fields.date !== undefined) { sets.push(`date = $${idx++}`); vals.push(fields.date); }
  if (fields.description !== undefined) { sets.push(`description = $${idx++}`); vals.push(fields.description); }
  if (fields.amount !== undefined) { sets.push(`amount = $${idx++}`); vals.push(fields.amount); }
  if (fields.type !== undefined) { sets.push(`type = $${idx++}`); vals.push(fields.type); }
  if (fields.category !== undefined) { sets.push(`category = $${idx++}`); vals.push(fields.category); }
  if (fields.entityId !== undefined) { sets.push(`entity_id = $${idx++}`); vals.push(fields.entityId); }
  if (fields.accountClass !== undefined) { sets.push(`account_class = $${idx++}`); vals.push(fields.accountClass); }
  if (fields.notes !== undefined) { sets.push(`notes = $${idx++}`); vals.push(fields.notes); }
  if (sets.length === 0) return null;
  const { rows } = await pool.query(
    `UPDATE transactions SET ${sets.join(', ')} WHERE id = $1
     RETURNING id, account_id AS "accountId", user_id AS "userId", date, description,
               amount::float, type, category, entity_id AS "entityId",
               account_class AS "accountClass", notes, created_at AS "createdAt"`,
    vals,
  );
  return rows[0] || null;
}

async function getFinancialSummary(userId, role) {
  const userFilter = role === 'admin' ? '' : 'WHERE t.user_id = $1';
  const vals = role === 'admin' ? [] : [userId];

  const { rows } = await pool.query(
    `SELECT t.entity_id AS "entityId", t.account_class AS "accountClass",
            SUBSTRING(t.date FROM 1 FOR 7) AS month,
            SUM(CASE WHEN t.type = 'credit' THEN t.amount ELSE 0 END)::float AS income,
            SUM(CASE WHEN t.type = 'debit' THEN t.amount ELSE 0 END)::float AS expenses
     FROM transactions t ${userFilter}
     GROUP BY t.entity_id, t.account_class, SUBSTRING(t.date FROM 1 FOR 7)
     ORDER BY month DESC`,
    vals,
  );

  // Get account balances
  const balFilter = role === 'admin' ? '' : 'WHERE a.user_id = $1';
  const { rows: balanceRows } = await pool.query(
    `SELECT a.id AS "accountId", a.name, a.type, a.entity_id AS "entityId", a.account_class AS "accountClass",
            COALESCE(SUM(CASE WHEN t.type = 'credit' THEN t.amount ELSE -t.amount END), 0)::float AS balance
     FROM financial_accounts a
     LEFT JOIN transactions t ON t.account_id = a.id
     ${balFilter}
     GROUP BY a.id, a.name, a.type, a.entity_id, a.account_class`,
    vals,
  );

  // Top spending categories
  const catFilter = role === 'admin' ? `WHERE t.type = 'debit'` : `WHERE t.user_id = $1 AND t.type = 'debit'`;
  const { rows: categoryRows } = await pool.query(
    `SELECT t.category, SUM(t.amount)::float AS total
     FROM transactions t ${catFilter}
     GROUP BY t.category ORDER BY total DESC LIMIT 10`,
    vals,
  );

  return { monthly: rows, balances: balanceRows, topCategories: categoryRows };
}

// ── Organizations ──────────────────────────────────────────────────────────

async function getOrgForUser(userId) {
  const { rows } = await pool.query(
    `SELECT o.id, o.name, o.type, o.active, o.created_by AS "createdBy", o.created_at AS "createdAt",
            om.role AS "memberRole"
     FROM org_members om
     JOIN organizations o ON o.id = om.org_id
     WHERE om.user_id = $1
     LIMIT 1`,
    [userId],
  );
  return rows[0] || null;
}

async function getOrganizations() {
  const { rows } = await pool.query(
    `SELECT o.id, o.name, o.type, o.active, o.created_by AS "createdBy", o.created_at AS "createdAt",
            COUNT(om.user_id)::int AS "memberCount"
     FROM organizations o
     LEFT JOIN org_members om ON om.org_id = o.id
     GROUP BY o.id
     ORDER BY o.created_at ASC`,
  );
  return rows;
}

async function createOrganization({ id, name, type, createdBy }) {
  const { rows } = await pool.query(
    `INSERT INTO organizations (id, name, type, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, type, active, created_by AS "createdBy", created_at AS "createdAt"`,
    [id, name, type || 'household', createdBy],
  );
  return rows[0];
}

async function updateOrganization(id, fields) {
  const sets = [];
  const vals = [id];
  let idx = 2;
  if (fields.active !== undefined) { sets.push(`active = $${idx++}`); vals.push(fields.active); }
  if (fields.name !== undefined) { sets.push(`name = $${idx++}`); vals.push(fields.name); }
  if (sets.length === 0) return null;
  const { rows } = await pool.query(
    `UPDATE organizations SET ${sets.join(', ')} WHERE id = $1
     RETURNING id, name, type, active, created_by AS "createdBy", created_at AS "createdAt"`,
    vals,
  );
  return rows[0] || null;
}

async function addOrgMember(orgId, userId, role, invitedBy) {
  await pool.query(
    `INSERT INTO org_members (org_id, user_id, role, invited_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id, user_id) DO NOTHING`,
    [orgId, userId, role, invitedBy],
  );
}

// ── Invites ────────────────────────────────────────────────────────────────

async function createInvite({ id, token, email, orgId, role, invitedBy, expiresAt }) {
  const { rows } = await pool.query(
    `INSERT INTO invites (id, token, email, org_id, role, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, token, email, org_id AS "orgId", role, invited_by AS "invitedBy",
               expires_at AS "expiresAt", accepted_at AS "acceptedAt", created_at AS "createdAt"`,
    [id, token, email, orgId, role || 'member', invitedBy, expiresAt],
  );
  return rows[0];
}

async function getInviteByToken(token) {
  const { rows } = await pool.query(
    `SELECT i.id, i.token, i.email, i.org_id AS "orgId", i.role,
            i.invited_by AS "invitedBy", i.expires_at AS "expiresAt",
            i.accepted_at AS "acceptedAt", i.created_at AS "createdAt",
            o.name AS "orgName"
     FROM invites i
     JOIN organizations o ON o.id = i.org_id
     WHERE i.token = $1`,
    [token],
  );
  return rows[0] || null;
}

async function acceptInvite(token, userId) {
  await pool.query(
    `UPDATE invites SET accepted_at = NOW() WHERE token = $1`,
    [token],
  );
}

// ── Audit log ──────────────────────────────────────────────────────────────

async function logAdminAction({ superAdminUserId, action, targetType, targetId, metadata }) {
  await pool.query(
    `INSERT INTO admin_audit_log (super_admin_user_id, action, target_type, target_id, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [superAdminUserId, action, targetType || null, targetId || null, JSON.stringify(metadata || {})],
  );
}

async function getAuditLog(limit = 20, offset = 0) {
  const { rows } = await pool.query(
    `SELECT id, super_admin_user_id AS "superAdminUserId", action,
            target_type AS "targetType", target_id AS "targetId",
            metadata, created_at AS "createdAt"
     FROM admin_audit_log
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows;
}

// ── All users (with org info) ──────────────────────────────────────────────

async function getAllUsersWithOrg() {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.display_name AS "displayName", u.email, u.role, u.active,
            u.created_at AS "createdAt", o.name AS "orgName", o.id AS "orgId"
     FROM users u
     LEFT JOIN org_members om ON om.user_id = u.id
     LEFT JOIN organizations o ON o.id = om.org_id
     ORDER BY u.created_at ASC`,
  );
  return rows;
}

// ── Agent Memory ──────────────────────────────────────────────────────────

async function logMemory({ userId, type = 'action', content, tool = null, metadata = {} }) {
  const id = `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await pool.query(
    `INSERT INTO agent_memory (id, user_id, type, content, tool, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, userId, type, content, tool, JSON.stringify(metadata)]
  );
}

async function getRecentMemories(userId, limit = 20) {
  const { rows } = await pool.query(
    `SELECT id, type, content, tool, metadata, created_at AS "createdAt"
     FROM agent_memory
     WHERE user_id = $1
       AND tool IN ('create_task', 'complete_task', 'update_task', 'create_event')
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

async function getAllMemories({ limit = 30, offset = 0, userId = null }) {
  const where = userId ? `WHERE m.user_id = $3` : '';
  const params = userId ? [limit, offset, userId] : [limit, offset];
  const { rows } = await pool.query(
    `SELECT m.id, m.user_id AS "userId", m.type, m.content, m.tool,
            m.metadata, m.created_at AS "createdAt",
            u.display_name AS "displayName", u.username
     FROM agent_memory m
     JOIN users u ON u.id = m.user_id
     ${where}
     ORDER BY m.created_at DESC
     LIMIT $1 OFFSET $2`,
    params
  );
  return rows;
}

async function deleteMemory(id) {
  await pool.query('DELETE FROM agent_memory WHERE id = $1', [id]);
}

// ── Alert Cadence Config ──────────────────────────────────────────────────

const DEFAULT_CADENCE_CONFIGS = [
  {
    priority: 'high',
    offsets: [
      { minutes_before: 1440, label: '24 hours before' },
      { minutes_before: 120, label: '2 hours before' },
      { minutes_before: 0, label: 'At due time' },
    ],
    channels: ['whatsapp', 'email'],
  },
  {
    priority: 'medium',
    offsets: [{ minutes_before: 1440, label: '24 hours before' }],
    channels: ['whatsapp'],
  },
  {
    priority: 'low',
    offsets: [{ minutes_before: 0, label: 'At due time' }],
    channels: ['whatsapp'],
  },
  {
    priority: 'floating',
    offsets: [{ day_of_week: 0, hour: 8, label: 'Sunday 8am digest' }],
    channels: ['email'],
  },
];

async function seedDefaultCadenceConfig(userId) {
  for (const cfg of DEFAULT_CADENCE_CONFIGS) {
    await pool.query(
      `INSERT INTO alert_cadence_config (user_id, priority, offsets, channels)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, priority) DO NOTHING`,
      [userId, cfg.priority, JSON.stringify(cfg.offsets), JSON.stringify(cfg.channels)]
    );
  }
}

async function getCadenceConfigForUser(userId) {
  const { rows } = await pool.query(
    `SELECT id, priority, offsets, channels, enabled, updated_at AS "updatedAt"
     FROM alert_cadence_config WHERE user_id = $1 ORDER BY priority`,
    [userId]
  );
  return rows;
}

async function upsertCadenceConfig(userId, priority, offsets, channels, enabled) {
  await pool.query(
    `INSERT INTO alert_cadence_config (user_id, priority, offsets, channels, enabled, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (user_id, priority) DO UPDATE SET
       offsets = $3, channels = $4, enabled = $5, updated_at = NOW()`,
    [userId, priority, JSON.stringify(offsets), JSON.stringify(channels), enabled]
  );
}

async function scheduleTaskAlerts(userId, taskId, taskTitle, dueDate, dueTime, priority) {
  // Load cadence config for this user + priority
  const { rows: configs } = await pool.query(
    `SELECT offsets, channels FROM alert_cadence_config
     WHERE user_id = $1 AND priority = $2 AND enabled = TRUE`,
    [userId, priority || 'medium']
  );
  if (!configs.length) return;

  const cfg = configs[0];
  const offsets = cfg.offsets || [];
  const channels = cfg.channels || ['whatsapp'];

  // Build due datetime
  const dueStr = dueTime ? `${dueDate}T${dueTime}:00` : `${dueDate}T09:00:00`;
  const dueDt = new Date(dueStr);
  if (isNaN(dueDt.getTime())) return;

  // Delete existing unfired alerts for this task
  await pool.query(
    `DELETE FROM scheduled_alerts WHERE task_id = $1 AND user_id = $2 AND fired = FALSE`,
    [taskId, userId]
  );

  const now = new Date();

  for (const offset of offsets) {
    let fireAt;
    if (offset.minutes_before !== undefined) {
      fireAt = new Date(dueDt.getTime() - offset.minutes_before * 60000);
    } else if (offset.day_of_week !== undefined && offset.hour !== undefined) {
      // Next occurrence of day_of_week at given hour
      const target = new Date(now);
      const currentDay = target.getDay();
      let daysAhead = offset.day_of_week - currentDay;
      if (daysAhead <= 0) daysAhead += 7;
      target.setDate(target.getDate() + daysAhead);
      target.setHours(offset.hour, 0, 0, 0);
      fireAt = target;
    } else {
      continue;
    }

    // Skip past fire times
    if (fireAt <= now) continue;

    const message = `Hey — "${taskTitle}" is ${offset.minutes_before === 0 ? 'due now' : 'coming up'}.\n\nJust keeping you on track.`;
    const alertKey = `sched::${taskId}::${offset.minutes_before ?? `dow${offset.day_of_week}h${offset.hour}`}`;

    await pool.query(
      `INSERT INTO scheduled_alerts (user_id, task_id, alert_key, message, channels, fire_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, taskId, alertKey, message, JSON.stringify(channels), fireAt.toISOString()]
    );
  }
}

async function getUnfiredAlerts() {
  const { rows } = await pool.query(
    `SELECT sa.id, sa.user_id, sa.task_id, sa.alert_key, sa.message, sa.channels, sa.fire_at,
            u.whatsapp_phone AS "whatsappPhone", u.email
     FROM scheduled_alerts sa
     JOIN users u ON u.id = sa.user_id
     WHERE sa.fired = FALSE AND sa.fire_at <= NOW()
     ORDER BY sa.fire_at ASC
     LIMIT 50`
  );
  return rows;
}

async function markScheduledAlertFired(alertId) {
  await pool.query(
    `UPDATE scheduled_alerts SET fired = TRUE, fired_at = NOW() WHERE id = $1`,
    [alertId]
  );
}

async function checkFiredAlerts(userId, keys) {
  if (!keys || keys.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT alert_key FROM fired_alerts
     WHERE user_id = $1 AND alert_key = ANY($2) AND fired_at >= NOW() - INTERVAL '24 hours'`,
    [userId, keys]
  );
  return rows.map(r => r.alert_key);
}

async function markFiredAlert(userId, key) {
  await pool.query(
    `INSERT INTO fired_alerts (user_id, alert_key) VALUES ($1, $2)
     ON CONFLICT (user_id, alert_key) DO NOTHING`,
    [userId, key]
  );
}

module.exports = {
  pool,
  initTables,
  getUsers,
  upsertUser,
  updateUser,
  deleteUser,
  getEntities,
  getEntitiesForUser,
  getEntityById,
  createEntity,
  updateEntity,
  deleteEntity,
  seedEntitiesIfEmpty,
  getTasks,
  getTasksForUser,
  replaceTasks,
  upsertTask,
  getSettings,
  saveSettings,
  getGcalTokens,
  getGcalTokensForUser,
  setGcalTokensForUser,
  deleteGcalTokensForUser,
  getNotesForUser,
  getNoteById,
  getPrivateNotesForAI,
  createNote,
  updateNote,
  deleteNote,
  getNoteImages,
  createNoteImage,
  deleteNoteImage,
  searchNotes,
  getNoteCategories,
  createNoteCategory,
  seedNoteCategoriesIfEmpty,
  getUserPreferences,
  saveUserPreferences,
  getChatHistory,
  saveChatMessage,
  clearChatHistory,
  getConversations,
  getConversation,
  createConversation,
  updateConversationTitle,
  deleteConversation,
  getConversationMessages,
  addConversationMessage,
  getOrCreateCommandCenterConversation,
  updateTask,
  getUserById,
  updateUserPassword,
  seedUsersIfEmpty,
  runMigrations,
  getFinancialAccounts,
  createFinancialAccount,
  updateFinancialAccount,
  deleteFinancialAccount,
  getTransactions,
  createTransaction,
  bulkCreateTransactions,
  deleteTransaction,
  updateTransaction,
  getFinancialSummary,
  getGmailTokensForUser,
  setGmailTokensForUser,
  deleteGmailTokensForUser,
  getGmailConfigForUser,
  setGmailConfigForUser,
  getInboxItemsForUser,
  createInboxItem,
  inboxItemExistsBySourceId,
  updateInboxItemAction,
  getUserByWhatsAppPhone,
  getOrgForUser,
  getOrganizations,
  createOrganization,
  updateOrganization,
  addOrgMember,
  createInvite,
  getInviteByToken,
  acceptInvite,
  logAdminAction,
  getAuditLog,
  getAllUsersWithOrg,
  logMemory,
  getRecentMemories,
  getAllMemories,
  deleteMemory,
  checkFiredAlerts,
  markFiredAlert,
  seedDefaultCadenceConfig,
  getCadenceConfigForUser,
  upsertCadenceConfig,
  scheduleTaskAlerts,
  getUnfiredAlerts,
  markScheduledAlertFired,
  DEFAULT_CADENCE_CONFIGS,
};
