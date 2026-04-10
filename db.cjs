'use strict';

/**
 * db.cjs — PostgreSQL data access layer for Dizon.ai.
 *
 * db.cjs is the single database abstraction layer for all Dizon.ai data.
 * All DB access goes through this module — routes and tools never call
 * pool.query() directly (except a small number of legacy paths flagged
 * in the audit).
 *
 * Responsibilities:
 *   - Schema creation and migrations (initTables, runMigrations)
 *   - CRUD helpers for users, tasks, notes, entities, conversations,
 *     settings, alerts, inbox, and agent memory
 *   - Seed data for first-run bootstrapping
 *
 * Dependencies:
 *   - pg (PostgreSQL client via Pool)
 *   - DATABASE_URL env var for connection string
 *
 * Boundaries:
 *   - This module owns the SQL layer only. Business logic belongs in
 *     route handlers and tools.cjs.
 *   - Column aliasing (snake_case → camelCase) is performed here so
 *     callers receive JS-friendly property names — this is intentional
 *     and consistent across all queries.
 *
 * @note This file is large (~2100 lines) because it houses every DB
 * helper in one place. Future refactors may split by domain (users.cjs,
 * tasks.cjs, etc.), but for now co-location keeps the migration and
 * schema logic coherent.
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.app')
    ? { rejectUnauthorized: false }
    : undefined,
});

/**
 * Create all core tables if they don't exist yet. Called once at server
 * startup before runMigrations(). Uses IF NOT EXISTS for idempotency.
 *
 * @note This only creates the base schema. Column additions, indexes,
 * and constraints added after initial launch live in runMigrations().
 *
 * @returns {Promise<void>}
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
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'America/Los_Angeles'`);

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
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completion_note TEXT`);
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
      user_id       TEXT NOT NULL,
      google_email  TEXT NOT NULL DEFAULT 'primary@placeholder',
      tokens        JSONB NOT NULL,
      is_primary    BOOLEAN DEFAULT false,
      updated_at    TIMESTAMPTZ DEFAULT NOW(),
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, google_email)
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

  // DND quiet hours — user-level, not per-priority
  await pool.query(`ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS dnd_start TIME DEFAULT '22:00'`);
  await pool.query(`ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS dnd_end TIME DEFAULT '07:00'`);

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS calendar_notes (
      id               SERIAL PRIMARY KEY,
      user_id          TEXT NOT NULL,
      event_id         TEXT NOT NULL,
      event_title      TEXT,
      event_start      TIMESTAMPTZ,
      event_end        TIMESTAMPTZ,
      source_account   TEXT,
      pre_note         TEXT,
      post_note        TEXT,
      post_alert_sent  BOOLEAN DEFAULT false,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, event_id)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_calendar_notes_user ON calendar_notes(user_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_calendar_notes_start ON calendar_notes(event_start)`).catch(() => {});

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
    console.log('[seed] Created default org');
  }

  console.log('[db] Tables initialised');
}

// ── Users ────────────────────────────────────────────────────────────────────

/**
 * Return all users ordered by creation date.
 * Used by the admin panel for user management. Includes passwordHash
 * because admin password-reset needs it — never expose this via API
 * without stripping the hash first.
 *
 * @returns {Promise<Array<Object>>} All user records with camelCase keys.
 */
async function getUsers() {
  const { rows } = await pool.query(
    `SELECT id, username, display_name AS "displayName", password_hash AS "passwordHash",
            email, role, entity_ids AS "entityIds", active, created_at AS "createdAt", timezone
     FROM users ORDER BY created_at ASC`,
  );
  return rows;
}

/**
 * Insert a new user or update an existing one by ID.
 * Used during registration and admin user creation. On conflict,
 * COALESCE preserves existing values for email/role/entityIds when
 * the caller passes null — this prevents accidental field erasure
 * during upserts that only intend to update a subset of fields.
 *
 * @param {Object} user
 * @param {string} user.id - Unique user ID (e.g. "user-abc123").
 * @param {string} user.username - Login username (unique).
 * @param {string} user.displayName - Display name.
 * @param {string} user.passwordHash - bcrypt hash.
 * @param {string} [user.email]
 * @param {string} [user.role='member']
 * @param {string[]} [user.entityIds=[]]
 */
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

/**
 * Partially update a user record. Only fields present in the `fields`
 * object are SET — omitted fields are left unchanged.
 *
 * Builds a dynamic UPDATE query with parameterised placeholders to
 * avoid SQL injection. Returns the full updated user record via
 * RETURNING, or null if no fields were provided.
 *
 * @param {string} id - User ID to update.
 * @param {Object} fields - Partial user object. Supported keys:
 *   displayName, email, role, entityIds, active, passwordHash,
 *   persona, assistantName, whatsappPhone, profileName,
 *   profileBusinesses, profileHousehold, profileLocation,
 *   profileNotes, timezone.
 * @returns {Promise<Object|null>} Updated user record or null.
 */
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
  if (fields.timezone !== undefined) { sets.push(`timezone = $${idx++}`); vals.push(fields.timezone); }

  if (sets.length === 0) return null;

  const { rows } = await pool.query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $1
     RETURNING id, username, display_name AS "displayName", email, role,
               entity_ids AS "entityIds", active, created_at AS "createdAt",
               persona, assistant_name AS "assistantName", whatsapp_phone AS "whatsappPhone",
               profile_name AS "profileName", profile_businesses AS "profileBusinesses",
               profile_household AS "profileHousehold", profile_location AS "profileLocation",
               profile_notes AS "profileNotes", timezone`,
    vals,
  );
  return rows[0] || null;
}

/**
 * Hard-delete a user by ID. Prefer setting active=false (soft delete)
 * in most cases — hard delete is used by the admin panel's delete action.
 *
 * @param {string} id - User ID to delete.
 */
async function deleteUser(id) {
  await pool.query('DELETE FROM users WHERE id = $1', [id]);
}

// ── Entities ──────────────────────────────────────────────────────────────────

/**
 * Return all entities across the platform. Used by admin views and
 * runMigrations() to build the global entity list.
 *
 * @returns {Promise<Array<Object>>} All entities with parent name resolved via LEFT JOIN.
 */
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

/**
 * Return entities visible to a specific user: entities they created plus
 * shared entities. The isOwner flag lets the frontend distinguish
 * owned entities (deletable) from shared ones (read-only).
 *
 * @param {string} userId - Authenticated user ID.
 * @returns {Promise<Array<Object>>} Entities with isOwner boolean.
 */
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

/**
 * Create a new entity and return the inserted row.
 *
 * @param {Object} entity
 * @param {string} entity.id - Pre-generated entity ID.
 * @param {string} entity.name - Entity display name.
 * @param {string} [entity.color='slate'] - Tailwind color key for UI badges.
 * @param {string} [entity.createdBy] - User ID of the creator.
 * @param {string} [entity.type='business'] - Entity type (business or personal).
 * @param {string|null} [entity.parentId] - Parent entity ID for hierarchy.
 * @param {boolean} [entity.shared=false] - Whether visible to all users.
 * @returns {Promise<Object>} The created entity row.
 * @throws {Error} If the database query fails.
 *
 * @note Authorization (who can create/update entities) is
 * enforced at the route layer — this helper assumes valid input.
 */
async function createEntity({ id, name, color, createdBy, type, parentId, shared }) {
  // Prevent case-insensitive duplicates at write-time (clear error before index rejection)
  const { rows: existing } = await pool.query(
    `SELECT id, name FROM entities WHERE LOWER(name) = LOWER($1)`,
    [name],
  );
  if (existing.length > 0) {
    throw new Error(`Entity "${existing[0].name}" already exists (case-insensitive match)`);
  }
  const { rows } = await pool.query(
    `INSERT INTO entities (id, name, color, created_by, type, parent_id, shared)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, name, color, created_by AS "createdBy", created_at AS "createdAt",
               type, parent_id AS "parentId", shared`,
    [id, name, color || 'slate', createdBy || '', type || 'business', parentId || null, shared || false],
  );
  return rows[0];
}

/**
 * Partial-update an entity. Only fields present in the input are SET —
 * uses dynamic query building to avoid overwriting unchanged columns.
 *
 * @param {string} id - Entity ID to update.
 * @param {Object} fields - Fields to update (name, color, type, parentId, shared).
 * @returns {Promise<Object|null>} Updated entity row, or null if no fields provided or not found.
 * @throws {Error} If the database query fails.
 *
 * @note Authorization (who can create/update entities) is
 * enforced at the route layer — this helper assumes valid input.
 */
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

/**
 * Fetch a single entity by ID. Used by route handlers to verify
 * existence and ownership before mutations.
 *
 * @param {string} id - Entity ID.
 * @returns {Promise<Object|null>} Entity row or null if not found.
 * @throws {Error} If the database query fails.
 */
async function getEntityById(id) {
  const { rows } = await pool.query(
    `SELECT id, name, color, created_by AS "createdBy", type, parent_id AS "parentId", shared
     FROM entities WHERE id = $1`,
    [id],
  );
  return rows[0] || null;
}

/**
 * Delete an entity, scoped to the creating user. The WHERE clause
 * enforces ownership at the DB level — only the creator can delete.
 *
 * @param {string} id - Entity ID to delete.
 * @param {string} userId - Authenticated user ID (must match created_by).
 * @returns {Promise<void>}
 */
async function deleteEntity(id, userId) {
  await pool.query('DELETE FROM entities WHERE id = $1 AND created_by = $2', [id, userId]);
}

/**
 * Seed default entities on first boot if the table is empty.
 * Uses ON CONFLICT DO NOTHING for idempotency. Only runs when
 * count is zero — subsequent calls are no-ops.
 *
 * @note These defaults are Lyle's original business entities.
 * New users do NOT inherit these — they create their own via the UI.
 *
 * @returns {Promise<void>}
 */
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

/**
 * Fetch a single task by ID, scoped to the owning user.
 * Added as M3 audit fix to eliminate N+1 lookups — routes that operate
 * on a single task should use this instead of loading all tasks via
 * getTasksForUser() and filtering in JS.
 *
 * @param {string} taskId - Task ID.
 * @param {string} userId - Owner's user ID (authorization scope).
 * @returns {Promise<Object|null>} Task record or null if not found / not owned.
 * @throws {Error} If the database query fails.
 */
async function getTaskById(taskId, userId) {
  const { rows } = await pool.query(
    `SELECT id, title, description, priority, status, due_date AS "dueDate",
            due_time AS "dueTime", tags, visibility, completed, completed_at AS "completedAt", owner, created_by AS "createdBy",
            google_event_id AS "googleEventId", completion_note AS "completionNote", created_at AS "createdAt", updated_at AS "updatedAt"
     FROM tasks
     WHERE id = $1 AND owner = $2
     LIMIT 1`,
    [taskId, userId],
  );
  return rows[0] || null;
}

/**
 * Return all tasks visible to a user, respecting entity-based sharing.
 *
 * Two code paths:
 *   1. No entity memberships → simple `WHERE owner = $1` (user's own tasks only).
 *   2. Has entities → own tasks PLUS shared tasks tagged with any of the
 *      user's entities (via PostgreSQL `?|` JSONB array overlap operator).
 *
 * @note The M14 audit fix simplified path 1 — previously had a dead
 * visibility clause caused by operator precedence.
 *
 * @note Shared tasks are visible through entity overlap, but mutation
 * routes must still enforce ownership/authorization separately —
 * visibility does not imply mutation rights.
 *
 * @param {string} userId - User ID.
 * @param {string[]} userEntityIds - Entity name strings from req.user.entityIds.
 * @param {number} [limit=100] - Maximum number of rows to return.
 * @returns {Promise<Array<Object>>} Tasks ordered by created_at DESC.
 * @throws {Error} If the database query fails.
 */
async function getTasksForUser(userId, userEntityIds, limit = 100) {
  // If no entity filter, fall back to simple owner check
  if (!userEntityIds || userEntityIds.length === 0) {
    const { rows } = await pool.query(
      `SELECT id, title, description, priority, status, due_date AS "dueDate",
              due_time AS "dueTime", tags, visibility, completed, completed_at AS "completedAt", owner, created_by AS "createdBy",
              google_event_id AS "googleEventId", completion_note AS "completionNote", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM tasks
       WHERE owner = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit],
    );
    return rows;
  }
  // Entity-based access: shared tasks visible if they share at least one entity tag,
  // plus all the user's own tasks (private or shared).
  const entityNames = userEntityIds; // these are entity name strings
  const { rows } = await pool.query(
    `SELECT id, title, description, priority, status, due_date AS "dueDate",
            due_time AS "dueTime", tags, visibility, completed, completed_at AS "completedAt", owner, created_by AS "createdBy",
            google_event_id AS "googleEventId", completion_note AS "completionNote", created_at AS "createdAt", updated_at AS "updatedAt"
     FROM tasks
     WHERE owner = $1
        OR (visibility = 'shared' AND tags ?| $2)
     ORDER BY created_at DESC
     LIMIT $3`,
    [userId, entityNames, limit],
  );
  return rows;
}

/**
 * Replace ALL tasks for a user with the provided array.
 * Legacy function from the original "overwrite tasks.json" behaviour.
 *
 * @note This is a destructive operation — it DELETEs all existing tasks
 * for the user before re-inserting. Wrapped in a transaction so partial
 * failures roll back cleanly. Prefer upsertTask() for single-record
 * mutations; this exists only for bulk sync compatibility.
 *
 * @param {Array<Object>} tasks - Full replacement task array.
 * @param {string} userId - Owner user ID.
 * @throws {Error} If the transaction fails (rolls back automatically).
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

/**
 * Insert a task or update it if the ID already exists.
 * Primary write path for task creation — used by Aria's create_task tool
 * and the POST /api/tasks bulk endpoint.
 *
 * On conflict, all mutable fields are overwritten with EXCLUDED values.
 * The owner and created_by fields are NOT updated on conflict — ownership
 * is immutable after creation.
 *
 * @note This function writes the task record only. Alert scheduling
 * is handled by the caller (create_task and update_task tools).
 *
 * @param {Object} t - Task object with at minimum { id, title, owner }.
 * @returns {Promise<Object>} The inserted or updated task record.
 * @throws {Error} If the database query fails.
 */
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

/**
 * Load all key-value settings from the settings table. Returns a
 * flat object keyed by setting name. Used by the settings route to
 * populate the frontend Settings modal.
 *
 * @returns {Promise<Object>} Map of { key: value } pairs.
 * @throws {Error} If the database query fails.
 */
async function getSettings() {
  const { rows } = await pool.query('SELECT key, value FROM settings');
  const result = {};
  for (const r of rows) {
    result[r.key] = r.value;
  }
  return result;
}

/**
 * Persist multiple settings in a single transaction. Each key is
 * upserted individually — ON CONFLICT updates the value and timestamp.
 *
 * @note Values are JSON.stringify'd before storage. The settings table
 * stores all values as text, so callers must parse on read if needed.
 *
 * @param {Object} data - Map of { key: value } pairs to save.
 * @returns {Promise<void>}
 * @throws {Error} Rolls back the transaction on any write failure.
 */
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

/**
 * Load raw GCal token data for a user from the DB.
 * Returns the tokens column as-is — may be encrypted (JSON string with
 * { _enc: "..." } wrapper) or a plain object (legacy unencrypted rows).
 * Callers should use loadGcalTokens() from server/utils/google.cjs which
 * handles decryption transparently.
 *
 * @note This helper intentionally does not encrypt or decrypt tokens.
 * Encryption is the sole responsibility of server/utils/google.cjs.
 *
 * @param {string} userId - User ID.
 * @returns {Promise<Object|string|null>} Raw token data or null if not connected.
 * @throws {Error} If the database query fails.
 */
async function getGcalTokensForUser(userId) {
  // Legacy single-account compat: return the primary account's tokens
  const { rows } = await pool.query(
    'SELECT tokens FROM gcal_tokens WHERE user_id = $1 ORDER BY is_primary DESC, created_at ASC LIMIT 1',
    [userId],
  );
  return rows.length ? rows[0].tokens : null;
}

/**
 * Return all connected GCal accounts for a user.
 *
 * @param {string} userId - User ID.
 * @returns {Promise<Array<{ googleEmail: string, isPrimary: boolean, createdAt: string }>>}
 */
async function getAllGcalAccountsForUser(userId) {
  const { rows } = await pool.query(
    `SELECT google_email AS "googleEmail", is_primary AS "isPrimary", tokens,
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM gcal_tokens WHERE user_id = $1
     ORDER BY is_primary DESC, created_at ASC`,
    [userId],
  );
  return rows;
}

/**
 * Load tokens for a specific GCal account (by email).
 *
 * @param {string} userId
 * @param {string} googleEmail
 * @returns {Promise<Object|null>} Raw tokens or null.
 */
async function getGcalTokensByEmail(userId, googleEmail) {
  const { rows } = await pool.query(
    'SELECT tokens FROM gcal_tokens WHERE user_id = $1 AND google_email = $2',
    [userId, googleEmail.toLowerCase()],
  );
  return rows.length ? rows[0].tokens : null;
}

/**
 * Store GCal tokens for a user+email account, upserting on composite PK.
 * If this is the user's first account, auto-set is_primary = true.
 *
 * @param {string} userId
 * @param {Object} tokens - Token data (plain or { _enc } wrapper).
 * @param {string} [googleEmail='primary@placeholder'] - Google account email.
 * @returns {Promise<void>}
 */
async function setGcalTokensForUser(userId, tokens, googleEmail) {
  const email = (googleEmail || 'primary@placeholder').toLowerCase();

  // Check if user has any existing accounts
  const { rows: existing } = await pool.query(
    'SELECT google_email FROM gcal_tokens WHERE user_id = $1',
    [userId],
  );
  const isPrimary = existing.length === 0;

  await pool.query(
    `INSERT INTO gcal_tokens (user_id, google_email, tokens, is_primary, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_id, google_email) DO UPDATE SET tokens = $3, updated_at = NOW()`,
    [userId, email, JSON.stringify(tokens), isPrimary],
  );
}

/**
 * Remove a specific GCal account for a user. If the removed account was
 * primary and others remain, promotes the oldest remaining account.
 *
 * @param {string} userId
 * @param {string} [googleEmail] - If omitted, removes ALL accounts (legacy compat).
 */
async function deleteGcalTokensForUser(userId, googleEmail) {
  if (googleEmail) {
    await pool.query(
      'DELETE FROM gcal_tokens WHERE user_id = $1 AND google_email = $2',
      [userId, googleEmail.toLowerCase()],
    );
    // Promote oldest remaining if we just deleted the primary
    await pool.query(`
      UPDATE gcal_tokens SET is_primary = true
      WHERE user_id = $1 AND google_email = (
        SELECT google_email FROM gcal_tokens WHERE user_id = $1
        ORDER BY created_at ASC LIMIT 1
      ) AND NOT EXISTS (SELECT 1 FROM gcal_tokens WHERE user_id = $1 AND is_primary = true)
    `, [userId]).catch(() => {});
  } else {
    await pool.query('DELETE FROM gcal_tokens WHERE user_id = $1', [userId]);
  }
}

/**
 * Set a specific account as primary for the user.
 *
 * @param {string} userId
 * @param {string} googleEmail
 */
async function setGcalPrimaryAccount(userId, googleEmail) {
  await pool.query('UPDATE gcal_tokens SET is_primary = false WHERE user_id = $1', [userId]);
  await pool.query(
    'UPDATE gcal_tokens SET is_primary = true WHERE user_id = $1 AND google_email = $2',
    [userId, googleEmail.toLowerCase()],
  );
}

// ── Gmail tokens & config ─────────────────────────────────────────────────────

/**
 * Load raw Gmail token data for a user. Same encryption pattern as GCal —
 * use loadGmailTokens() from server/utils/google.cjs for transparent decryption.
 *
 * @note This helper intentionally does not encrypt or decrypt tokens.
 * Encryption is the sole responsibility of server/utils/google.cjs.
 *
 * @param {string} userId - User ID.
 * @returns {Promise<Object|string|null>} Raw token data or null.
 * @throws {Error} If the database query fails.
 */
async function getGmailTokensForUser(userId) {
  const { rows } = await pool.query(
    'SELECT tokens FROM gmail_tokens WHERE user_id = $1',
    [userId],
  );
  return rows.length ? rows[0].tokens : null;
}

/**
 * Store Gmail tokens for a user, upserting on user_id conflict.
 * Use saveGmailTokens() from server/utils/google.cjs which encrypts first.
 *
 * @note This helper intentionally does not encrypt or decrypt tokens.
 * Encryption is the sole responsibility of server/utils/google.cjs.
 *
 * @param {string} userId - User ID.
 * @param {Object} tokens - Token data (plain or { _enc } wrapper).
 * @returns {Promise<void>}
 * @throws {Error} If the database query fails.
 */
async function setGmailTokensForUser(userId, tokens) {
  await pool.query(
    `INSERT INTO gmail_tokens (user_id, tokens, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET tokens = $2, updated_at = NOW()`,
    [userId, JSON.stringify(tokens)],
  );
}

/**
 * Remove Gmail tokens for a user. Called on Gmail disconnect.
 *
 * @param {string} userId - User ID.
 * @returns {Promise<void>}
 * @throws {Error} If the database query fails.
 */
async function deleteGmailTokensForUser(userId) {
  await pool.query('DELETE FROM gmail_tokens WHERE user_id = $1', [userId]);
}

/**
 * Load Gmail sync configuration for a user (label filters, sync frequency, etc.).
 *
 * @param {string} userId - User ID.
 * @returns {Promise<Object|null>} Config object or null if not configured.
 * @throws {Error} If the database query fails.
 */
async function getGmailConfigForUser(userId) {
  const { rows } = await pool.query(
    'SELECT config FROM gmail_config WHERE user_id = $1',
    [userId],
  );
  return rows.length ? rows[0].config : null;
}

/**
 * Store Gmail sync configuration for a user, upserting on conflict.
 *
 * @param {string} userId - User ID.
 * @param {Object} config - Sync configuration object.
 * @returns {Promise<void>}
 * @throws {Error} If the database query fails.
 */
async function setGmailConfigForUser(userId, config) {
  await pool.query(
    `INSERT INTO gmail_config (user_id, config, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET config = $2, updated_at = NOW()`,
    [userId, JSON.stringify(config)],
  );
}

// ── Inbox items ───────────────────────────────────────────────────────────────

/**
 * Return inbox items for a user, paginated and newest-first.
 *
 * @note Uses SELECT * which returns snake_case column names. Callers
 * (inbox.cjs routes) are expected to handle the raw column format.
 * Consider aliasing to camelCase for consistency with other helpers.
 *
 * @param {string} userId - User ID.
 * @param {number} [limit=100] - Max rows to return.
 * @param {number} [offset=0] - Rows to skip (for pagination).
 * @returns {Promise<Array<Object>>} Inbox items ordered by created_at DESC.
 * @throws {Error} If the database query fails.
 */
async function getInboxItemsForUser(userId, limit = 100, offset = 0) {
  const { rows } = await pool.query(
    'SELECT * FROM inbox_items WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
    [userId, limit, offset],
  );
  return rows;
}

/**
 * Insert a new inbox item. Used by Gmail sync and WhatsApp inbound
 * processing to surface actionable messages in the user's inbox.
 *
 * @param {Object} item
 * @param {string} item.id - Unique inbox item ID.
 * @param {string} item.userId - Owner user ID.
 * @param {string} item.type - Item type (e.g. 'email', 'whatsapp').
 * @param {string} item.title - Display title.
 * @param {string} item.summary - AI-generated summary.
 * @param {string} item.source - Source system identifier.
 * @param {string} item.sourceId - External ID for deduplication.
 * @param {string} [item.gmailThreadId] - Gmail thread ID for linking.
 * @param {string} [item.gmailLink] - Direct Gmail URL.
 * @param {string} [item.sender] - Sender display name or address.
 * @returns {Promise<void>}
 * @throws {Error} If the database query fails.
 *
 * @note This helper does not enforce ownership beyond the passed
 * userId/id values. Routes must scope access correctly before calling.
 */
async function createInboxItem(item) {
  await pool.query(
    `INSERT INTO inbox_items (id, user_id, type, title, summary, source, source_id, gmail_thread_id, gmail_link, sender, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
    [item.id, item.userId, item.type, item.title, item.summary, item.source, item.sourceId, item.gmailThreadId || null, item.gmailLink || null, item.sender || null],
  );
}

/**
 * Check if an inbox item already exists for a given source ID.
 * Used to deduplicate during Gmail sync — prevents re-importing
 * the same email thread on every sync cycle.
 *
 * @param {string} userId - User ID.
 * @param {string} sourceId - External source identifier.
 * @returns {Promise<boolean>} True if an item with this sourceId exists.
 * @throws {Error} If the database query fails.
 */
async function inboxItemExistsBySourceId(userId, sourceId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM inbox_items WHERE user_id = $1 AND source_id = $2 LIMIT 1',
    [userId, sourceId],
  );
  return rows.length > 0;
}

/**
 * Record the action taken on an inbox item (e.g. 'archived', 'snoozed').
 * Called from the inbox route when the user acts on an item.
 *
 * @note This helper does not enforce ownership beyond the passed
 * userId/id values. Routes must scope access correctly before calling.
 *
 * @param {string} id - Inbox item ID.
 * @param {string} action - Action label to store.
 * @returns {Promise<void>}
 * @throws {Error} If the database query fails.
 */
async function updateInboxItemAction(id, action) {
  await pool.query(
    'UPDATE inbox_items SET action_taken = $2 WHERE id = $1',
    [id, action],
  );
}

// ── Notes ─────────────────────────────────────────────────────────────────────

/**
 * Shared RETURNING clause for note queries. Aliased to camelCase so all
 * note helpers return a consistent shape without per-query duplication.
 * @type {string}
 */
const NOTE_RETURNING = `id, user_id AS "userId", title, content, visibility,
  type, pillar, category, subcategory, tags, pinned, archived, entity_id AS "entityId",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

/**
 * Return the main user-facing note list with optional filters,
 * excluding digests — the primary note retrieval path, distinct
 * from getPrivateNotesForAI() which is for internal AI context assembly.
 *
 * Builds a dynamic WHERE clause based on the filters provided. Digest
 * notes (type='digest') are always excluded because they have their
 * own retrieval path in the daily digest route.
 *
 * @note If no `archived` filter is specified, defaults to showing only
 * non-archived notes. Pass `archived: true` explicitly to see archived.
 *
 * @param {string} userId - User ID.
 * @param {Object} [filters={}] - Optional filters.
 * @param {string} [filters.pillar] - Filter by life pillar.
 * @param {string} [filters.entityId] - Filter by entity.
 * @param {string} [filters.category] - Filter by category name.
 * @param {boolean} [filters.pinned] - Filter pinned/unpinned.
 * @param {boolean} [filters.archived] - Filter archived state.
 * @returns {Promise<Array<Object>>} Notes ordered by pinned DESC, created_at DESC.
 * @throws {Error} If the database query fails.
 */
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

/**
 * Fetch a single note by ID, scoped to the owning user.
 *
 * @param {string} id - Note ID.
 * @param {string} userId - Owner user ID (authorization scope).
 * @returns {Promise<Object|null>} Note record or null.
 * @throws {Error} If the database query fails.
 */
async function getNoteById(id, userId) {
  const { rows } = await pool.query(
    `SELECT ${NOTE_RETURNING} FROM notes WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0] || null;
}

/**
 * Returns a minimal projection of the user's notes for AI context
 * assembly. This is an internal context-building path, not a
 * user-facing query path.
 *
 * @note Unlike getNotesForUser, this does NOT filter by visibility,
 * type, or archived status — Aria needs the full picture to give
 * context-aware responses.
 *
 * @param {string} userId - User ID.
 * @returns {Promise<Array<Object>>} Notes with id, title, content, visibility, pillar, category.
 * @throws {Error} If the database query fails.
 */
async function getPrivateNotesForAI(userId) {
  const { rows } = await pool.query(
    `SELECT id, title, content, visibility, pillar, category
     FROM notes WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

/**
 * Create a new note. Default visibility is 'private' — notes are
 * private-first by design. Used by the notes route, Aria's create_note
 * tool, and the daily digest generator.
 *
 * @param {Object} note
 * @param {string} note.id - Unique note ID.
 * @param {string} note.userId - Owner user ID.
 * @param {string} note.title - Note title.
 * @param {string} note.content - Note body (markdown).
 * @param {string} [note.visibility='private'] - 'private' or 'shared'.
 * @param {string} [note.type='quick'] - Note type: 'quick', 'digest', etc.
 * @param {string} [note.pillar] - Life pillar (hustle/home/grow/move).
 * @param {string} [note.category] - Category name.
 * @param {string} [note.subcategory] - Subcategory name.
 * @param {string[]} [note.tags] - Tag array.
 * @param {string} [note.entityId] - Associated entity ID.
 * @returns {Promise<Object>} Created note record.
 * @throws {Error} If the database query fails.
 */
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

/**
 * Partially update a note by ID, scoped to the owning user.
 * Uses the same dynamic SET pattern as updateUser() — only fields
 * present in the `fields` object are modified.
 *
 * @param {string} id - Note ID.
 * @param {string} userId - Owner user ID (authorization scope in WHERE clause).
 * @param {Object} fields - Partial note fields. Supported keys:
 *   title, content, visibility, type, pillar, category, subcategory,
 *   tags, pinned, archived, entityId.
 * @returns {Promise<Object|null>} Updated note record or null.
 * @throws {Error} If the database query fails.
 */
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

/**
 * Hard-delete a note by ID, scoped to the owning user.
 * The WHERE clause includes user_id to prevent cross-user deletion.
 *
 * @param {string} id - Note ID.
 * @param {string} userId - Owner user ID (authorization scope).
 * @returns {Promise<void>}
 * @throws {Error} If the database query fails.
 */
async function deleteNote(id, userId) {
  await pool.query('DELETE FROM notes WHERE id = $1 AND user_id = $2', [id, userId]);
}

// ── Note Images ──────────────────────────────────────────────────────────────

/**
 * Return all images attached to a note, scoped to the owning user.
 *
 * @param {string} noteId - Parent note ID.
 * @param {string} userId - Owner user ID (authorization scope).
 * @returns {Promise<Array<Object>>} Image records ordered by created_at ASC.
 * @throws {Error} If the database query fails.
 */
async function getNoteImages(noteId, userId) {
  const { rows } = await pool.query(
    `SELECT id, note_id AS "noteId", user_id AS "userId", filename, original_name AS "originalName",
            mime_type AS "mimeType", size, url, created_at AS "createdAt"
     FROM note_images WHERE note_id = $1 AND user_id = $2 ORDER BY created_at ASC`,
    [noteId, userId],
  );
  return rows;
}

/**
 * Attach an image record to a note. The actual file is stored externally
 * (URL-referenced); this stores the metadata.
 *
 * @param {Object} img
 * @param {string} img.id - Unique image ID.
 * @param {string} img.noteId - Parent note ID.
 * @param {string} img.userId - Owner user ID.
 * @param {string} img.filename - Stored filename.
 * @param {string} [img.originalName] - Original upload filename.
 * @param {string} [img.mimeType] - MIME type.
 * @param {number} [img.size] - File size in bytes.
 * @param {string} img.url - Public URL to the stored file.
 * @returns {Promise<Object>} Created image record.
 * @throws {Error} If the database query fails.
 */
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

/**
 * Delete a note image record, scoped to the owning user.
 * Returns the deleted row so the caller can clean up the external file.
 *
 * @param {string} id - Image record ID.
 * @param {string} userId - Owner user ID (authorization scope).
 * @returns {Promise<Object|null>} Deleted image record or null.
 * @throws {Error} If the database query fails.
 */
async function deleteNoteImage(id, userId) {
  const { rows } = await pool.query(
    'DELETE FROM note_images WHERE id = $1 AND user_id = $2 RETURNING *',
    [id, userId],
  );
  return rows[0] || null;
}

// ── Note Search ──────────────────────────────────────────────────────────────

/**
 * Search notes by title, content, or category using ILIKE.
 * Excludes archived notes. Limited to 50 results to bound response size.
 *
 * @note Uses ILIKE with a leading wildcard (`%query%`), which cannot
 * use a btree index. Acceptable at current scale but would need
 * full-text search (tsvector) or trigram indexes if note volume grows.
 *
 * @param {string} userId - User ID.
 * @param {string} query - Search string (case-insensitive partial match).
 * @returns {Promise<Array<Object>>} Matching notes ordered by updated_at DESC.
 * @throws {Error} If the database query fails.
 */
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

/**
 * Return all note categories for a user, ordered by pillar then name.
 * Categories form a two-level tree: pillar parents → topic children.
 *
 * @param {string} userId - User ID.
 * @returns {Promise<Array<Object>>} Category records.
 * @throws {Error} If the database query fails.
 */
async function getNoteCategories(userId) {
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", name, parent_id AS "parentId", pillar, color,
            created_at AS "createdAt"
     FROM note_categories WHERE user_id = $1 ORDER BY pillar, name`,
    [userId],
  );
  return rows;
}

/**
 * Create a note category. Used by seedNoteCategoriesIfEmpty and
 * could be exposed via a future category management UI.
 *
 * @note Uniqueness and duplicate prevention are handled by caller
 * flow and seed logic — this helper does not guard against
 * duplicate category names.
 *
 * @param {Object} cat
 * @param {string} cat.id - Unique category ID.
 * @param {string} cat.userId - Owner user ID.
 * @param {string} cat.name - Category display name.
 * @param {string} [cat.parentId] - Parent category ID (for tree nesting).
 * @param {string} [cat.pillar] - Life pillar.
 * @param {string} [cat.color] - Display color.
 * @returns {Promise<Object>} Created category record.
 * @throws {Error} If the database query fails.
 */
async function createNoteCategory({ id, userId, name, parentId, pillar, color }) {
  const { rows } = await pool.query(
    `INSERT INTO note_categories (id, user_id, name, parent_id, pillar, color)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, user_id AS "userId", name, parent_id AS "parentId", pillar, color, created_at AS "createdAt"`,
    [id, userId, name, parentId || null, pillar || null, color || ''],
  );
  return rows[0];
}

/**
 * Seed default note categories for a new user if none exist.
 * Creates the four-pillar tree structure (hustle/home/move/grow)
 * with topic subcategories under each.
 *
 * @note Idempotent — checks for existing categories before seeding.
 * Called during user onboarding flows.
 *
 * @param {string} userId - User ID to seed categories for.
 * @returns {Promise<void>}
 * @throws {Error} If any category creation fails.
 */
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
  console.log('[db] Seeded default note categories');
}

// ── User preferences ─────────────────────────────────────────────────────────

/**
 * Load a user's UI and notification preferences. Includes DND window
 * times used by the alert scheduler to suppress notifications during
 * quiet hours.
 *
 * @param {string} userId - Authenticated user ID.
 * @returns {Promise<Object|null>} Preferences row or null if never saved.
 */
async function getUserPreferences(userId) {
  const { rows } = await pool.query(
    `SELECT user_id AS "userId", theme, default_tag_filter AS "defaultTagFilter",
            default_status_filter AS "defaultStatusFilter",
            notifications_enabled AS "notificationsEnabled", updated_at AS "updatedAt",
            dnd_start AS "dndStart", dnd_end AS "dndEnd"
     FROM user_preferences WHERE user_id = $1`,
    [userId],
  );
  return rows[0] || null;
}

/**
 * Upsert a user's UI and notification preferences. Creates the row
 * on first save, updates on subsequent calls.
 *
 * @note DND fields (dndStart, dndEnd) are NOT included in this upsert —
 * they are managed separately via updateDndPreferences(). This avoids
 * accidentally clearing DND times when saving unrelated preferences.
 *
 * @param {string} userId - Authenticated user ID.
 * @param {Object} prefs - Preference fields.
 * @param {string} [prefs.theme='light'] - UI theme.
 * @param {Array<string>} [prefs.defaultTagFilter=[]] - Default tag filter on task views.
 * @param {string} [prefs.defaultStatusFilter='all'] - Default status filter.
 * @param {boolean} [prefs.notificationsEnabled=true] - Whether notifications are on.
 * @returns {Promise<void>}
 */
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

/**
 * Return legacy flat chat messages for a user (non-conversation mode).
 * Ordered ASC so messages read top-to-bottom in chronological order.
 *
 * @note This is the pre-conversation chat model. Newer code uses
 * getConversationMessages() with conversation_id scoping instead.
 *
 * @param {string} userId - User ID.
 * @param {number} [limit=50] - Max messages to return.
 * @returns {Promise<Array<Object>>} Chat messages oldest-first.
 * @throws {Error} If the database query fails.
 */
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

/**
 * Save a chat message (legacy flat model, no conversation_id).
 *
 * @param {Object} msg
 * @param {string} msg.userId - User ID.
 * @param {string} msg.role - 'user' or 'assistant'.
 * @param {string} msg.content - Message content.
 * @param {string} [msg.model='claude'] - Model that generated the response.
 * @returns {Promise<Object>} Created message record.
 * @throws {Error} If the database query fails.
 */
async function saveChatMessage({ userId, role, content, model }) {
  const { rows } = await pool.query(
    `INSERT INTO chat_messages (user_id, role, content, model)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_id AS "userId", role, content, model, created_at AS "createdAt"`,
    [userId, role, content, model || 'claude'],
  );
  return rows[0];
}

/**
 * Delete all legacy flat chat messages for a user.
 *
 * @param {string} userId - User ID.
 * @returns {Promise<void>}
 * @throws {Error} If the database query fails.
 */
async function clearChatHistory(userId) {
  await pool.query('DELETE FROM chat_messages WHERE user_id = $1', [userId]);
}

// ── Chat Conversations ──────────────────────────────────────────────────────

/**
 * Return all conversations for a user with a truncated last message preview.
 *
 * Uses LEFT JOIN LATERAL to fetch the most recent message per conversation
 * in a single query (M11 audit fix — replaced N+1 correlated subquery).
 * Message content is truncated to 100 chars in SQL via LEFT() to avoid
 * pulling full message bodies into app memory.
 *
 * @param {string} userId - User ID.
 * @returns {Promise<Array<Object>>} Conversations ordered by updated_at DESC.
 * @throws {Error} If the database query fails.
 */
async function getConversations(userId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.title, c.model, c.created_at AS "createdAt", c.updated_at AS "updatedAt",
            lm.content AS "lastMessage"
     FROM chat_conversations c
     LEFT JOIN LATERAL (
       SELECT LEFT(m.content, 100) AS content
       FROM chat_messages m
       WHERE m.conversation_id = c.id
       ORDER BY m.created_at DESC
       LIMIT 1
     ) lm ON true
     WHERE c.user_id = $1
     ORDER BY c.updated_at DESC`,
    [userId],
  );
  return rows;
}

/**
 * Fetch a single conversation by ID, scoped to the owning user.
 *
 * @param {number} id - Conversation ID.
 * @param {string} userId - Owner user ID (authorization scope).
 * @returns {Promise<Object|null>} Conversation record or null.
 * @throws {Error} If the database query fails.
 */
async function getConversation(id, userId) {
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", title, model, created_at AS "createdAt", updated_at AS "updatedAt"
     FROM chat_conversations WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0] || null;
}

/**
 * Create a new chat conversation. Title is initially NULL and gets
 * auto-set from the first user message via addConversationMessage().
 *
 * @param {string} userId - User ID.
 * @param {string} [model='claude'] - AI model identifier.
 * @returns {Promise<Object>} Created conversation record.
 * @throws {Error} If the database query fails.
 */
async function createConversation(userId, model) {
  const { rows } = await pool.query(
    `INSERT INTO chat_conversations (user_id, model) VALUES ($1, $2)
     RETURNING id, user_id AS "userId", title, model, created_at AS "createdAt", updated_at AS "updatedAt"`,
    [userId, model || 'claude'],
  );
  return rows[0];
}

/**
 * Manually rename a conversation. Also used by the auto-title flow
 * when the AI generates a summary title after the first exchange.
 *
 * @param {number} id - Conversation ID.
 * @param {string} userId - Owner user ID (authorization scope).
 * @param {string} title - New conversation title.
 * @returns {Promise<Object|null>} Updated conversation or null.
 * @throws {Error} If the database query fails.
 */
async function updateConversationTitle(id, userId, title) {
  const { rows } = await pool.query(
    `UPDATE chat_conversations SET title = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2
     RETURNING id, title, model, updated_at AS "updatedAt"`,
    [id, userId, title],
  );
  return rows[0] || null;
}

/**
 * Delete a conversation and all its messages. Deletes messages first
 * to satisfy foreign key constraints, then the conversation record.
 *
 * @note Not wrapped in a transaction. If the message delete succeeds
 * and the conversation delete fails, the conversation row will remain
 * without its messages.
 *
 * @param {number} id - Conversation ID.
 * @param {string} userId - Owner user ID (authorization scope).
 * @returns {Promise<void>}
 * @throws {Error} If the database queries fail.
 */
async function deleteConversation(id, userId) {
  await pool.query('DELETE FROM chat_messages WHERE conversation_id = $1 AND user_id = $2', [id, userId]);
  await pool.query('DELETE FROM chat_conversations WHERE id = $1 AND user_id = $2', [id, userId]);
}

/**
 * Return all messages in a conversation, ordered chronologically.
 * Scoped to the owning user to prevent cross-user message access.
 *
 * @param {number} conversationId - Conversation ID.
 * @param {string} userId - Owner user ID (authorization scope).
 * @returns {Promise<Array<Object>>} Messages oldest-first.
 * @throws {Error} If the database query fails.
 */
async function getConversationMessages(conversationId, userId) {
  const { rows } = await pool.query(
    `SELECT id, role, content, model, created_at AS "createdAt"
     FROM chat_messages WHERE conversation_id = $1 AND user_id = $2
     ORDER BY created_at ASC`,
    [conversationId, userId],
  );
  return rows;
}

/**
 * Add a message to a conversation and update the conversation timestamp.
 * If this is the first user message and the conversation has no title,
 * auto-titles with the first 50 characters of the message content.
 *
 * @note Performs three queries (insert, update timestamp, auto-title)
 * without a transaction. The auto-title is best-effort — failure
 * doesn't affect the message itself.
 *
 * @param {number} conversationId - Conversation ID.
 * @param {string} userId - User ID.
 * @param {string} role - 'user' or 'assistant'.
 * @param {string} content - Message content.
 * @param {string} [model='claude'] - Model identifier.
 * @returns {Promise<Object>} Created message record.
 * @throws {Error} If the insert query fails.
 */
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
 * Get or create the Command Center conversation for a given date.
 * The Command Center is a special daily conversation used by the
 * dashboard chat panel — one per user per day, reset on each access.
 *
 * @note This function deletes any existing command_center conversation
 * for the same date and creates a fresh one. This ensures the
 * conversation always starts clean — Aria rebuilds context from
 * the system prompt each session rather than accumulating stale history.
 *
 * @note This is intentionally different from normal chat conversations
 * which preserve history — Command Center always starts fresh each day.
 *
 * @param {string} userId - User ID.
 * @param {string} dateStr - Date in YYYY-MM-DD format for the conversation title.
 * @returns {Promise<Object>} Created conversation record.
 * @throws {Error} If the database queries fail.
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

/**
 * Partially update a task by ID using COALESCE to preserve unset fields.
 *
 * Unlike updateUser() which builds dynamic SQL, this uses a fixed-column
 * COALESCE pattern — every column is included in every UPDATE, but null
 * params leave the existing value unchanged.
 *
 * @note completedAt uses a special '__null__' sentinel value to distinguish
 * "set to NULL" from "leave unchanged". This is because SQL COALESCE
 * cannot differentiate between a null parameter meaning "no change" and
 * a null parameter meaning "clear this field". The sentinel is only used
 * internally by complete_task / uncomplete flows.
 *
 * @param {string} id - Task ID.
 * @param {Object} fields - Partial task fields to update. Supported keys:
 *   title, description, priority, dueDate, dueTime, tags, visibility,
 *   completed, googleEventId, completedAt.
 * @returns {Promise<Object|null>} Updated task record or null.
 * @throws {Error} If the database query fails.
 */
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
         completion_note = COALESCE($12, completion_note),
         updated_at      = NOW()
     WHERE id = $1
     RETURNING id, title, description, priority, status, due_date AS "dueDate",
               due_time AS "dueTime", tags, visibility, completed, completed_at AS "completedAt", owner, created_by AS "createdBy",
               google_event_id AS "googleEventId", completion_note AS "completionNote", created_at AS "createdAt", updated_at AS "updatedAt"`,
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
      fields.completionNote ?? null,
    ],
  );
  return rows[0] || null;
}

// ── User lookups and auth helpers ─────────────────────────────────────────────

/**
 * Return the minimal user context needed by authenticateToken middleware.
 *
 * This is called on every authenticated request to refresh role, timezone,
 * and entityIds from the DB — ensuring authorization decisions use current
 * state rather than stale JWT claims (see C7 audit fix).
 *
 * @note Intentionally lightweight — only selects 4 columns. Do not add
 * profile fields here; use getUserById() when full profile is needed.
 *
 * @note This function is part of the authentication critical path.
 * If this query fails or returns stale data, authorization
 * decisions may be incorrect.
 *
 * @note entityIds are returned as an array of strings and are used
 * for authorization checks across routes and tools. Always treat
 * them as source-of-truth for entity membership (see C7 audit fix).
 *
 * @param {string} id - User ID from JWT payload.
 * @returns {Promise<Object|null>} { id, timezone, role, entityIds } or null.
 * @throws {Error} If the database query fails.
 */
async function getUserAuthContext(id) {
  const { rows } = await pool.query(
    `SELECT id, timezone, role, entity_ids AS "entityIds" FROM users WHERE id = $1`,
    [id],
  );
  return rows[0] || null;
}

/**
 * Fetch a full user record by ID. Returns all profile fields, credentials,
 * and settings. Used by /api/auth/me, /api/auth/refresh, and admin routes.
 *
 * @note Includes passwordHash — callers that expose this via API must
 * strip it before sending the response.
 *
 * @param {string} id - User ID.
 * @returns {Promise<Object|null>} Full user record or null.
 * @throws {Error} If the database query fails.
 */
async function getUserById(id) {
  const { rows } = await pool.query(
    `SELECT id, username, display_name AS "displayName", password_hash AS "passwordHash",
            email, role, entity_ids AS "entityIds", active,
            persona, assistant_name AS "assistantName", whatsapp_phone AS "whatsappPhone",
            profile_name AS "profileName", profile_businesses AS "profileBusinesses",
            profile_household AS "profileHousehold", profile_location AS "profileLocation",
            profile_notes AS "profileNotes", timezone
     FROM users WHERE id = $1`,
    [id],
  );
  return rows[0] || null;
}

/**
 * Look up a user by their normalised WhatsApp phone number.
 * Used by the WhatsApp webhook to identify inbound message senders.
 *
 * The query strips non-digit characters from the stored whatsapp_phone
 * column via REGEXP_REPLACE so matching works regardless of how the
 * number was originally saved (with or without +, dashes, spaces).
 *
 * @param {string} normalizedPhone - Digits-only phone number (e.g. "14155551234").
 * @returns {Promise<Object|null>} User record or null.
 */
async function getUserByWhatsAppPhone(normalizedPhone) {
  const { rows } = await pool.query(
    `SELECT id, username, display_name AS "displayName",
            email, role, entity_ids AS "entityIds", active,
            persona, assistant_name AS "assistantName", whatsapp_phone AS "whatsappPhone",
            profile_name AS "profileName", profile_businesses AS "profileBusinesses",
            profile_household AS "profileHousehold", profile_location AS "profileLocation",
            profile_notes AS "profileNotes", timezone
     FROM users WHERE REGEXP_REPLACE(whatsapp_phone, '[^0-9]', '', 'g') = $1`,
    [normalizedPhone],
  );
  return rows[0] || null;
}

/**
 * Update a user's password hash. Used by the change-password and
 * admin reset-password flows.
 *
 * @param {string} id - User ID.
 * @param {string} newHash - New bcrypt hash to store.
 */
async function updateUserPassword(id, newHash) {
  await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [id, newHash]);
}

// ── Seed users from users.json (one-time migration) ──────────────────────────

/**
 * One-time migration: seed users from a local users.json file if the
 * users table is empty. Only runs on first boot — subsequent starts
 * skip because count > 0.
 *
 * @note users.json is a local-only file not committed to the repo.
 * If the file is missing, this silently no-ops.
 *
 * @returns {Promise<void>}
 */
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
 * Incremental migration that runs on EVERY startup. Adds columns,
 * indexes, constraints, and seeds data idempotently. Each step uses
 * IF NOT EXISTS, ON CONFLICT DO NOTHING, or .catch() to be safe on
 * re-runs.
 *
 * @note This function also promotes the seed user (user-lyle) to
 * superadmin and assigns all entities. This is intentional — the seed
 * user is the platform operator and needs full access.
 *
 * @note Errors in individual migration steps are caught and logged
 * rather than thrown, so one failing step doesn't block the rest.
 *
 * @note This function mutates live schema and data. It should
 * not be run concurrently across multiple instances without
 * coordination.
 *
 * @returns {Promise<void>}
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
      console.log('[db] Migration: set seed user as admin with all entities');
    }
  }

  // 3b. Promote lyle to superadmin (idempotent)
  if (lyle && lyle.role !== 'superadmin') {
    await updateUser('user-lyle', { role: 'superadmin' });
    console.log('[db] Migration: promoted seed user to superadmin');
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

  // 10. Add missing indexes on frequently queried user_id columns
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_inbox_items_user_id ON inbox_items(user_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_alerts_user_id ON scheduled_alerts(user_id)`).catch(() => {});

  // 11. Entity dedup: "Buyflip" → "BuyFlip" (canonical brand casing)
  await pool.query(`
    UPDATE tasks
    SET tags = CASE
      WHEN tags @> '["BuyFlip"]'::jsonb THEN tags - 'Buyflip'
      ELSE (tags - 'Buyflip') || '["BuyFlip"]'::jsonb
    END
    WHERE tags @> '["Buyflip"]'::jsonb
  `).catch(() => {});
  await pool.query(`DELETE FROM entities WHERE id = 'entity-buyflip'`).catch(() => {});

  // 12. Entity dedup: "kids" → "Kids" (canonical capitalized)
  await pool.query(`
    UPDATE entities SET name = 'Kids'
    WHERE LOWER(name) = 'kids' AND name != 'Kids'
  `).catch(() => {});
  await pool.query(`
    UPDATE tasks
    SET tags = CASE
      WHEN tags @> '["Kids"]'::jsonb THEN tags - 'kids'
      ELSE (tags - 'kids') || '["Kids"]'::jsonb
    END
    WHERE tags @> '["kids"]'::jsonb
  `).catch(() => {});
  await pool.query(`DELETE FROM entities WHERE id = 'entity-mnnstudn-60ux4a'`).catch(() => {});

  // 13. Prevent future case-insensitive entity name duplicates
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_lower_name ON entities (LOWER(name))`).catch(() => {});

  // 14. Multi-account GCal: add google_email, is_primary, created_at columns
  //     and migrate from single-row-per-user to composite PK (user_id, google_email).
  await pool.query(`ALTER TABLE gcal_tokens ADD COLUMN IF NOT EXISTS google_email TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE gcal_tokens ADD COLUMN IF NOT EXISTS is_primary BOOLEAN DEFAULT false`).catch(() => {});
  await pool.query(`ALTER TABLE gcal_tokens ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`).catch(() => {});

  // Backfill: set placeholder email + is_primary for any legacy rows missing google_email
  await pool.query(`
    UPDATE gcal_tokens SET google_email = 'primary@placeholder', is_primary = true
    WHERE google_email IS NULL
  `).catch(() => {});

  // Check if PK is still single-column (user_id only) and migrate to composite
  try {
    const { rows: pkCols } = await pool.query(`
      SELECT a.attname FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'gcal_tokens'::regclass AND i.indisprimary
      ORDER BY array_position(i.indkey, a.attnum)
    `);
    const pkColNames = pkCols.map(r => r.attname);
    if (pkColNames.length === 1 && pkColNames[0] === 'user_id') {
      console.log('[migration] gcal_tokens: migrating PK from (user_id) to (user_id, google_email)');
      // Ensure no nulls before setting NOT NULL
      await pool.query(`UPDATE gcal_tokens SET google_email = 'primary@placeholder' WHERE google_email IS NULL`);
      await pool.query(`ALTER TABLE gcal_tokens DROP CONSTRAINT gcal_tokens_pkey`);
      await pool.query(`ALTER TABLE gcal_tokens ALTER COLUMN google_email SET NOT NULL`);
      await pool.query(`ALTER TABLE gcal_tokens ADD PRIMARY KEY (user_id, google_email)`);
      console.log('[migration] gcal_tokens: PK migration complete');
    }
  } catch (err) {
    console.warn('[migration] gcal_tokens PK check/migration:', err.message);
  }

  // Ensure google_email is NOT NULL even if PK migration was already done
  await pool.query(`ALTER TABLE gcal_tokens ALTER COLUMN google_email SET NOT NULL`).catch(() => {});

  // ── audit_log table ──────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id            SERIAL PRIMARY KEY,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      actor_id      TEXT,
      entity_type   TEXT NOT NULL,
      entity_id     TEXT NOT NULL,
      action        TEXT NOT NULL,
      changes       JSONB,
      request_id    TEXT,
      metadata      JSONB DEFAULT '{}'::jsonb,
      source        TEXT DEFAULT 'api'
    )
  `).catch((err) => console.warn('[migration] audit_log table:', err.message));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_user   ON audit_log(user_id, created_at DESC)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_req    ON audit_log(request_id)`).catch(() => {});

  // ── whatsapp_conversations table ────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_conversations (
      id          SERIAL PRIMARY KEY,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      user_id     TEXT NOT NULL,
      phone       TEXT NOT NULL,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL
    );
  `).catch((err) => console.warn('[migration] whatsapp_conversations table:', err.message));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_whatsapp_conv_phone ON whatsapp_conversations(phone, created_at DESC)`).catch(() => {});
}

// ── Financial Accounts ────────────────────────────────────────────────────────

/**
 * Fetch financial accounts. Admins see all accounts; regular users
 * see only their own.
 *
 * @param {string} userId - Authenticated user ID.
 * @param {string} role - User role from JWT/DB — 'admin' bypasses user scoping.
 * @returns {Promise<Array<Object>>} Financial account rows, newest first.
 * @throws {Error} If the database query fails.
 *
 * @note Admin access bypasses user scoping — callers must ensure
 * the admin role is verified before passing role='admin'.
 */
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

/**
 * Create a new financial account and return the inserted row.
 *
 * @param {Object} account
 * @param {string} account.id - Pre-generated account ID.
 * @param {string} account.userId - Owning user ID.
 * @param {string} account.name - Account display name.
 * @param {string} [account.type='checking'] - Account type (checking, savings, credit, etc.).
 * @param {string} [account.institution] - Bank or institution name.
 * @param {string} [account.currency='USD'] - ISO currency code.
 * @param {string} [account.entityId] - Associated entity ID.
 * @param {string} [account.accountClass='personal'] - personal or business classification.
 * @returns {Promise<Object>} The created account row.
 */
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

/**
 * Partial-update a financial account. Only fields present in input are SET.
 *
 * @param {string} id - Account ID.
 * @param {Object} fields - Fields to update.
 * @returns {Promise<Object|null>} Updated row, or null if no fields or not found.
 */
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

/**
 * Delete a financial account and all its transactions. Transactions
 * are deleted first to avoid FK constraint violations.
 *
 * @note This is a cascading delete — all transaction history for the
 * account is permanently lost. The route handler must verify ownership
 * via requireOwnership() before calling this.
 *
 * @param {string} id - Account ID to delete.
 * @returns {Promise<void>}
 */
async function deleteFinancialAccount(id) {
  await pool.query('DELETE FROM transactions WHERE account_id = $1', [id]);
  await pool.query('DELETE FROM financial_accounts WHERE id = $1', [id]);
}

// ── Transactions ──────────────────────────────────────────────────────────────

/**
 * Fetch transactions with optional filters. Admins see all; regular
 * users see only their own. Supports filtering by account, entity,
 * accountClass, category, and date range.
 *
 * @param {string} userId - Authenticated user ID.
 * @param {string} role - User role — 'admin' bypasses user scoping.
 * @param {Object} [filters={}] - Optional query filters.
 * @param {string} [filters.accountId] - Filter to a specific account.
 * @param {string} [filters.entityId] - Filter to a specific entity.
 * @param {string} [filters.accountClass] - Filter by personal/business.
 * @param {string} [filters.category] - Filter by spending category.
 * @param {string} [filters.startDate] - Inclusive start date (YYYY-MM-DD).
 * @param {string} [filters.endDate] - Inclusive end date (YYYY-MM-DD).
 * @returns {Promise<Array<Object>>} Transaction rows, newest first.
 *
 * @note Admin access bypasses user scoping — callers must ensure
 * the admin role is verified before passing role='admin'.
 */
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

/**
 * Create a single transaction and return the inserted row.
 *
 * @param {Object} txn
 * @param {string} txn.id - Pre-generated transaction ID.
 * @param {string} txn.accountId - Parent financial account ID.
 * @param {string} txn.userId - Owning user ID.
 * @param {string} txn.date - Transaction date (YYYY-MM-DD).
 * @param {string} [txn.description] - Transaction description.
 * @param {number} txn.amount - Transaction amount.
 * @param {string} [txn.type='debit'] - credit or debit.
 * @param {string} [txn.category='Uncategorized'] - Spending category.
 * @param {string} [txn.entityId] - Associated entity ID.
 * @param {string} [txn.accountClass='personal'] - personal or business.
 * @param {string} [txn.notes] - Optional notes.
 * @returns {Promise<Object>} The created transaction row.
 */
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

/**
 * Insert multiple transactions in a single database transaction.
 * Used by CSV import flows. All-or-nothing — rolls back on any failure.
 *
 * @param {Array<Object>} txns - Array of transaction objects (same shape as createTransaction).
 * @returns {Promise<Array<Object>>} All created transaction rows.
 * @throws {Error} Rolls back the transaction and rethrows on any insert failure.
 */
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

/**
 * Delete a single transaction by ID.
 *
 * @param {string} id - Transaction ID to delete.
 * @returns {Promise<void>}
 */
async function deleteTransaction(id) {
  await pool.query('DELETE FROM transactions WHERE id = $1', [id]);
}

/**
 * Partial-update a transaction. Only fields present in input are SET.
 *
 * @param {string} id - Transaction ID.
 * @param {Object} fields - Fields to update (date, description, amount, type, category, entityId, accountClass, notes).
 * @returns {Promise<Object|null>} Updated row, or null if no fields or not found.
 */
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

/**
 * Build a financial summary: monthly income/expenses by entity and
 * account class, per-account balances, and top spending categories.
 * Admins see all data; regular users see only their own.
 *
 * @note Balance is computed as SUM(credits) - SUM(debits), not stored.
 * This means balance accuracy depends on all transactions being present.
 *
 * @param {string} userId - Authenticated user ID.
 * @param {string} role - User role — 'admin' bypasses user scoping.
 * @returns {Promise<Object>} { monthly, balances, topCategories }.
 *
 * @note This is an aggregate query — may become expensive as
 * transaction volume grows. Consider caching or pagination
 * if needed at scale.
 */
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

/**
 * Return the first organization a user belongs to, with their
 * membership role. Returns null if the user has no org membership.
 *
 * @note LIMIT 1 assumes single-org membership. If multi-org support
 * is added, this must return an array.
 *
 * @param {string} userId - Authenticated user ID.
 * @returns {Promise<Object|null>} Org row with memberRole, or null.
 */
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

/**
 * Return all organizations with member counts. Used by the super admin
 * panel for org management.
 *
 * @returns {Promise<Array<Object>>} Org rows with memberCount.
 * @throws {Error} If the database query fails.
 */
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

/**
 * Create a new organization and return the inserted row.
 *
 * @param {Object} org
 * @param {string} org.id - Pre-generated org ID.
 * @param {string} org.name - Org display name.
 * @param {string} [org.type='household'] - Org type (household, business, etc.).
 * @param {string} org.createdBy - User ID of the creator.
 * @returns {Promise<Object>} The created org row.
 * @throws {Error} If the database query fails.
 */
async function createOrganization({ id, name, type, createdBy }) {
  const { rows } = await pool.query(
    `INSERT INTO organizations (id, name, type, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, type, active, created_by AS "createdBy", created_at AS "createdAt"`,
    [id, name, type || 'household', createdBy],
  );
  return rows[0];
}

/**
 * Partial-update an organization (name, active status).
 *
 * @param {string} id - Org ID.
 * @param {Object} fields - Fields to update.
 * @returns {Promise<Object|null>} Updated row, or null if no fields or not found.
 */
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

/**
 * Add a user to an organization. ON CONFLICT DO NOTHING makes this
 * idempotent — re-inviting an existing member is a no-op.
 *
 * @param {string} orgId - Organization ID.
 * @param {string} userId - User ID to add.
 * @param {string} role - Membership role (e.g. 'member', 'admin').
 * @param {string} invitedBy - User ID who sent the invite.
 * @returns {Promise<void>}
 * @throws {Error} If the database query fails.
 */
async function addOrgMember(orgId, userId, role, invitedBy) {
  await pool.query(
    `INSERT INTO org_members (org_id, user_id, role, invited_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id, user_id) DO NOTHING`,
    [orgId, userId, role, invitedBy],
  );
}

// ── Invites ────────────────────────────────────────────────────────────────

/**
 * Create an invite token for a new user. The token is included in the
 * registration URL — users cannot register without a valid invite.
 *
 * @param {Object} invite
 * @param {string} invite.id - Pre-generated invite ID.
 * @param {string} invite.token - Unique invite token for the registration URL.
 * @param {string} invite.email - Invited email address.
 * @param {string} invite.orgId - Organization to join on acceptance.
 * @param {string} [invite.role='member'] - Role assigned on acceptance.
 * @param {string} invite.invitedBy - Super admin user ID who created the invite.
 * @param {string} invite.expiresAt - ISO 8601 expiration timestamp.
 * @returns {Promise<Object>} The created invite row.
 */
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

/**
 * Look up an invite by its token. Used during registration to validate
 * the invite and determine org membership. Joins organizations to
 * include orgName for display.
 *
 * @param {string} token - Invite token from the registration URL.
 * @returns {Promise<Object|null>} Invite row with orgName, or null if invalid.
 */
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

/**
 * Mark an invite as accepted by setting accepted_at. Called after
 * successful registration to prevent token reuse.
 *
 * @note This only timestamps the invite — the actual org membership
 * is created separately via addOrgMember(). The auth route handles
 * both steps.
 *
 * @param {string} token - Invite token to mark as accepted.
 * @param {string} userId - User ID who accepted (unused in query, kept for audit trail).
 * @returns {Promise<void>}
 */
async function acceptInvite(token, userId) {
  await pool.query(
    `UPDATE invites SET accepted_at = NOW() WHERE token = $1`,
    [token],
  );
}

// ── Audit log ──────────────────────────────────────────────────────────────

/**
 * Record an admin action to the audit log. Called by super admin routes
 * for traceability on sensitive operations (user CRUD, impersonation, etc.).
 *
 * @param {Object} entry
 * @param {string} entry.superAdminUserId - Admin who performed the action.
 * @param {string} entry.action - Action name (e.g. 'create_user', 'suspend_user').
 * @param {string} [entry.targetType] - Target entity type (e.g. 'user', 'org').
 * @param {string} [entry.targetId] - Target entity ID.
 * @param {Object} [entry.metadata={}] - Additional context, stored as JSONB.
 * @returns {Promise<void>}
 */
async function logAdminAction({ superAdminUserId, action, targetType, targetId, metadata }) {
  await pool.query(
    `INSERT INTO admin_audit_log (super_admin_user_id, action, target_type, target_id, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [superAdminUserId, action, targetType || null, targetId || null, JSON.stringify(metadata || {})],
  );
}

/**
 * Return paginated admin audit log entries, newest first.
 * Used by the super admin panel's audit log viewer.
 *
 * @param {number} [limit=20] - Max rows to return.
 * @param {number} [offset=0] - Pagination offset.
 * @returns {Promise<Array<Object>>} Audit log entries.
 * @throws {Error} If the database query fails.
 */
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

/**
 * Return all users with their org membership (if any). Used by the
 * super admin panel's user management table. LEFT JOINs ensure users
 * without org membership still appear.
 *
 * @returns {Promise<Array<Object>>} User rows with orgName and orgId.
 */
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

/**
 * Log an action to agent memory. Called after each tool execution in
 * tools.cjs to build a history of what Aria has done for the user.
 * This feeds into Aria's context window so she can reference past actions.
 *
 * @note Memory logging is always best-effort — callers wrap this in
 * try/catch with swallowed errors so a failed memory write never
 * blocks the primary action.
 *
 * @param {Object} entry
 * @param {string} entry.userId - User ID.
 * @param {string} [entry.type='action'] - Memory type.
 * @param {string} entry.content - Human-readable description of the action.
 * @param {string} [entry.tool] - Tool name (e.g. 'create_task').
 * @param {Object} [entry.metadata={}] - Structured data for later retrieval.
 * @returns {Promise<void>}
 * @throws {Error} If the database query fails.
 */
async function logMemory({ userId, type = 'action', content, tool = null, metadata = {} }) {
  const id = `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await pool.query(
    `INSERT INTO agent_memory (id, user_id, type, content, tool, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, userId, type, content, tool, JSON.stringify(metadata)]
  );
}

/**
 * Return recent tool-action memories for a user. Used to inject recent
 * action history into Aria's system prompt for context continuity.
 *
 * @note Filters to task/event tool actions only — general memories
 * and notes are excluded to keep the context window focused.
 *
 * @note The result is prompt-facing context data, not an audit log —
 * use getAllMemories() for admin visibility.
 *
 * @param {string} userId - User ID.
 * @param {number} [limit=20] - Max memories to return.
 * @returns {Promise<Array<Object>>} Memories newest-first.
 * @throws {Error} If the database query fails.
 */
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

/**
 * Return all agent memories with user display names, paginated.
 * Used by the admin panel's memory viewer. Optionally filtered to
 * a single user.
 *
 * @param {Object} opts
 * @param {number} [opts.limit=30] - Max rows.
 * @param {number} [opts.offset=0] - Pagination offset.
 * @param {string} [opts.userId] - Filter to a specific user, or null for all.
 * @returns {Promise<Array<Object>>} Memories with user displayName and username.
 * @throws {Error} If the database query fails.
 */
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

/**
 * Delete a single agent memory entry by ID. Used by admin memory management.
 *
 * @param {string} id - Memory entry ID.
 * @returns {Promise<void>}
 * @throws {Error} If the database query fails.
 */
async function deleteMemory(id) {
  await pool.query('DELETE FROM agent_memory WHERE id = $1', [id]);
}

// ── Alert Cadence Config ──────────────────────────────────────────────────

/**
 * Default alert cadence configurations seeded for new users. Defines
 * how many notifications fire per priority level, how far before the
 * due time, and which channels to use.
 *
 * @note The 'floating' priority uses day_of_week + hour offsets instead
 * of minutes_before — it fires on a fixed weekly schedule (Sunday 8am
 * digest) rather than relative to a due date.
 *
 * @type {Array<Object>}
 */
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

/**
 * Seed default cadence configs for a new user. ON CONFLICT DO NOTHING
 * makes this idempotent — safe to call multiple times.
 *
 * @param {string} userId - User ID to seed defaults for.
 * @returns {Promise<void>}
 */
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

/**
 * Return all cadence configs for a user, ordered by priority.
 * Used by the alerts settings UI to display and edit notification timing.
 *
 * @param {string} userId - Authenticated user ID.
 * @returns {Promise<Array<Object>>} Cadence config rows.
 * @throws {Error} If the database query fails.
 */
async function getCadenceConfigForUser(userId) {
  const { rows } = await pool.query(
    `SELECT id, priority, offsets, channels, enabled, updated_at AS "updatedAt"
     FROM alert_cadence_config WHERE user_id = $1 ORDER BY priority`,
    [userId]
  );
  return rows;
}

/**
 * Create or update a cadence config for a specific priority level.
 * ON CONFLICT on (user_id, priority) ensures one config per priority per user.
 *
 * @param {string} userId - Authenticated user ID.
 * @param {string} priority - Priority level (high, medium, low, floating).
 * @param {Array<Object>} offsets - Alert timing offsets.
 * @param {Array<string>} channels - Notification channels (whatsapp, email, slack).
 * @param {boolean} enabled - Whether this cadence is active.
 * @returns {Promise<void>}
 * @throws {Error} If the database query fails.
 */
async function upsertCadenceConfig(userId, priority, offsets, channels, enabled) {
  await pool.query(
    `INSERT INTO alert_cadence_config (user_id, priority, offsets, channels, enabled, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (user_id, priority) DO UPDATE SET
       offsets = $3, channels = $4, enabled = $5, updated_at = NOW()`,
    [userId, priority, JSON.stringify(offsets), JSON.stringify(channels), enabled]
  );
}

/**
 * Set a user's Do Not Disturb window. Stored in user_preferences
 * (not cadence config) because DND applies across all priorities.
 * The cron scheduler checks these times to suppress alerts.
 *
 * @param {string} userId - Authenticated user ID.
 * @param {string} dndStart - DND start time (HH:MM, user's local timezone).
 * @param {string} dndEnd - DND end time (HH:MM, user's local timezone).
 * @returns {Promise<void>}
 * @throws {Error} If the database query fails.
 */
async function updateDndPreferences(userId, dndStart, dndEnd) {
  await pool.query(
    `INSERT INTO user_preferences (user_id, dnd_start, dnd_end, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id) DO UPDATE SET dnd_start = $2, dnd_end = $3, updated_at = NOW()`,
    [userId, dndStart, dndEnd]
  );
}

/**
 * Get the current UTC offset string (e.g. "-07:00") for a given IANA timezone.
 * Uses Intl.DateTimeFormat to resolve the offset at the current instant,
 * so DST transitions are handled automatically.
 *
 * @note Falls back to "-07:00" (US Pacific) if the timezone string cannot
 * be parsed. This matches the app-wide default timezone.
 *
 * @param {string} tz - IANA timezone string (e.g. 'America/Los_Angeles').
 * @returns {string} UTC offset in ±HH:MM format.
 */
function getTimezoneOffset(tz) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'shortOffset',
  });
  const parts = formatter.formatToParts(new Date());
  const offsetPart = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT-7';
  const match = offsetPart.match(/GMT([+-]?\d+)(?::(\d+))?/);
  if (!match) return '-07:00';
  const hours = parseInt(match[1], 10);
  const mins = parseInt(match[2] || '0', 10);
  const sign = hours >= 0 ? '+' : '-';
  return `${sign}${String(Math.abs(hours)).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

/**
 * Schedule alert notifications for a task based on the user's cadence config.
 *
 * Deletes any existing unfired alerts for the task (idempotent on re-schedule),
 * then creates new scheduled_alerts rows for each cadence offset that falls
 * in the future. Called by create_task and update_task when due_date or
 * priority changes.
 *
 * Two cadence offset types are supported:
 *   - minutes_before: fire N minutes before the due datetime.
 *   - day_of_week + hour: fire at a specific weekly time (e.g. Monday 9am digest).
 *
 * @note The fallback chain (tz param → user profile → Pacific) exists
 * for migration safety and defensive scheduling paths. Callers should
 * always pass an explicit timezone whenever available.
 *
 * @note Alert messages are personalised with the user's first name and
 * a priority-appropriate closing line. The message is pre-rendered at
 * scheduling time — not at fire time — so name changes after scheduling
 * won't affect already-scheduled alerts.
 *
 * @param {string} userId - User ID.
 * @param {string} taskId - Task ID.
 * @param {string} taskTitle - Task title for the alert message.
 * @param {string} dueDate - Due date in YYYY-MM-DD format.
 * @param {string|null} dueTime - Due time in HH:MM 24hr format, or null (defaults to 09:00).
 * @param {string} priority - 'low', 'medium', or 'high'.
 * @param {string} [tz] - IANA timezone. Falls back to user profile, then Pacific.
 * @throws {Error} If the database queries fail.
 */
async function scheduleTaskAlerts(userId, taskId, taskTitle, dueDate, dueTime, priority, tz) {
  // Load user for personalized messages and timezone fallback
  const user = await getUserById(userId);
  if (!tz) tz = user?.timezone || 'America/Los_Angeles';
  const firstName = (user?.profileName || user?.displayName || '').split(' ')[0] || 'there';

  // Load cadence config for this user + priority
  const { rows: configs } = await pool.query(
    `SELECT offsets, channels FROM alert_cadence_config
     WHERE user_id = $1 AND priority = $2 AND enabled = TRUE`,
    [userId, priority || 'medium']
  );
  if (!configs.length) return;

  const cfg = configs[0];
  const cadenceOffsets = cfg.offsets || [];
  const channels = cfg.channels || ['whatsapp'];

  // Build due datetime with explicit timezone offset
  const tzOffset = getTimezoneOffset(tz);
  const dueStr = dueTime
    ? `${dueDate}T${dueTime}:00${tzOffset}`
    : `${dueDate}T09:00:00${tzOffset}`;
  const dueDt = new Date(dueStr);
  if (isNaN(dueDt.getTime())) return;

  // Delete existing unfired alerts for this task
  await pool.query(
    `DELETE FROM scheduled_alerts WHERE task_id = $1 AND user_id = $2 AND fired = FALSE`,
    [taskId, userId]
  );

  const now = new Date();

  for (const cadenceOffset of cadenceOffsets) {
    let fireAt;
    if (cadenceOffset.minutes_before !== undefined) {
      fireAt = new Date(dueDt.getTime() - cadenceOffset.minutes_before * 60000);
    } else if (cadenceOffset.day_of_week !== undefined && cadenceOffset.hour !== undefined) {
      // Next occurrence of day_of_week at given hour
      const target = new Date(now);
      const currentDay = target.getDay();
      let daysAhead = cadenceOffset.day_of_week - currentDay;
      if (daysAhead <= 0) daysAhead += 7;
      target.setDate(target.getDate() + daysAhead);
      target.setHours(cadenceOffset.hour, 0, 0, 0);
      fireAt = target;
    } else {
      continue;
    }

    // Skip past fire times
    if (fireAt <= now) continue;

    // Format due time as 12-hour (e.g. "4:48pm")
    let timeStr;
    if (dueTime) {
      const [h, m] = dueTime.split(':').map(Number);
      const ampm = h >= 12 ? 'pm' : 'am';
      const h12 = h % 12 || 12;
      timeStr = `${h12}:${String(m).padStart(2, '0')}${ampm}`;
    }

    const closingLines = {
      high: "This one's time-sensitive — don't let it slip.",
      medium: 'Good time to get ahead of it.',
      low: 'When you get a chance.',
      floating: 'No hard deadline, but worth a look today.',
    };
    const closing = closingLines[priority] || closingLines.medium;
    const message = timeStr
      ? `Hey ${firstName} — you've got "${taskTitle}" due at ${timeStr}.\n\n${closing}`
      : `Hey ${firstName} — you've got "${taskTitle}" due today.\n\n${closing}`;
    const alertKey = `sched::${taskId}::${cadenceOffset.minutes_before ?? `dow${cadenceOffset.day_of_week}h${cadenceOffset.hour}`}`;

    await pool.query(
      `INSERT INTO scheduled_alerts (user_id, task_id, alert_key, message, channels, fire_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, taskId, alertKey, message, JSON.stringify(channels), fireAt.toISOString()]
    );
  }
}

/**
 * Return scheduled alerts that are due to fire now, filtered by DND.
 *
 * Joins scheduled_alerts → users → tasks → user_preferences to compute
 * per-user Do Not Disturb windows using the user's timezone. Excludes
 * alerts for completed tasks (prevents firing after task completion).
 *
 * @note The DND check uses AT TIME ZONE with each user's timezone so
 * a single query correctly handles users across multiple timezones.
 * The CASE handles wraparound DND windows (e.g. 22:00–07:00).
 *
 * @note Limited to 50 rows per invocation to bound cron job execution
 * time. The cron runs every minute, so a backlog drains over time.
 *
 * @returns {Promise<Array<Object>>} Unfired alerts with user contact info.
 * @throws {Error} If the database query fails.
 */
async function getUnfiredAlerts() {
  // Per-user DND check: compute each user's local time via AT TIME ZONE
  const { rows } = await pool.query(
    `SELECT sa.id, sa.user_id, sa.task_id, sa.alert_key, sa.message, sa.channels, sa.fire_at,
            u.whatsapp_phone AS "whatsappPhone", u.email
     FROM scheduled_alerts sa
     JOIN users u ON u.id = sa.user_id
     JOIN tasks t ON t.id = sa.task_id
     LEFT JOIN user_preferences up ON up.user_id = sa.user_id
     WHERE sa.fired = FALSE AND sa.fire_at <= NOW()
       AND t.completed = FALSE
       AND NOT (
         CASE
           WHEN COALESCE(up.dnd_start, '22:00') > COALESCE(up.dnd_end, '07:00')
             THEN (NOW() AT TIME ZONE COALESCE(u.timezone, 'America/Los_Angeles'))::time >= COALESCE(up.dnd_start, '22:00')::time
                OR (NOW() AT TIME ZONE COALESCE(u.timezone, 'America/Los_Angeles'))::time < COALESCE(up.dnd_end, '07:00')::time
           ELSE (NOW() AT TIME ZONE COALESCE(u.timezone, 'America/Los_Angeles'))::time >= COALESCE(up.dnd_start, '22:00')::time
            AND (NOW() AT TIME ZONE COALESCE(u.timezone, 'America/Los_Angeles'))::time < COALESCE(up.dnd_end, '07:00')::time
         END
       )
     ORDER BY sa.fire_at ASC
     LIMIT 50`
  );
  return rows;
}

/**
 * Mark an alert as fired so it is not returned by getUnfiredAlerts() again.
 * Called by the cron scheduler after successful delivery.
 *
 * @param {number} alertId - Scheduled alert row ID.
 * @returns {Promise<void>}
 */
async function markScheduledAlertFired(alertId) {
  await pool.query(
    `UPDATE scheduled_alerts SET fired = TRUE, fired_at = NOW() WHERE id = $1`,
    [alertId]
  );
}

/**
 * Check which alert keys have already fired for a user in the last 24 hours.
 * Used by the frontend alert evaluation flow to avoid duplicate notifications.
 *
 * @note This is the legacy client-side alert system (fired_alerts table),
 * separate from the server-side scheduled_alerts cron system.
 *
 * @param {string} userId - Authenticated user ID.
 * @param {Array<string>} keys - Alert keys to check.
 * @returns {Promise<Array<string>>} Keys that have already fired.
 */
async function checkFiredAlerts(userId, keys) {
  if (!keys || keys.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT alert_key FROM fired_alerts
     WHERE user_id = $1 AND alert_key = ANY($2) AND fired_at >= NOW() - INTERVAL '24 hours'`,
    [userId, keys]
  );
  return rows.map(r => r.alert_key);
}

/**
 * Record that an alert key has fired for a user. ON CONFLICT DO NOTHING
 * makes this idempotent — calling twice for the same key is a no-op.
 *
 * @param {string} userId - Authenticated user ID.
 * @param {string} key - Unique alert key to mark as fired.
 * @returns {Promise<void>}
 */
async function markFiredAlert(userId, key) {
  await pool.query(
    `INSERT INTO fired_alerts (user_id, alert_key) VALUES ($1, $2)
     ON CONFLICT (user_id, alert_key) DO NOTHING`,
    [userId, key]
  );
}

// ── Calendar Notes ──────────────────────────────────────────────────────────

async function getCalendarNote(userId, eventId) {
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", event_id AS "eventId", event_title AS "eventTitle",
            event_start AS "eventStart", event_end AS "eventEnd", source_account AS "sourceAccount",
            pre_note AS "preNote", post_note AS "postNote", post_alert_sent AS "postAlertSent",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM calendar_notes WHERE user_id = $1 AND event_id = $2`,
    [userId, eventId],
  );
  return rows[0] || null;
}

async function upsertCalendarNote(userId, eventId, fields) {
  const { eventTitle, eventStart, eventEnd, sourceAccount, preNote, postNote } = fields;
  const { rows } = await pool.query(
    `INSERT INTO calendar_notes (user_id, event_id, event_title, event_start, event_end, source_account, pre_note, post_note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, event_id) DO UPDATE SET
       event_title = COALESCE($3, calendar_notes.event_title),
       event_start = COALESCE($4, calendar_notes.event_start),
       event_end = COALESCE($5, calendar_notes.event_end),
       source_account = COALESCE($6, calendar_notes.source_account),
       pre_note = COALESCE($7, calendar_notes.pre_note),
       post_note = COALESCE($8, calendar_notes.post_note),
       updated_at = NOW()
     RETURNING id, user_id AS "userId", event_id AS "eventId", event_title AS "eventTitle",
               event_start AS "eventStart", event_end AS "eventEnd", source_account AS "sourceAccount",
               pre_note AS "preNote", post_note AS "postNote", post_alert_sent AS "postAlertSent",
               created_at AS "createdAt", updated_at AS "updatedAt"`,
    [userId, eventId, eventTitle || null, eventStart || null, eventEnd || null, sourceAccount || null, preNote || null, postNote || null],
  );
  return rows[0];
}

async function getCalendarNotesHistory(userId, { search, dateRange, limit } = {}) {
  const conditions = ['user_id = $1', "(COALESCE(pre_note, '') != '' OR COALESCE(post_note, '') != '')"];
  const params = [userId];
  let paramIdx = 2;

  if (dateRange && dateRange !== 'all') {
    const intervals = { today: '1 day', week: '7 days', month: '30 days', '3months': '90 days' };
    const interval = intervals[dateRange];
    if (interval) {
      conditions.push(`(event_start IS NULL OR event_start >= NOW() - INTERVAL '${interval}')`);
    }
  }

  if (search) {
    conditions.push(`(event_title ILIKE $${paramIdx} OR pre_note ILIKE $${paramIdx} OR post_note ILIKE $${paramIdx})`);
    params.push(`%${search}%`);
    paramIdx++;
  }

  const maxRows = Math.min(parseInt(limit, 10) || 50, 200);
  const { rows } = await pool.query(
    `SELECT id, event_id AS "eventId", event_title AS "eventTitle",
            event_start AS "eventStart", event_end AS "eventEnd", source_account AS "sourceAccount",
            pre_note AS "preNote", post_note AS "postNote",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM calendar_notes
     WHERE ${conditions.join(' AND ')}
     ORDER BY event_start DESC NULLS LAST
     LIMIT ${maxRows}`,
    params,
  );
  return rows;
}

async function getCalendarNotesForAI(userId) {
  const { rows } = await pool.query(
    `SELECT event_id AS "eventId", event_title AS "eventTitle",
            event_start AS "eventStart", event_end AS "eventEnd", source_account AS "sourceAccount",
            pre_note AS "preNote", post_note AS "postNote"
     FROM calendar_notes
     WHERE user_id = $1
       AND event_start >= NOW() - INTERVAL '7 days'
       AND event_start <= NOW() + INTERVAL '7 days'
       AND (pre_note IS NOT NULL OR post_note IS NOT NULL)
     ORDER BY event_start ASC
     LIMIT 30`,
    [userId],
  );
  return rows;
}

async function getRecentlyEndedEventsForAlerts() {
  const { rows } = await pool.query(
    `SELECT cn.id, cn.user_id AS "userId", cn.event_id AS "eventId",
            cn.event_title AS "eventTitle", cn.event_end AS "eventEnd",
            u.whatsapp_phone AS "whatsappPhone", u.email, u.timezone
     FROM calendar_notes cn
     JOIN users u ON u.id = cn.user_id
     LEFT JOIN user_preferences up ON up.user_id = cn.user_id
     WHERE cn.post_alert_sent = false
       AND cn.event_end IS NOT NULL
       AND cn.event_end <= NOW()
       AND cn.event_end >= NOW() - INTERVAL '5 minutes'
       AND NOT (
         CASE
           WHEN COALESCE(up.dnd_start, '22:00') > COALESCE(up.dnd_end, '07:00')
             THEN (NOW() AT TIME ZONE COALESCE(u.timezone, 'America/Los_Angeles'))::time >= COALESCE(up.dnd_start, '22:00')::time
                OR (NOW() AT TIME ZONE COALESCE(u.timezone, 'America/Los_Angeles'))::time < COALESCE(up.dnd_end, '07:00')::time
           ELSE (NOW() AT TIME ZONE COALESCE(u.timezone, 'America/Los_Angeles'))::time >= COALESCE(up.dnd_start, '22:00')::time
            AND (NOW() AT TIME ZONE COALESCE(u.timezone, 'America/Los_Angeles'))::time < COALESCE(up.dnd_end, '07:00')::time
         END
       )
     LIMIT 20`
  );
  return rows;
}

async function markCalendarNoteAlertSent(userId, eventId) {
  await pool.query(
    `UPDATE calendar_notes SET post_alert_sent = true WHERE user_id = $1 AND event_id = $2`,
    [userId, eventId],
  );
}

// ── WhatsApp conversation history ────────────────────────────────────────────

async function getWhatsAppHistory(phone, limit = 6) {
  const { rows } = await pool.query(
    `SELECT role, content FROM whatsapp_conversations
     WHERE phone = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [phone, limit],
  );
  return rows.reverse(); // oldest first
}

async function saveWhatsAppMessage(userId, phone, role, content) {
  await pool.query(
    `INSERT INTO whatsapp_conversations (user_id, phone, role, content)
     VALUES ($1, $2, $3, $4)`,
    [userId, phone, role, content],
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
  getTaskById,
  getTasksForUser,
  replaceTasks,
  upsertTask,
  getSettings,
  saveSettings,
  getGcalTokensForUser,
  getAllGcalAccountsForUser,
  getGcalTokensByEmail,
  setGcalTokensForUser,
  deleteGcalTokensForUser,
  setGcalPrimaryAccount,
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
  getUserAuthContext,
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
  updateDndPreferences,
  scheduleTaskAlerts,
  getUnfiredAlerts,
  markScheduledAlertFired,
  DEFAULT_CADENCE_CONFIGS,
  getCalendarNote,
  upsertCalendarNote,
  getCalendarNotesHistory,
  getCalendarNotesForAI,
  getRecentlyEndedEventsForAlerts,
  markCalendarNoteAlertSent,
  getWhatsAppHistory,
  saveWhatsAppMessage,
};
