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
const { DEFAULT_TIMEZONE } = require('./server/utils/timezone.cjs');
const logger = require('./guardrails/logger.cjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.app')
    ? { rejectUnauthorized: false }
    : undefined,
  // listenForConfirmation holds a dedicated client for up to 2min per
  // paused web confirmation — bumped above pg default (10) so concurrent
  // confirmations don't starve normal queries.
  max: 25,
  idleTimeoutMillis: 30000,
  // Fail fast instead of hanging indefinitely when the pool is exhausted.
  connectionTimeoutMillis: 5000,
});

/**
 * Run a migration whose silent failure would leave the schema in an
 * inconsistent state that breaks runtime queries (e.g. SET NOT NULL
 * after a backfill, ADD CONSTRAINT UNIQUE, schema restructures).
 *
 * On failure: logs structured + throws an annotated error. The boot
 * path in proxy-server.cjs catches the throw and crashes the process
 * via process.exit(1) — forcing manual intervention rather than
 * letting the server start with a broken schema.
 *
 * For idempotent operations (ADD COLUMN IF NOT EXISTS, CREATE INDEX
 * IF NOT EXISTS, CREATE TABLE IF NOT EXISTS), keep the existing
 * `pool.query(...).catch(...)` pattern — those are safe to swallow.
 *
 * @param {string} sql - The migration SQL to execute.
 * @param {string} label - Stable identifier for logs (e.g.
 *   'user_integrations.account_email.notNull').
 */
async function criticalMigration(sql, label) {
  try {
    await pool.query(sql);
  } catch (err) {
    logger.error('migration.critical.failed', { label, error: err.message });
    throw new Error(`Critical migration failed: ${label} — ${err.message}`);
  }
}

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
  // Tracks when the user last completed WhatsApp phone verification — null
  // for legacy rows. New writes go through the verify flow; legacy phones
  // continue to work for inbound but cannot be changed without verification.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_verified_at TIMESTAMPTZ DEFAULT NULL`);
  // Closes the WhatsApp account-takeover vector: without this index, two
  // users could claim the same number and getUserByWhatsAppPhone returned
  // the first match non-deterministically — letting an attacker route
  // victim's inbound WhatsApp into the attacker's session. The index is
  // partial (NULL allowed) and uses the same digits-only normalization
  // as getUserByWhatsAppPhone. If pre-existing duplicates make the
  // CREATE fail, log loudly so ops can resolve manually rather than
  // leaving the hole open silently.
  try {
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_whatsapp_phone_normalized
         ON users (REGEXP_REPLACE(whatsapp_phone, '[^0-9]', '', 'g'))
         WHERE whatsapp_phone IS NOT NULL`
    );
  } catch (err) {
    console.error('[db] WARNING: could not create UNIQUE index on whatsapp_phone — duplicates exist. Resolve manually then re-deploy. Error:', err.message);
  }
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_name TEXT DEFAULT NULL`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_businesses TEXT DEFAULT NULL`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_household TEXT DEFAULT NULL`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_location TEXT DEFAULT NULL`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_notes TEXT DEFAULT NULL`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'America/Los_Angeles'`);

  // ── pending_whatsapp_verifications — short-lived OTP store for the
  //    phone-claim verification flow. One pending row per user (UNIQUE on
  //    user_id) so a fresh start_verify replaces any prior pending. The
  //    code is sent via UltraMsg to the to-be-claimed phone; only the real
  //    owner of that number sees it, which is the security guarantee.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_whatsapp_verifications (
      id                 SERIAL PRIMARY KEY,
      user_id            TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      phone_normalized   TEXT NOT NULL,
      code               TEXT NOT NULL,
      expires_at         TIMESTAMPTZ NOT NULL,
      attempts           INT NOT NULL DEFAULT 0,
      created_at         TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pwv_expires ON pending_whatsapp_verifications(expires_at)`).catch(() => {});

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

  // gmail_tokens table removed — Gmail OAuth tokens live in user_integrations
  // (integration_type='gmail'). The legacy table is dropped by runMigrations().

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
  // Retry/dead-letter tracking — added when the cron was discovered to mark
  // alerts fired even on total channel failure (silent loss of reminders).
  // attempts bumps on every failed delivery; last_error captures the reason.
  // The cron gives up at MAX_ATTEMPTS to prevent infinite retry storms.
  await pool.query(`ALTER TABLE scheduled_alerts ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0`).catch(() => {});
  await pool.query(`ALTER TABLE scheduled_alerts ADD COLUMN IF NOT EXISTS last_error TEXT`).catch(() => {});

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

  // ── user_settings table (per-user owned config) ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_settings (
      id          SERIAL PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      setting_key TEXT NOT NULL,
      value_json  JSONB NOT NULL DEFAULT '{}',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, setting_key)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_settings_user ON user_settings(user_id)`).catch(() => {});

  // ── agent_actions (audit log for agentic loop) ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_actions (
      id          SERIAL PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_type  TEXT NOT NULL,
      tool_name   TEXT,
      input_json  JSONB NOT NULL DEFAULT '{}',
      output_json JSONB NOT NULL DEFAULT '{}',
      status      TEXT NOT NULL DEFAULT 'success',
      error_msg   TEXT,
      confidence  NUMERIC(4,3),
      risk        TEXT,
      confirm_id  TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_actions_user ON agent_actions(user_id)`).catch(() => {});

  // ── Email auto-clean policy (Session 1: safe manual clean only) ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_clean_policies (
      id                       TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      user_id                  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      archive_promos           BOOLEAN NOT NULL DEFAULT false,
      promos_older_than_h      INTEGER NOT NULL DEFAULT 24,
      archive_newsletters      BOOLEAN NOT NULL DEFAULT false,
      newsletters_older_than_h INTEGER NOT NULL DEFAULT 48,
      archive_social           BOOLEAN NOT NULL DEFAULT false,
      social_older_than_h      INTEGER NOT NULL DEFAULT 24,
      confirmation_threshold   INTEGER NOT NULL DEFAULT 20,
      active                   BOOLEAN NOT NULL DEFAULT true,
      created_at               TIMESTAMPTZ DEFAULT NOW(),
      updated_at               TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id)
    );
  `);

  // ── Email classification rules + classifications ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_classification_rules (
      id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rule_name       TEXT NOT NULL,
      conditions      JSONB NOT NULL DEFAULT '{}',
      entity_id       TEXT REFERENCES entities(id) ON DELETE SET NULL,
      category        TEXT NOT NULL DEFAULT 'general',
      importance      TEXT NOT NULL DEFAULT 'normal',
      importance_rank INTEGER NOT NULL DEFAULT 2,
      extract_amount  BOOLEAN NOT NULL DEFAULT false,
      source          TEXT NOT NULL DEFAULT 'user_defined',
      confirmed       BOOLEAN NOT NULL DEFAULT true,
      active          BOOLEAN NOT NULL DEFAULT true,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ecr_user ON email_classification_rules(user_id)`).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_classifications (
      id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message_id      TEXT NOT NULL,
      thread_id       TEXT NOT NULL,
      account_email   TEXT NOT NULL,
      entity_id       TEXT REFERENCES entities(id) ON DELETE SET NULL,
      category        TEXT NOT NULL DEFAULT 'general',
      importance      TEXT NOT NULL DEFAULT 'normal',
      importance_rank INTEGER NOT NULL DEFAULT 2,
      action_required BOOLEAN NOT NULL DEFAULT false,
      is_read         BOOLEAN NOT NULL DEFAULT false,
      amount          NUMERIC(12,2),
      currency        TEXT DEFAULT 'USD',
      vendor          TEXT,
      summary         TEXT,
      source          TEXT NOT NULL DEFAULT 'rule',
      classified_at   TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, message_id)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ec_user ON email_classifications(user_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ec_entity ON email_classifications(user_id, entity_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ec_importance ON email_classifications(user_id, importance_rank DESC)`).catch(() => {});

  // ── user_learnings (Correction Learning Loop) ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_learnings (
      id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rule_text            TEXT NOT NULL,
      normalized_rule_text TEXT NOT NULL,
      rule_type            TEXT NOT NULL,
      scope                TEXT NOT NULL DEFAULT 'global',
      scope_value          TEXT,
      confidence           TEXT NOT NULL DEFAULT 'one-off',
      occurrence           INTEGER NOT NULL DEFAULT 1,
      active               BOOLEAN NOT NULL DEFAULT true,
      source_msg           TEXT,
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      updated_at           TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_learnings_user ON user_learnings(user_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_learnings_active ON user_learnings(user_id, active)`).catch(() => {});

  // ── pending_confirmations (high-risk tool gate) ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_confirmations (
      id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tool_name   TEXT NOT NULL,
      params_json JSONB NOT NULL DEFAULT '{}',
      channel     TEXT NOT NULL DEFAULT 'web',
      status      TEXT NOT NULL DEFAULT 'pending',
      expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '2 minutes',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pending_confirmations_user ON pending_confirmations(user_id)`).catch(() => {});
  await pool.query(`ALTER TABLE pending_confirmations ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ`).catch(() => {});
  await pool.query(`ALTER TABLE pending_confirmations ADD COLUMN IF NOT EXISTS resolution_json JSONB`).catch(() => {});

  // ── active_zone_tiles — Aria's orchestration surface ──────────────────
  // One row per (user, candidate_key). candidate_key is a stable hash of
  // (candidate_type, sorted item ids) so detector re-runs UPSERT onto
  // the same row instead of flickering the UI. status transitions:
  //   pending → resolved        (primary_action fired)
  //   pending → deferred        ("not now" — returns after deferred_until)
  //   pending → dismissed       ("X" — returns after dismissed_until)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS active_zone_tiles (
      id                TEXT PRIMARY KEY,
      user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      candidate_type    TEXT NOT NULL,
      candidate_key     TEXT NOT NULL,
      priority_score    INT NOT NULL DEFAULT 0,
      urgency           TEXT,
      headline          TEXT NOT NULL DEFAULT '',
      body              TEXT DEFAULT '',
      primary_action    JSONB DEFAULT '{}',
      secondary_action  JSONB DEFAULT '{}',
      items_preview     JSONB DEFAULT '[]',
      status            TEXT NOT NULL DEFAULT 'pending',
      deferred_until    TIMESTAMPTZ,
      dismissed_until   TIMESTAMPTZ,
      composer_source   TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, candidate_key)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_az_user_status ON active_zone_tiles(user_id, status, priority_score DESC)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_az_deferred ON active_zone_tiles(user_id, deferred_until) WHERE deferred_until IS NOT NULL`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_az_dismissed ON active_zone_tiles(user_id, dismissed_until) WHERE dismissed_until IS NOT NULL`).catch(() => {});
  // composer_source tracks llm|fallback|cache for the metrics dashboard.
  await pool.query(`ALTER TABLE active_zone_tiles ADD COLUMN IF NOT EXISTS composer_source TEXT`).catch(() => {});

  // Phase 5 — link back to decision_log so the WhatsApp YES/NO webhook
  // can close the original decision with trust feedback at resolution
  // time (was previously orphaned because the webhook had no way to
  // recover the engineDecisionId from the prior gate invocation).
  await pool.query(`ALTER TABLE pending_confirmations ADD COLUMN IF NOT EXISTS decision_log_id INT`).catch(() => {});

  // ── user_integrations table (per-user outbound notification routing) ──
  // Shape kept in sync with the final migrated state — account_email NOT
  // NULL DEFAULT '' and provider NOT NULL DEFAULT 'google', composite
  // UNIQUE on (user_id, integration_type, account_email). Without this,
  // a fresh boot would hit a window where the table existed without
  // account_email NOT NULL, any concurrent upsert could insert a NULL,
  // and the SET NOT NULL migration that runs later would crash boot.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_integrations (
      id                SERIAL PRIMARY KEY,
      user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      integration_type  TEXT NOT NULL,
      account_email     TEXT NOT NULL DEFAULT '',
      provider          TEXT NOT NULL DEFAULT 'google',
      config_json       JSONB NOT NULL DEFAULT '{}',
      is_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, integration_type, account_email)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_integrations_user ON user_integrations(user_id)`).catch(() => {});

  // ── entity_qb_connections — QuickBooks OAuth per (user, entity, realm) ──
  // One row per QB company a user has connected to a given entity. realm_id
  // is QB's company ID (returned in the OAuth callback); a single entity may
  // theoretically connect to multiple QB companies, but typical usage is
  // 1 entity ↔ 1 realm. environment is 'sandbox' | 'production' so the same
  // entity can move between sandbox and prod by adding a new row.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS entity_qb_connections (
      id                 SERIAL PRIMARY KEY,
      user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      entity_id          TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      realm_id           TEXT NOT NULL,
      environment        TEXT NOT NULL DEFAULT 'sandbox',
      company_name       TEXT DEFAULT '',
      encrypted_tokens   TEXT NOT NULL,
      scope              TEXT DEFAULT '',
      last_refreshed_at  TIMESTAMPTZ,
      created_at         TIMESTAMPTZ DEFAULT NOW(),
      updated_at         TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, entity_id, realm_id, environment)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_qb_conn_user ON entity_qb_connections(user_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_qb_conn_entity ON entity_qb_connections(entity_id)`).catch(() => {});

  // ── qb_snapshots (P1) ─ time-series financial snapshot per connection.
  // Computed during the */15 sync from QB Account balances + recent
  // Invoice/Bill aggregates. as_of_date is the local date the snapshot
  // covers (UTC-truncated). One row per (connection_id, as_of_date) — a
  // re-sync on the same day overwrites.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS qb_snapshots (
      id                  SERIAL PRIMARY KEY,
      connection_id       INT NOT NULL REFERENCES entity_qb_connections(id) ON DELETE CASCADE,
      user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      entity_id           TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      as_of_date          DATE NOT NULL,
      cash_balance        NUMERIC(14,2) DEFAULT 0,
      accounts_receivable NUMERIC(14,2) DEFAULT 0,
      accounts_payable    NUMERIC(14,2) DEFAULT 0,
      revenue_30d         NUMERIC(14,2) DEFAULT 0,
      expenses_30d        NUMERIC(14,2) DEFAULT 0,
      net_income_30d      NUMERIC(14,2) DEFAULT 0,
      runway_months       NUMERIC(6,2),
      health_score        INT,
      raw_json            JSONB DEFAULT '{}',
      synced_at           TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(connection_id, as_of_date)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_qb_snap_user ON qb_snapshots(user_id, as_of_date DESC)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_qb_snap_entity ON qb_snapshots(entity_id, as_of_date DESC)`).catch(() => {});

  // ── qb_transactions (P1) ─ raw QB invoice + bill pulls. Kept separate
  // from the existing `transactions` table (manual/CSV) so re-syncs can
  // overwrite without clobbering manual edits, and so the source field
  // stays single-valued. txn_qb_id is QB's Invoice/Bill Id; type
  // distinguishes invoice / bill / payment.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS qb_transactions (
      id              SERIAL PRIMARY KEY,
      connection_id   INT NOT NULL REFERENCES entity_qb_connections(id) ON DELETE CASCADE,
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      entity_id       TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      txn_qb_id       TEXT NOT NULL,
      txn_type        TEXT NOT NULL,
      txn_date        DATE NOT NULL,
      amount          NUMERIC(14,2) NOT NULL,
      currency        TEXT DEFAULT 'USD',
      counterparty    TEXT DEFAULT '',
      memo            TEXT DEFAULT '',
      status          TEXT DEFAULT '',
      due_date        DATE,
      balance         NUMERIC(14,2) DEFAULT 0,
      raw_json        JSONB DEFAULT '{}',
      synced_at       TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(connection_id, txn_type, txn_qb_id)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_qb_tx_user ON qb_transactions(user_id, txn_date DESC)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_qb_tx_entity ON qb_transactions(entity_id, txn_date DESC)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_qb_tx_due ON qb_transactions(entity_id, due_date) WHERE due_date IS NOT NULL`).catch(() => {});

  // Legacy "Dizon Household" seed org intentionally removed — founder-specific.
  // Production org_members rows remain intact; new deployments start with
  // no default org.

  console.log('[db] Tables initialised');
}

// ── User integrations (per-user outbound notification routing) ───────────────

/**
 * Load a single integration row for a user. Returns null if not configured.
 * @param {string} userId
 * @param {string} type - 'email_alerts' | 'slack_webhook' | 'ultramsg_whatsapp' | ...
 * @returns {Promise<{id:number,userId:string,type:string,config:Object,isEnabled:boolean}|null>}
 */
async function getUserIntegration(userId, type, accountEmail = '') {
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", integration_type AS "type",
            account_email AS "accountEmail", provider,
            config_json AS "config", is_enabled AS "isEnabled",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM user_integrations
     WHERE user_id = $1 AND integration_type = $2 AND account_email = $3`,
    [userId, type, accountEmail],
  );
  return rows[0] || null;
}

/** Return all integrations for a user (all account variants). */
async function getUserIntegrations(userId) {
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", integration_type AS "type",
            account_email AS "accountEmail", provider,
            config_json AS "config", is_enabled AS "isEnabled",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM user_integrations WHERE user_id = $1
     ORDER BY integration_type, account_email`,
    [userId],
  );
  return rows;
}

/** All rows of a given integration_type for a user (multi-account aware). */
async function getUserIntegrationsByType(userId, type) {
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", integration_type AS "type",
            account_email AS "accountEmail", provider,
            config_json AS "config", is_enabled AS "isEnabled",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM user_integrations WHERE user_id = $1 AND integration_type = $2
     ORDER BY created_at ASC`,
    [userId, type],
  );
  return rows;
}

/**
 * Case-insensitive, whitespace-tolerant lookup for a Gmail integration
 * row by user and account_email. Used by the communication tools when
 * the LLM may echo the email with different casing or stray whitespace
 * than what was stored at OAuth callback time.
 */
async function getGmailIntegrationByEmail(userId, accountEmail) {
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", integration_type AS "type",
            account_email AS "accountEmail", provider,
            config_json AS "config", is_enabled AS "isEnabled",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM user_integrations
     WHERE user_id = $1
       AND integration_type = 'gmail'
       AND LOWER(TRIM(account_email)) = LOWER(TRIM($2))
     LIMIT 1`,
    [userId, accountEmail || ''],
  );
  return rows[0] || null;
}

/** Fetch a single row by id, scoped to userId for authorization. */
async function getUserIntegrationById(id, userId) {
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", integration_type AS "type",
            account_email AS "accountEmail", provider,
            config_json AS "config", is_enabled AS "isEnabled",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM user_integrations WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0] || null;
}

/**
 * Upsert an integration row for a user. Merges new config into existing.
 * accountEmail defaults to '' so singleton integrations (email_alerts,
 * slack_webhook, ultramsg_whatsapp) continue to have exactly one row per user.
 *
 * @param {string} userId
 * @param {string} type
 * @param {Object} config - JSON config (merged into existing on conflict).
 * @param {boolean} [isEnabled=true]
 * @param {string} [accountEmail='']
 */
async function upsertUserIntegration(userId, type, config, isEnabled = true, accountEmail = '', provider = 'google') {
  const { rows } = await pool.query(
    `INSERT INTO user_integrations (user_id, integration_type, account_email, provider, config_json, is_enabled)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (user_id, integration_type, account_email) DO UPDATE SET
       provider = EXCLUDED.provider,
       config_json = user_integrations.config_json || EXCLUDED.config_json,
       is_enabled = EXCLUDED.is_enabled,
       updated_at = NOW()
     RETURNING id, user_id AS "userId", integration_type AS "type",
               account_email AS "accountEmail", provider,
               config_json AS "config", is_enabled AS "isEnabled"`,
    [userId, type, accountEmail, provider, JSON.stringify(config || {}), isEnabled !== false],
  );
  return rows[0];
}

/** Delete a user's integration row by id (scoped to userId). */
async function deleteUserIntegrationById(id, userId) {
  const result = await pool.query(
    `DELETE FROM user_integrations WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return result.rowCount > 0;
}

/** Delete a user's integration row by type (singleton default). */
async function deleteUserIntegration(userId, type) {
  await pool.query(
    `DELETE FROM user_integrations WHERE user_id = $1 AND integration_type = $2`,
    [userId, type],
  );
}

// ── entity_qb_connections (QuickBooks OAuth per entity) ──────────────────────

/**
 * Upsert a QB connection by (user_id, entity_id, realm_id, environment).
 * Tokens are caller-encrypted JSON (see server/utils/quickbooks.cjs). Returns
 * the upserted row id.
 */
async function upsertQbConnection({ userId, entityId, realmId, environment, companyName, encryptedTokens, scope }) {
  const { rows } = await pool.query(
    `INSERT INTO entity_qb_connections
       (user_id, entity_id, realm_id, environment, company_name, encrypted_tokens, scope, last_refreshed_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
     ON CONFLICT (user_id, entity_id, realm_id, environment) DO UPDATE SET
       company_name      = EXCLUDED.company_name,
       encrypted_tokens  = EXCLUDED.encrypted_tokens,
       scope             = EXCLUDED.scope,
       last_refreshed_at = NOW(),
       updated_at        = NOW()
     RETURNING id`,
    [userId, entityId, realmId, environment, companyName || '', encryptedTokens, scope || ''],
  );
  return rows[0]?.id;
}

/** All QB connections for a user across entities. */
async function getQbConnectionsByUser(userId) {
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", entity_id AS "entityId", realm_id AS "realmId",
            environment, company_name AS "companyName", encrypted_tokens AS "encryptedTokens",
            scope, last_refreshed_at AS "lastRefreshedAt",
            created_at AS "createdAt", updated_at AS "updatedAt"
       FROM entity_qb_connections
      WHERE user_id = $1
      ORDER BY created_at ASC`,
    [userId],
  );
  return rows;
}

/** Single connection by id, scoped to userId for authorization. */
async function getQbConnectionById(id, userId) {
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", entity_id AS "entityId", realm_id AS "realmId",
            environment, company_name AS "companyName", encrypted_tokens AS "encryptedTokens",
            scope, last_refreshed_at AS "lastRefreshedAt",
            created_at AS "createdAt", updated_at AS "updatedAt"
       FROM entity_qb_connections
      WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0] || null;
}

/** Replace tokens after a refresh — touches updated_at + last_refreshed_at. */
async function updateQbConnectionTokens(id, userId, encryptedTokens) {
  await pool.query(
    `UPDATE entity_qb_connections
        SET encrypted_tokens = $1, last_refreshed_at = NOW(), updated_at = NOW()
      WHERE id = $2 AND user_id = $3`,
    [encryptedTokens, id, userId],
  );
}

/** Delete a connection by id, scoped to userId. */
async function deleteQbConnectionById(id, userId) {
  const result = await pool.query(
    `DELETE FROM entity_qb_connections WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return result.rowCount > 0;
}

/**
 * Upsert a daily snapshot. (connection_id, as_of_date) is unique; second
 * sync on the same day overwrites the prior row's metric columns.
 */
async function upsertQbSnapshot(snap) {
  const { rows } = await pool.query(
    `INSERT INTO qb_snapshots
       (connection_id, user_id, entity_id, as_of_date,
        cash_balance, accounts_receivable, accounts_payable,
        revenue_30d, expenses_30d, net_income_30d, runway_months,
        health_score, raw_json, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, NOW())
     ON CONFLICT (connection_id, as_of_date) DO UPDATE SET
       cash_balance        = EXCLUDED.cash_balance,
       accounts_receivable = EXCLUDED.accounts_receivable,
       accounts_payable    = EXCLUDED.accounts_payable,
       revenue_30d         = EXCLUDED.revenue_30d,
       expenses_30d        = EXCLUDED.expenses_30d,
       net_income_30d      = EXCLUDED.net_income_30d,
       runway_months       = EXCLUDED.runway_months,
       health_score        = EXCLUDED.health_score,
       raw_json            = EXCLUDED.raw_json,
       synced_at           = NOW()
     RETURNING id`,
    [snap.connectionId, snap.userId, snap.entityId, snap.asOfDate,
     snap.cashBalance, snap.accountsReceivable, snap.accountsPayable,
     snap.revenue30d, snap.expenses30d, snap.netIncome30d, snap.runwayMonths,
     snap.healthScore, JSON.stringify(snap.rawJson || {})],
  );
  return rows[0]?.id;
}

/** Latest snapshot per connection for a user. Used by Aria financial tools. */
async function getLatestQbSnapshotsForUser(userId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (connection_id)
            id, connection_id AS "connectionId", user_id AS "userId",
            entity_id AS "entityId", as_of_date AS "asOfDate",
            cash_balance::float AS "cashBalance",
            accounts_receivable::float AS "accountsReceivable",
            accounts_payable::float AS "accountsPayable",
            revenue_30d::float AS "revenue30d",
            expenses_30d::float AS "expenses30d",
            net_income_30d::float AS "netIncome30d",
            runway_months::float AS "runwayMonths",
            health_score AS "healthScore",
            synced_at AS "syncedAt"
       FROM qb_snapshots
      WHERE user_id = $1
      ORDER BY connection_id, as_of_date DESC`,
    [userId],
  );
  return rows;
}

/** Snapshot history for one connection, newest first. */
async function getQbSnapshotHistory(connectionId, userId, limit = 30) {
  const { rows } = await pool.query(
    `SELECT id, as_of_date AS "asOfDate",
            cash_balance::float AS "cashBalance",
            accounts_receivable::float AS "accountsReceivable",
            accounts_payable::float AS "accountsPayable",
            revenue_30d::float AS "revenue30d",
            expenses_30d::float AS "expenses30d",
            net_income_30d::float AS "netIncome30d",
            runway_months::float AS "runwayMonths",
            health_score AS "healthScore",
            synced_at AS "syncedAt"
       FROM qb_snapshots
      WHERE connection_id = $1 AND user_id = $2
      ORDER BY as_of_date DESC
      LIMIT $3`,
    [connectionId, userId, Math.min(parseInt(limit, 10) || 30, 365)],
  );
  return rows;
}

/**
 * Bulk upsert raw QB transactions. Conflict key (connection_id, txn_type,
 * txn_qb_id) — re-pulls overwrite. Returns count upserted.
 */
async function upsertQbTransactions(rows) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  const CHUNK = 200;
  let count = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const placeholders = [];
    const vals = [];
    let idx = 1;
    for (const r of chunk) {
      placeholders.push(`($${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++}::jsonb,NOW())`);
      vals.push(
        r.connectionId, r.userId, r.entityId, r.txnQbId, r.txnType,
        r.txnDate, r.amount, r.currency || 'USD', r.counterparty || '',
        r.memo || '', r.status || '', r.dueDate || null,
        JSON.stringify(r.rawJson || {}),
      );
    }
    const result = await pool.query(
      `INSERT INTO qb_transactions
         (connection_id, user_id, entity_id, txn_qb_id, txn_type,
          txn_date, amount, currency, counterparty, memo, status,
          due_date, raw_json, synced_at)
       VALUES ${placeholders.join(',')}
       ON CONFLICT (connection_id, txn_type, txn_qb_id) DO UPDATE SET
         txn_date     = EXCLUDED.txn_date,
         amount       = EXCLUDED.amount,
         currency     = EXCLUDED.currency,
         counterparty = EXCLUDED.counterparty,
         memo         = EXCLUDED.memo,
         status       = EXCLUDED.status,
         due_date     = EXCLUDED.due_date,
         raw_json     = EXCLUDED.raw_json,
         synced_at    = NOW()`,
      vals,
    );
    count += result.rowCount || 0;
  }
  return count;
}

/** All QB transactions for a user with optional entity + window filters. */
async function getQbTransactionsForUser(userId, opts = {}) {
  const where = ['user_id = $1'];
  const vals = [userId];
  let idx = 2;
  if (opts.entityId)   { where.push(`entity_id = $${idx++}`); vals.push(opts.entityId); }
  if (opts.txnType)    { where.push(`txn_type = $${idx++}`); vals.push(opts.txnType); }
  if (opts.sinceDate)  { where.push(`txn_date >= $${idx++}`); vals.push(opts.sinceDate); }
  const limit = Math.min(parseInt(opts.limit, 10) || 200, 1000);
  const { rows } = await pool.query(
    `SELECT id, connection_id AS "connectionId", entity_id AS "entityId",
            txn_qb_id AS "txnQbId", txn_type AS "txnType",
            txn_date AS "txnDate", amount::float, currency,
            counterparty, memo, status, due_date AS "dueDate",
            synced_at AS "syncedAt"
       FROM qb_transactions
      WHERE ${where.join(' AND ')}
      ORDER BY txn_date DESC
      LIMIT $${idx}`,
    [...vals, limit],
  );
  return rows;
}

/**
 * All QB connections across every user — used by background refresh cron.
 * Caller is responsible for refreshing+persisting per row. Not exposed via
 * any HTTP route.
 */
async function getAllQbConnections() {
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", entity_id AS "entityId", realm_id AS "realmId",
            environment, company_name AS "companyName", encrypted_tokens AS "encryptedTokens",
            scope, last_refreshed_at AS "lastRefreshedAt"
       FROM entity_qb_connections
      ORDER BY id ASC`,
  );
  return rows;
}

/**
 * One-time backfill: copy env-based notification settings into the
 * user_integrations rows of existing superadmin users so their alerts
 * keep working after the cutover. Idempotent — ON CONFLICT DO NOTHING
 * never overwrites a row a user has already configured.
 *
 * Intentionally scoped to superadmin only. Regular users must configure
 * their own integrations — no env fallback.
 */
async function backfillSuperadminIntegrationsFromEnv() {
  const { rows: admins } = await pool.query(
    `SELECT id, whatsapp_phone AS "whatsappPhone" FROM users WHERE role = 'superadmin'`,
  );
  if (!admins.length) return;

  for (const u of admins) {
    if (process.env.ALERT_RECIPIENT_EMAIL) {
      const cfg = { recipientEmail: process.env.ALERT_RECIPIENT_EMAIL };
      if (process.env.RESEND_FROM_EMAIL) cfg.fromEmail = process.env.RESEND_FROM_EMAIL;
      await pool.query(
        `INSERT INTO user_integrations (user_id, integration_type, account_email, config_json, is_enabled)
         VALUES ($1, 'email_alerts', '', $2::jsonb, TRUE)
         ON CONFLICT (user_id, integration_type, account_email) DO NOTHING`,
        [u.id, JSON.stringify(cfg)],
      );
    }
    if (process.env.SLACK_WEBHOOK_URL) {
      const { wrapWebhookUrl } = require('./server/utils/integrations.cjs');
      await pool.query(
        `INSERT INTO user_integrations (user_id, integration_type, account_email, config_json, is_enabled)
         VALUES ($1, 'slack_webhook', '', $2::jsonb, TRUE)
         ON CONFLICT (user_id, integration_type, account_email) DO NOTHING`,
        [u.id, JSON.stringify({ webhookUrl: wrapWebhookUrl(process.env.SLACK_WEBHOOK_URL) })],
      );
    }
    if (process.env.ULTRAMSG_INSTANCE && process.env.ULTRAMSG_TOKEN) {
      const phone = u.whatsappPhone || process.env.ULTRAMSG_PHONE || null;
      await pool.query(
        `INSERT INTO user_integrations (user_id, integration_type, account_email, config_json, is_enabled)
         VALUES ($1, 'ultramsg_whatsapp', '', $2::jsonb, $3)
         ON CONFLICT (user_id, integration_type, account_email) DO NOTHING`,
        [
          u.id,
          JSON.stringify({
            instance: process.env.ULTRAMSG_INSTANCE,
            token: process.env.ULTRAMSG_TOKEN,
            phone,
          }),
          !!phone,
        ],
      );
    }
  }
  console.log(`[migration] Backfilled integrations for ${admins.length} superadmin user(s)`);
}

// ── User settings (per-user owned config) ────────────────────────────────────

/**
 * Return a single user-scoped setting by key, or null if not set.
 * @param {string} userId
 * @param {string} key - e.g. 'apiKeys', 'alertRules'
 * @returns {Promise<*|null>} Parsed JSON value.
 */
async function getUserSetting(userId, key) {
  const { rows } = await pool.query(
    `SELECT value_json FROM user_settings WHERE user_id = $1 AND setting_key = $2`,
    [userId, key],
  );
  return rows[0] ? rows[0].value_json : null;
}

/** Return all settings for a user as a { key: value } map. */
async function getUserSettings(userId) {
  const { rows } = await pool.query(
    `SELECT setting_key, value_json FROM user_settings WHERE user_id = $1`,
    [userId],
  );
  const out = {};
  for (const r of rows) out[r.setting_key] = r.value_json;
  return out;
}

/**
 * Upsert a user setting. REPLACE semantics — the new value fully
 * overwrites the existing value_json (no JSON merge).
 */
async function upsertUserSetting(userId, key, value) {
  await pool.query(
    `INSERT INTO user_settings (user_id, setting_key, value_json)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (user_id, setting_key) DO UPDATE SET
       value_json = EXCLUDED.value_json,
       updated_at = NOW()`,
    [userId, key, JSON.stringify(value ?? null)],
  );
}

/** Delete a user's setting row. */
async function deleteUserSetting(userId, key) {
  await pool.query(
    `DELETE FROM user_settings WHERE user_id = $1 AND setting_key = $2`,
    [userId, key],
  );
}

/**
 * One-time backfill: seed each existing superadmin's user_settings rows
 * from the legacy global `settings` table. Idempotent — ON CONFLICT DO
 * NOTHING preserves any per-user row the user has already written.
 *
 * Scope: only user-owned keys (apiKeys, alertRules). Platform-owned
 * settings keys (if any exist in production) stay in the legacy table.
 */
async function backfillSuperadminSettingsFromGlobal() {
  const { rows: globals } = await pool.query(`SELECT key, value FROM settings`);
  if (!globals.length) return;

  const globalMap = {};
  for (const g of globals) globalMap[g.key] = g.value;

  const USER_OWNED_KEYS = ['apiKeys', 'alertRules', 'emailSettings'];

  const { rows: admins } = await pool.query(
    `SELECT id FROM users WHERE role = 'superadmin'`,
  );
  if (!admins.length) return;

  let seeded = 0;
  for (const u of admins) {
    for (const key of USER_OWNED_KEYS) {
      if (globalMap[key] === undefined) continue;
      const result = await pool.query(
        `INSERT INTO user_settings (user_id, setting_key, value_json)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (user_id, setting_key) DO NOTHING`,
        [u.id, key, JSON.stringify(globalMap[key])],
      );
      if (result.rowCount) seeded++;
    }
  }
  if (seeded) console.log(`[migration] Backfilled ${seeded} user_settings row(s) for superadmins`);
}

// ── Agent actions (audit log) + pending_confirmations ────────────────────────

/**
 * Append one row to agent_actions. Swallows errors — logging must never
 * crash the agentic loop.
 */
async function logAgentAction({ userId, eventType, toolName, input, output, status, errorMsg, confidence, risk, confirmId }) {
  try {
    await pool.query(
      `INSERT INTO agent_actions (user_id, event_type, tool_name, input_json, output_json, status, error_msg, confidence, risk, confirm_id)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10)`,
      [
        userId, eventType, toolName || null,
        JSON.stringify(input || {}), JSON.stringify(output || {}),
        status || 'success', errorMsg || null,
        confidence ?? null, risk || null, confirmId || null,
      ],
    );
  } catch (err) {
    console.error('[agent_actions] log failed:', err.message);
  }
}

async function createPendingConfirmation({ userId, toolName, params, channel, decisionLogId }) {
  const { rows } = await pool.query(
    `INSERT INTO pending_confirmations (user_id, tool_name, params_json, channel, decision_log_id)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     RETURNING id, user_id AS "userId", tool_name AS "toolName", params_json AS "params",
               channel, status, expires_at AS "expiresAt", created_at AS "createdAt",
               decision_log_id AS "decisionLogId"`,
    [userId, toolName, JSON.stringify(params || {}), channel || 'web', decisionLogId || null],
  );
  return rows[0];
}

/**
 * Hard-delete a pending confirmation row, scoped by userId. Used when a
 * gate creation succeeded in the DB but the downstream side-channel
 * (WhatsApp prompt) failed to deliver — leaving the row pending would
 * block the next attempt and confuse the listener.
 */
async function deletePendingConfirmation(id, userId) {
  if (!userId) throw new Error('deletePendingConfirmation requires userId');
  const result = await pool.query(
    'DELETE FROM pending_confirmations WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  return result.rowCount > 0;
}

/**
 * Sanitize a confirmation id into a safe pg LISTEN/NOTIFY channel.
 * Lowercase alphanumerics + underscore only; capped at 55 chars so the
 * `confirm_` prefix keeps the identifier under the 63-byte pg limit.
 * Defense-in-depth — UUIDs are already safe, but never trust an id shape.
 */
function getConfirmationChannel(confirmId) {
  const safe = String(confirmId).toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 55);
  return `confirm_${safe}`;
}

/** Bare-id lookup used by the listener to re-read DB truth after a NOTIFY. */
async function getConfirmationById(id) {
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", tool_name AS "toolName", params_json AS "params",
            channel, status, expires_at AS "expiresAt", created_at AS "createdAt",
            resolved_at AS "resolvedAt", resolution_json AS "resolution"
     FROM pending_confirmations WHERE id = $1`,
    [id],
  );
  return rows[0] || null;
}

/**
 * Send a NOTIFY payload on a confirmation's channel. Non-fatal if no
 * listener is attached — pg_notify is fire-and-forget.
 */
async function notifyConfirmation(confirmId, payload) {
  const channel = getConfirmationChannel(confirmId);
  await pool.query('SELECT pg_notify($1, $2)', [channel, JSON.stringify(payload || {})]);
}

/**
 * Wait for a pending confirmation to reach a terminal status via pg
 * LISTEN/NOTIFY. The DB row is the authoritative state; NOTIFY is only
 * a wake-up carrying advisory metadata (overrides, alreadyExecuted, result).
 *
 * Resolution shape matches what the agentic loop's gate expects:
 *   { action: 'allow'|'deny', overrides, alreadyExecuted?, result?, reason?, message? }
 *
 * Rejects with:
 *   Error('confirmation_timeout')  after timeoutMs
 *   Error('confirmation_aborted')  if signal fires (e.g. SSE client disconnect)
 *
 * The dedicated pg client is released in exactly one place regardless of
 * which path settles the promise.
 */
async function listenForConfirmation(confirmId, timeoutMs, { signal } = {}) {
  const channel = getConfirmationChannel(confirmId);
  const client = await pool.connect();
  let settled = false;
  let notificationHandler = null;
  let timeoutHandle = null;
  let abortHandler = null;

  const cleanup = async () => {
    if (settled) return;
    settled = true;
    if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
    if (notificationHandler) { client.removeListener('notification', notificationHandler); notificationHandler = null; }
    if (abortHandler && signal) { try { signal.removeEventListener('abort', abortHandler); } catch {} abortHandler = null; }
    try { await client.query(`UNLISTEN "${channel}"`); } catch {}
    try { client.release(); } catch {}
  };

  return new Promise((resolve, reject) => {
    const buildResolution = (row, notifyPayload = {}) => {
      if (!row) return { action: 'deny', reason: 'not_found' };
      const dbAction = row.status === 'approved' ? 'allow' : 'deny';
      // Prefer the persisted resolution_json (DB is authoritative + survives
      // missed NOTIFY deliveries); fall back to the in-flight notify payload.
      const persisted = row.resolution && typeof row.resolution === 'object' ? row.resolution : null;
      const rawMeta = persisted || notifyPayload || {};
      // Drop metadata if its action disagrees with DB truth.
      const meta = (rawMeta.action && rawMeta.action !== dbAction) ? {} : rawMeta;
      return {
        action: dbAction,
        overrides: meta.overrides && typeof meta.overrides === 'object' ? meta.overrides : {},
        alreadyExecuted: meta.alreadyExecuted === true,
        result: meta.result ?? null,
        reason: dbAction === 'deny' ? (meta.reason || (row.status === 'expired' ? 'expired' : 'user_rejected')) : undefined,
        message: dbAction === 'deny' ? (meta.message || `User cancelled ${row.toolName}.`) : undefined,
        fromDb: !!persisted,
      };
    };

    // Abort + timeout wiring.
    if (signal) {
      if (signal.aborted) {
        cleanup().finally(() => reject(new Error('confirmation_aborted')));
        return;
      }
      abortHandler = () => cleanup().finally(() => reject(new Error('confirmation_aborted')));
      signal.addEventListener('abort', abortHandler, { once: true });
    }
    timeoutHandle = setTimeout(() => {
      cleanup().finally(() => reject(new Error('confirmation_timeout')));
    }, timeoutMs);

    notificationHandler = async (msg) => {
      if (msg.channel !== channel) return;
      let payload = {};
      try { payload = JSON.parse(msg.payload || '{}'); } catch { payload = {}; }

      let row = null;
      try { row = await getConfirmationById(confirmId); } catch {}
      if (!row || row.status === 'pending') return; // spurious — keep waiting
      const resolution = buildResolution(row, payload);
      await cleanup();
      resolve(resolution);
    };
    client.on('notification', notificationHandler);

    // LISTEN, then immediately re-read the row — covers the race where the
    // status was updated + NOTIFY fired before this listener attached.
    client.query(`LISTEN "${channel}"`)
      .then(async () => {
        let row = null;
        try { row = await getConfirmationById(confirmId); }
        catch (err) { await cleanup(); return reject(err); }
        if (!row) { await cleanup(); return resolve({ action: 'deny', reason: 'not_found' }); }
        if (row.status !== 'pending') {
          // Terminal already — resolve without payload metadata (lost if it was sent).
          const resolution = buildResolution(row, {});
          await cleanup();
          return resolve(resolution);
        }
        // Still pending: keep waiting on NOTIFY / timeout / abort.
      })
      .catch(async (err) => {
        await cleanup();
        reject(err);
      });
  });
}

async function getPendingConfirmation(id, userId) {
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", tool_name AS "toolName", params_json AS "params",
            channel, status, expires_at AS "expiresAt", created_at AS "createdAt"
     FROM pending_confirmations WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0] || null;
}

async function updatePendingConfirmationStatus(id, userId, status, resolution) {
  // When resolution metadata is passed with a terminal status, persist it so
  // the listener can reconstruct the full resolution payload even when the
  // NOTIFY is lost (e.g. restart between status write and notify delivery).
  const resolutionJson = resolution && typeof resolution === 'object' ? JSON.stringify(resolution) : null;
  const { rows } = await pool.query(
    `UPDATE pending_confirmations
     SET status = $3,
         resolved_at = CASE WHEN $3 = 'pending' THEN resolved_at ELSE NOW() END,
         resolution_json = CASE
           WHEN $3 = 'pending' THEN resolution_json
           WHEN $4::jsonb IS NOT NULL THEN $4::jsonb
           ELSE resolution_json
         END
     WHERE id = $1 AND user_id = $2
     RETURNING id, user_id AS "userId", tool_name AS "toolName", params_json AS "params",
               channel, status, expires_at AS "expiresAt", resolved_at AS "resolvedAt",
               resolution_json AS "resolution"`,
    [id, userId, status, resolutionJson],
  );
  return rows[0] || null;
}

// ── User learnings (correction loop) ───────────────────────────────────────

const LEARNING_CAP = 100;

function _normalizeLearning(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function _confidenceForCount(n) {
  if (n >= 4) return 'rule';
  if (n >= 2) return 'pattern';
  return 'one-off';
}

/**
 * Upsert a learning. Returns { learning, isNew, confidenceUpgraded }.
 * Enforces LEARNING_CAP by evicting the oldest one-off when creating a
 * non-one-off row at capacity; blocks new one-offs at capacity.
 */
async function createOrUpdateLearning(userId, ruleText, ruleType, scope, scopeValue, sourceMsg, isExplicitRule) {
  const normalized = _normalizeLearning(ruleText);
  const scopeVal = scopeValue || null;

  const existingRes = await pool.query(
    `SELECT id, occurrence, confidence FROM user_learnings
     WHERE user_id = $1 AND rule_type = $2 AND scope = $3
       AND COALESCE(scope_value, '') = COALESCE($4, '')
       AND normalized_rule_text = $5
       AND active = TRUE
     LIMIT 1`,
    [userId, ruleType, scope, scopeVal, normalized],
  );

  if (existingRes.rows[0]) {
    const prev = existingRes.rows[0];
    const nextOcc = prev.occurrence + 1;
    const fromCount = _confidenceForCount(nextOcc);
    const nextConf = isExplicitRule ? 'rule' : fromCount;
    const upgraded = nextConf !== prev.confidence;
    const { rows } = await pool.query(
      `UPDATE user_learnings
       SET occurrence = $2, confidence = $3, source_msg = COALESCE($4, source_msg), updated_at = NOW()
       WHERE id = $1
       RETURNING id, user_id AS "userId", rule_text AS "ruleText", normalized_rule_text AS "normalizedRuleText",
                 rule_type AS "ruleType", scope, scope_value AS "scopeValue",
                 confidence, occurrence, active, source_msg AS "sourceMsg",
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [prev.id, nextOcc, nextConf, sourceMsg || null],
    );
    return { learning: rows[0], isNew: false, confidenceUpgraded: upgraded };
  }

  // Capacity enforcement
  const activeCountRes = await pool.query(
    `SELECT COUNT(*)::int AS c FROM user_learnings WHERE user_id = $1 AND active = TRUE`,
    [userId],
  );
  const activeCount = activeCountRes.rows[0].c;

  const wantConfidence = isExplicitRule ? 'rule' : 'one-off';
  if (activeCount >= LEARNING_CAP) {
    if (wantConfidence === 'one-off') {
      return { learning: null, isNew: false, confidenceUpgraded: false, skippedReason: 'cap_reached' };
    }
    // Evict oldest active one-off, if any.
    await pool.query(
      `UPDATE user_learnings SET active = FALSE, updated_at = NOW()
       WHERE id = (
         SELECT id FROM user_learnings
         WHERE user_id = $1 AND active = TRUE AND confidence = 'one-off'
         ORDER BY updated_at ASC LIMIT 1
       )`,
      [userId],
    );
  }

  const { rows } = await pool.query(
    `INSERT INTO user_learnings
       (user_id, rule_text, normalized_rule_text, rule_type, scope, scope_value, confidence, occurrence, source_msg)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8)
     RETURNING id, user_id AS "userId", rule_text AS "ruleText", normalized_rule_text AS "normalizedRuleText",
               rule_type AS "ruleType", scope, scope_value AS "scopeValue",
               confidence, occurrence, active, source_msg AS "sourceMsg",
               created_at AS "createdAt", updated_at AS "updatedAt"`,
    [userId, ruleText, normalized, ruleType, scope, scopeVal, wantConfidence, sourceMsg || null],
  );
  return { learning: rows[0], isNew: true, confidenceUpgraded: wantConfidence !== 'one-off' };
}

async function getUserLearnings(userId) {
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", rule_text AS "ruleText", normalized_rule_text AS "normalizedRuleText",
            rule_type AS "ruleType", scope, scope_value AS "scopeValue",
            confidence, occurrence, active, source_msg AS "sourceMsg",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM user_learnings
     WHERE user_id = $1 AND active = TRUE
     ORDER BY CASE confidence
                WHEN 'rule' THEN 1 WHEN 'pattern' THEN 2 ELSE 3
              END ASC,
              updated_at DESC`,
    [userId],
  );
  return rows;
}

async function deactivateLearning(id, userId) {
  const { rowCount } = await pool.query(
    `UPDATE user_learnings SET active = FALSE, updated_at = NOW()
     WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rowCount > 0;
}

// ── Email classification rules + classifications ────────────────────────────

const IMPORTANCE_RANK = { critical: 4, high: 3, normal: 2, low: 1 };
function _importanceRank(imp) { return IMPORTANCE_RANK[String(imp || 'normal').toLowerCase()] ?? 2; }

async function getRules(userId) {
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", rule_name AS "ruleName", conditions,
            entity_id AS "entityId", category, importance, importance_rank AS "importanceRank",
            extract_amount AS "extractAmount", source, confirmed, active,
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM email_classification_rules
     WHERE user_id = $1 AND active = TRUE
     ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

async function createRule(userId, r) {
  const rank = _importanceRank(r.importance);
  const { rows } = await pool.query(
    `INSERT INTO email_classification_rules
       (user_id, rule_name, conditions, entity_id, category, importance, importance_rank, extract_amount, source, confirmed)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, user_id AS "userId", rule_name AS "ruleName", conditions,
               entity_id AS "entityId", category, importance, importance_rank AS "importanceRank",
               extract_amount AS "extractAmount", source, confirmed, active,
               created_at AS "createdAt", updated_at AS "updatedAt"`,
    [
      userId, r.ruleName || r.rule_name || 'Untitled rule',
      JSON.stringify(r.conditions || {}),
      r.entityId || r.entity_id || null,
      r.category || 'general',
      r.importance || 'normal',
      rank,
      !!(r.extractAmount ?? r.extract_amount),
      r.source || 'user_defined',
      r.confirmed === false ? false : true,
    ],
  );
  return rows[0];
}

async function updateRule(id, userId, r) {
  const rank = r.importance !== undefined ? _importanceRank(r.importance) : undefined;
  const sets = [];
  const vals = [id, userId];
  let i = 3;
  const push = (col, val) => { sets.push(`${col} = $${i++}`); vals.push(val); };
  if (r.ruleName !== undefined || r.rule_name !== undefined) push('rule_name', r.ruleName ?? r.rule_name);
  if (r.conditions !== undefined) { sets.push(`conditions = $${i++}::jsonb`); vals.push(JSON.stringify(r.conditions || {})); }
  if (r.entityId !== undefined || r.entity_id !== undefined) push('entity_id', r.entityId ?? r.entity_id);
  if (r.category !== undefined) push('category', r.category);
  if (r.importance !== undefined) { push('importance', r.importance); push('importance_rank', rank); }
  if (r.extractAmount !== undefined || r.extract_amount !== undefined) push('extract_amount', !!(r.extractAmount ?? r.extract_amount));
  if (r.source !== undefined) push('source', r.source);
  if (r.confirmed !== undefined) push('confirmed', !!r.confirmed);
  if (!sets.length) return null;
  sets.push(`updated_at = NOW()`);
  const { rows } = await pool.query(
    `UPDATE email_classification_rules SET ${sets.join(', ')}
     WHERE id = $1 AND user_id = $2
     RETURNING id, user_id AS "userId", rule_name AS "ruleName", conditions,
               entity_id AS "entityId", category, importance, importance_rank AS "importanceRank",
               extract_amount AS "extractAmount", source, confirmed, active,
               created_at AS "createdAt", updated_at AS "updatedAt"`,
    vals,
  );
  return rows[0] || null;
}

async function deleteRule(id, userId) {
  const { rowCount } = await pool.query(
    `UPDATE email_classification_rules SET active = FALSE, updated_at = NOW()
     WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rowCount > 0;
}

async function getClassification(userId, messageId) {
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", message_id AS "messageId", thread_id AS "threadId",
            account_email AS "accountEmail", entity_id AS "entityId",
            category, importance, importance_rank AS "importanceRank",
            action_required AS "actionRequired", is_read AS "isRead",
            amount, currency, vendor, summary, source,
            classification_reasoning AS "classificationReasoning",
            classified_at AS "classifiedAt"
     FROM email_classifications
     WHERE user_id = $1 AND message_id = $2`,
    [userId, messageId],
  );
  return rows[0] || null;
}

async function upsertClassification(userId, d) {
  const rank = _importanceRank(d.importance);
  const { rows } = await pool.query(
    `INSERT INTO email_classifications
       (user_id, message_id, thread_id, account_email, entity_id,
        category, importance, importance_rank, action_required, is_read,
        amount, currency, vendor, summary, source, classification_reasoning, classified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
     ON CONFLICT (user_id, message_id) DO UPDATE SET
       thread_id = EXCLUDED.thread_id,
       account_email = EXCLUDED.account_email,
       entity_id = EXCLUDED.entity_id,
       category = EXCLUDED.category,
       importance = EXCLUDED.importance,
       importance_rank = EXCLUDED.importance_rank,
       action_required = EXCLUDED.action_required,
       is_read = EXCLUDED.is_read,
       amount = EXCLUDED.amount,
       currency = EXCLUDED.currency,
       vendor = EXCLUDED.vendor,
       summary = EXCLUDED.summary,
       source = EXCLUDED.source,
       classification_reasoning = COALESCE(EXCLUDED.classification_reasoning, email_classifications.classification_reasoning),
       classified_at = NOW()
     RETURNING id, user_id AS "userId", message_id AS "messageId", thread_id AS "threadId",
               account_email AS "accountEmail", entity_id AS "entityId",
               category, importance, importance_rank AS "importanceRank",
               action_required AS "actionRequired", is_read AS "isRead",
               amount, currency, vendor, summary, source,
               classification_reasoning AS "classificationReasoning",
               classified_at AS "classifiedAt"`,
    [
      userId, d.messageId, d.threadId, d.accountEmail,
      d.entityId || null,
      d.category || 'general',
      d.importance || 'normal',
      rank,
      !!d.actionRequired,
      !!d.isRead,
      d.amount ?? null,
      d.currency || 'USD',
      d.vendor || null,
      d.summary || null,
      d.source || 'rule',
      d.classificationReasoning ? JSON.stringify(d.classificationReasoning) : null,
    ],
  );
  return rows[0];
}

async function batchGetClassifications(userId, messageIds) {
  if (!Array.isArray(messageIds) || !messageIds.length) return {};
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", message_id AS "messageId", thread_id AS "threadId",
            account_email AS "accountEmail", entity_id AS "entityId",
            category, importance, importance_rank AS "importanceRank",
            action_required AS "actionRequired", is_read AS "isRead",
            amount, currency, vendor, summary, source,
            classification_reasoning AS "classificationReasoning",
            classified_at AS "classifiedAt"
     FROM email_classifications
     WHERE user_id = $1 AND message_id = ANY($2::text[])`,
    [userId, messageIds],
  );
  const out = {};
  for (const r of rows) out[r.messageId] = r;
  return out;
}

async function getClassificationsByEntity(userId, entityId, limit = 50) {
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", message_id AS "messageId", thread_id AS "threadId",
            account_email AS "accountEmail", entity_id AS "entityId",
            category, importance, importance_rank AS "importanceRank",
            action_required AS "actionRequired", is_read AS "isRead",
            amount, currency, vendor, summary, source,
            classified_at AS "classifiedAt"
     FROM email_classifications
     WHERE user_id = $1 AND entity_id = $2
     ORDER BY classified_at DESC
     LIMIT $3`,
    [userId, entityId, Math.min(Math.max(1, limit), 200)],
  );
  return rows;
}

// ── Email auto-clean policy ─────────────────────────────────────────────────

async function getEmailCleanPolicy(userId) {
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId",
            archive_promos AS "archivePromos", promos_older_than_h AS "promosOlderThanH",
            archive_newsletters AS "archiveNewsletters", newsletters_older_than_h AS "newslettersOlderThanH",
            archive_social AS "archiveSocial", social_older_than_h AS "socialOlderThanH",
            confirmation_threshold AS "confirmationThreshold",
            active, created_at AS "createdAt", updated_at AS "updatedAt"
     FROM email_clean_policies WHERE user_id = $1`,
    [userId],
  );
  return rows[0] || null;
}

async function upsertEmailCleanPolicy(userId, p = {}) {
  const { rows } = await pool.query(
    `INSERT INTO email_clean_policies
       (user_id, archive_promos, promos_older_than_h,
        archive_newsletters, newsletters_older_than_h,
        archive_social, social_older_than_h,
        confirmation_threshold, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (user_id) DO UPDATE SET
       archive_promos = EXCLUDED.archive_promos,
       promos_older_than_h = EXCLUDED.promos_older_than_h,
       archive_newsletters = EXCLUDED.archive_newsletters,
       newsletters_older_than_h = EXCLUDED.newsletters_older_than_h,
       archive_social = EXCLUDED.archive_social,
       social_older_than_h = EXCLUDED.social_older_than_h,
       confirmation_threshold = EXCLUDED.confirmation_threshold,
       active = EXCLUDED.active,
       updated_at = NOW()
     RETURNING id, user_id AS "userId",
               archive_promos AS "archivePromos", promos_older_than_h AS "promosOlderThanH",
               archive_newsletters AS "archiveNewsletters", newsletters_older_than_h AS "newslettersOlderThanH",
               archive_social AS "archiveSocial", social_older_than_h AS "socialOlderThanH",
               confirmation_threshold AS "confirmationThreshold",
               active, created_at AS "createdAt", updated_at AS "updatedAt"`,
    [
      userId,
      !!p.archivePromos, parseInt(p.promosOlderThanH, 10) || 24,
      !!p.archiveNewsletters, parseInt(p.newslettersOlderThanH, 10) || 48,
      !!p.archiveSocial, parseInt(p.socialOlderThanH, 10) || 24,
      parseInt(p.confirmationThreshold, 10) || 20,
      p.active === false ? false : true,
    ],
  );
  return rows[0];
}

/**
 * Return the most recently classified emails for a user, joined with
 * the entity name. Used by the context builder to let Aria answer
 * questions about the inbox.
 */
async function getRecentClassifications(userId, limit = 20) {
  const cap = Math.min(Math.max(1, parseInt(limit, 10) || 20), 100);
  const { rows } = await pool.query(
    `SELECT ec.id, ec.user_id AS "userId", ec.message_id AS "messageId", ec.thread_id AS "threadId",
            ec.account_email AS "accountEmail", ec.entity_id AS "entityId",
            ec.category, ec.importance, ec.importance_rank AS "importanceRank",
            ec.action_required AS "actionRequired", ec.is_read AS "isRead",
            ec.amount, ec.currency, ec.vendor, ec.summary, ec.source,
            ec.classified_at AS "classifiedAt",
            e.name AS "entityName"
     FROM email_classifications ec
     LEFT JOIN entities e ON ec.entity_id = e.id
     WHERE ec.user_id = $1
     ORDER BY ec.classified_at DESC
     LIMIT $2`,
    [userId, cap],
  );
  return rows;
}

async function getImportantUnread(userId, minRank = 3) {
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", message_id AS "messageId", thread_id AS "threadId",
            account_email AS "accountEmail", entity_id AS "entityId",
            category, importance, importance_rank AS "importanceRank",
            action_required AS "actionRequired", is_read AS "isRead",
            amount, currency, vendor, summary, source,
            classified_at AS "classifiedAt"
     FROM email_classifications
     WHERE user_id = $1 AND importance_rank >= $2 AND is_read = FALSE
       AND classified_at >= NOW() - INTERVAL '7 days'
     ORDER BY importance_rank DESC, classified_at DESC`,
    [userId, minRank],
  );
  return rows;
}

// ── Classification Feedback Loop ──────────────────────────────────────────────

async function insertClassificationFeedback(userId, data) {
  const { rows } = await pool.query(
    `INSERT INTO classification_feedback
       (user_id, inbox_item_id, message_id, feedback_type, classification_snapshot,
        correction_dimensions, sender_email, sender_domain, subject_snippet)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT DO NOTHING
     RETURNING id, user_id AS "userId", feedback_type AS "feedbackType", created_at AS "createdAt"`,
    [
      userId,
      data.inboxItemId || null,
      data.messageId || null,
      data.feedbackType,
      data.classificationSnapshot ? JSON.stringify(data.classificationSnapshot) : null,
      data.correctionDimensions ? JSON.stringify(data.correctionDimensions) : null,
      data.senderEmail || null,
      data.senderDomain || null,
      data.subjectSnippet || null,
    ],
  );
  return rows[0] || null;
}

async function hasExistingFeedback(userId, messageId) {
  const { rows } = await pool.query(
    `SELECT id FROM classification_feedback WHERE user_id = $1 AND message_id = $2 LIMIT 1`,
    [userId, messageId],
  );
  return rows.length > 0;
}

async function getClassificationFeedbackByPattern(userId, patternType, patternValue, suppressDimension) {
  let where;
  if (patternType === 'sender_email') {
    where = `sender_email = $2`;
  } else if (patternType === 'sender_domain') {
    where = `sender_domain = $2`;
  } else {
    where = `subject_snippet ILIKE '%' || $2 || '%'`;
  }
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM classification_feedback
     WHERE user_id = $1 AND ${where} AND feedback_type = 'thumbs_down'
       AND correction_dimensions ? $3`,
    [userId, patternValue, suppressDimension],
  );
  return rows[0]?.count || 0;
}

async function getPositiveFeedbackCount(userId, patternType, patternValue) {
  let where;
  if (patternType === 'sender_email') {
    where = `sender_email = $2`;
  } else if (patternType === 'sender_domain') {
    where = `sender_domain = $2`;
  } else {
    where = `subject_snippet ILIKE '%' || $2 || '%'`;
  }
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM classification_feedback
     WHERE user_id = $1 AND ${where} AND feedback_type = 'thumbs_up'`,
    [userId, patternValue],
  );
  return rows[0]?.count || 0;
}

// ── Inferred Classification Rules ────────────────────────────────────────────

async function upsertInferredClassificationRule(userId, data) {
  const { rows } = await pool.query(
    `INSERT INTO inferred_classification_rules
       (user_id, pattern_type, pattern_value, suppress_dimension, strength)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, pattern_type, pattern_value, suppress_dimension) DO UPDATE SET
       signal_count = inferred_classification_rules.signal_count + 1,
       strength = LEAST(1.0, inferred_classification_rules.strength + 0.05),
       last_reinforced_at = NOW(),
       is_active = TRUE,
       updated_at = NOW()
     RETURNING id, signal_count AS "signalCount", strength`,
    [userId, data.patternType, data.patternValue, data.suppressDimension, data.strength || 0.3],
  );
  return rows[0] || null;
}

async function getActiveInferredClassificationRules(userId) {
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", pattern_type AS "patternType",
            pattern_value AS "patternValue", suppress_dimension AS "suppressDimension",
            strength, signal_count AS "signalCount",
            last_reinforced_at AS "lastReinforcedAt", is_active AS "isActive",
            created_at AS "createdAt"
     FROM inferred_classification_rules
     WHERE user_id = $1 AND is_active = TRUE AND strength >= 0.3
     ORDER BY strength DESC`,
    [userId],
  );
  return rows;
}

async function decayInferredClassificationRules() {
  const { rowCount } = await pool.query(
    `UPDATE inferred_classification_rules
     SET strength = strength * POWER(0.95, EXTRACT(EPOCH FROM (NOW() - COALESCE(last_reinforced_at, created_at))) / 86400.0),
         updated_at = NOW()
     WHERE is_active = TRUE`,
  );
  const { rowCount: archived } = await pool.query(
    `UPDATE inferred_classification_rules SET is_active = FALSE, updated_at = NOW()
     WHERE is_active = TRUE AND strength < 0.1`,
  );
  return { decayed: rowCount, archived };
}

/** Find the most recent pending row for a user on a given channel (for WhatsApp YES/NO matching). */
/**
 * Nightly/hourly sweep:
 *   1) flip rows stuck in 'pending' past their expiry (>10 min) to 'expired'
 *   2) hard-delete terminal rows older than 30 days so the table doesn't grow.
 * Returns counts for logging.
 */
async function cleanupPendingConfirmations() {
  const { rowCount: expired } = await pool.query(
    `UPDATE pending_confirmations
     SET status = 'expired', resolved_at = NOW()
     WHERE status = 'pending'
       AND created_at < NOW() - INTERVAL '10 minutes'`,
  );
  const { rowCount: deleted } = await pool.query(
    `DELETE FROM pending_confirmations
     WHERE status <> 'pending'
       AND created_at < NOW() - INTERVAL '30 days'`,
  );
  return { expired, deleted };
}

async function findLatestPendingConfirmation(userId, channel, toolName) {
  const params = [userId, channel];
  let where = `WHERE user_id = $1 AND channel = $2 AND status = 'pending' AND expires_at > NOW()`;
  if (toolName) {
    params.push(toolName);
    where += ` AND tool_name = $3`;
  }
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", tool_name AS "toolName", params_json AS "params",
            channel, status, expires_at AS "expiresAt", created_at AS "createdAt",
            decision_log_id AS "decisionLogId"
     FROM pending_confirmations
     ${where}
     ORDER BY created_at DESC LIMIT 1`,
    params,
  );
  return rows[0] || null;
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
               whatsapp_verified_at AS "whatsappVerifiedAt",
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
  try {
    const { rows } = await pool.query(
      `SELECT e.id, e.name, e.color, e.created_by AS "createdBy", e.created_at AS "createdAt",
              e.type, e.parent_id AS "parentId", e.shared,
              e.calendar_id AS "calendarId", e.color_source AS "colorSource",
              p.name AS "parentName"
       FROM entities e
       LEFT JOIN entities p ON e.parent_id = p.id
       ORDER BY e.created_at ASC`,
    );
    return rows;
  } catch {
    // Fallback if calendar_id/color_source columns don't exist yet
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
  try {
    const { rows } = await pool.query(
      `SELECT e.id, e.name, e.color, e.created_by AS "createdBy", e.created_at AS "createdAt",
              e.type, e.parent_id AS "parentId", e.shared,
              e.calendar_id AS "calendarId", e.color_source AS "colorSource",
              p.name AS "parentName",
              (e.created_by = $1) AS "isOwner"
       FROM entities e
       LEFT JOIN entities p ON e.parent_id = p.id
       WHERE e.created_by = $1 OR e.shared = true
       ORDER BY e.created_at ASC`,
      [userId],
    );
    return rows;
  } catch {
    // Fallback if calendar_id/color_source columns don't exist yet
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
}

/**
 * Canonical entity-access query for Phase 1 of the membership system.
 * Returns every entity visible to the given user via any of three paths:
 *   1. They created it (`created_by = userId`)
 *   2. It's marked org-wide and their org matches (`visibility = 'org'`)
 *   3. They're a member of it via `entity_members`
 *
 * Existing call sites keep using getEntitiesForUser for now — this helper
 * is staged for Phase 2 swap after tests pass.
 *
 * @param {string} userId - Authenticated user ID.
 * @param {string|null} orgId - The user's organization id, or null when
 *   they have no org (the org clause simply won't match).
 * @returns {Promise<Array<Object>>} Entities visible to the user.
 */
async function getEntitiesForUserWithMembership(userId, orgId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT e.id, e.name, e.color, e.created_by AS "createdBy", e.created_at AS "createdAt",
            e.type, e.parent_id AS "parentId", e.shared, e.visibility, e.org_id AS "orgId",
            e.calendar_id AS "calendarId", e.color_source AS "colorSource",
            (e.created_by = $1) AS "isOwner"
     FROM entities e
     LEFT JOIN entity_members em ON em.entity_id = e.id AND em.user_id = $1
     WHERE
       e.created_by = $1
       OR (e.visibility = 'org' AND e.org_id = $2)
       OR em.user_id = $1
     ORDER BY e.name ASC`,
    [userId, orgId],
  );
  return rows;
}

/** Return all members of an entity (includes user display info for UI). */
async function getEntityMembers(entityId) {
  const { rows } = await pool.query(
    `SELECT em.id, em.entity_id AS "entityId", em.user_id AS "userId",
            em.role, em.invited_by AS "invitedBy", em.created_at AS "createdAt",
            u.username, u.display_name AS "displayName", u.email
     FROM entity_members em
     LEFT JOIN users u ON u.id = em.user_id
     WHERE em.entity_id = $1
     ORDER BY em.created_at ASC`,
    [entityId],
  );
  return rows;
}

/**
 * Add a member to an entity. Idempotent on (entity_id, user_id) — conflict
 * updates the role/invited_by so a re-invite can upgrade a viewer to editor.
 */
async function addEntityMember(entityId, userId, role = 'editor', invitedBy = null) {
  const { rows } = await pool.query(
    `INSERT INTO entity_members (entity_id, user_id, role, invited_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (entity_id, user_id) DO UPDATE
       SET role = EXCLUDED.role,
           invited_by = COALESCE(EXCLUDED.invited_by, entity_members.invited_by)
     RETURNING id, entity_id AS "entityId", user_id AS "userId",
               role, invited_by AS "invitedBy", created_at AS "createdAt"`,
    [entityId, userId, role, invitedBy],
  );
  return rows[0] || null;
}

/** Remove a member from an entity. Returns true if a row was deleted. */
async function removeEntityMember(entityId, userId) {
  const { rowCount } = await pool.query(
    `DELETE FROM entity_members WHERE entity_id = $1 AND user_id = $2`,
    [entityId, userId],
  );
  return rowCount > 0;
}

/** Return the user's role on an entity, or null if they're not a member. */
async function getEntityMemberRole(entityId, userId) {
  const { rows } = await pool.query(
    `SELECT role FROM entity_members WHERE entity_id = $1 AND user_id = $2`,
    [entityId, userId],
  );
  return rows[0]?.role || null;
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
               type, parent_id AS "parentId", shared,
               calendar_id AS "calendarId", color_source AS "colorSource"`,
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
async function updateEntity(id, userId, fields) {
  // Defense-in-depth: scope UPDATE by created_by = userId so a missed
  // route-level ownership check cannot cross-tenant-mutate.
  const sets = [];
  const vals = [id, userId];
  let idx = 3;

  if (fields.name !== undefined) { sets.push(`name = $${idx++}`); vals.push(fields.name); }
  if (fields.color !== undefined) { sets.push(`color = $${idx++}`); vals.push(fields.color); }
  if (fields.type !== undefined) { sets.push(`type = $${idx++}`); vals.push(fields.type); }
  if (fields.parentId !== undefined) { sets.push(`parent_id = $${idx++}`); vals.push(fields.parentId || null); }
  if (fields.shared !== undefined) { sets.push(`shared = $${idx++}`); vals.push(fields.shared); }
  if (fields.calendarId !== undefined) { sets.push(`calendar_id = $${idx++}`); vals.push(fields.calendarId || null); }
  if (fields.colorSource !== undefined) { sets.push(`color_source = $${idx++}`); vals.push(fields.colorSource); }

  if (sets.length === 0) return null;

  const { rows } = await pool.query(
    `UPDATE entities SET ${sets.join(', ')} WHERE id = $1 AND created_by = $2
     RETURNING id, name, color, created_by AS "createdBy", created_at AS "createdAt",
               type, parent_id AS "parentId", shared,
               calendar_id AS "calendarId", color_source AS "colorSource"`,
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
  try {
    const { rows } = await pool.query(
      `SELECT id, name, color, created_by AS "createdBy", type, parent_id AS "parentId", shared,
              calendar_id AS "calendarId", color_source AS "colorSource"
       FROM entities WHERE id = $1`,
      [id],
    );
    return rows[0] || null;
  } catch {
    const { rows } = await pool.query(
      `SELECT id, name, color, created_by AS "createdBy", type, parent_id AS "parentId", shared
       FROM entities WHERE id = $1`,
      [id],
    );
    return rows[0] || null;
  }
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
  // Defense-in-depth: scope by created_by so a missed pre-check can't
  // cross-tenant-delete. Legacy seed entities with NULL created_by are
  // intentionally undeletable via this path — they must go through an
  // admin-only helper that explicitly allows NULL-owner cleanup.
  await pool.query('DELETE FROM entities WHERE id = $1 AND created_by = $2', [id, userId]);
}

// ── calendar_events cache helpers (Session 1) ──────────────────────────────

/**
 * Upsert a batch of GCal events for one user+account. Idempotent via
 * (user_id, account_email, id) PK; re-running the sync updates fields in
 * place and bumps synced_at.
 *
 * @param {string} userId
 * @param {string} accountEmail - Google account the events came from.
 * @param {Array<Object>} events - normalized event rows with {id, title,
 *   start_time, end_time, all_day, location, description}
 */
async function upsertCalendarEvents(userId, accountEmail, events) {
  if (!events || !events.length) return;
  // Multi-row upsert in chunks of 500 events. Prior code ran one INSERT
  // per event — at 50 users × 2 providers (gcal+outlook) every 15min,
  // that's 10k+ round-trips per cycle. pg's libpq caps at 65535 params
  // per statement; 9 params/row × 500 rows = 4500, well under cap.
  const CHUNK = 500;
  for (let i = 0; i < events.length; i += CHUNK) {
    const chunk = events.slice(i, i + CHUNK);
    const placeholders = [];
    const vals = [];
    let idx = 1;
    for (const ev of chunk) {
      placeholders.push(`($${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},NOW())`);
      vals.push(
        ev.id, userId, accountEmail, ev.title,
        ev.start_time, ev.end_time, ev.all_day || false,
        ev.location || null, ev.description || null,
      );
    }
    await pool.query(
      `INSERT INTO calendar_events
         (id, user_id, account_email, title, start_time,
          end_time, all_day, location, description, synced_at)
       VALUES ${placeholders.join(',')}
       ON CONFLICT (user_id, account_email, id)
       DO UPDATE SET
         title = EXCLUDED.title,
         start_time = EXCLUDED.start_time,
         end_time = EXCLUDED.end_time,
         all_day = EXCLUDED.all_day,
         location = EXCLUDED.location,
         description = EXCLUDED.description,
         synced_at = NOW()`,
      vals,
    );
  }
}

/**
 * Read cached events for a user within a half-open [startDate, endDate)
 * window. User-scoped — no cross-tenant access.
 */
async function getCalendarEventsForUser(userId, startDate, endDate) {
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId",
            account_email AS "accountEmail",
            title, start_time AS "startTime",
            end_time AS "endTime",
            all_day AS "allDay", location, description,
            entity_id AS "entityId"
     FROM calendar_events
     WHERE user_id = $1
       AND start_time >= $2
       AND start_time < $3
     ORDER BY start_time ASC`,
    [userId, startDate, endDate],
  );
  return rows;
}

/**
 * Purge cached events whose end_time is older than cutoffDate. The extra
 * `start_time < NOW()` guard makes absolutely sure we never delete events
 * that haven't started yet, even in degenerate cases where end_time is
 * malformed or precedes start_time (e.g. bad DST data, legacy rows).
 */
async function deleteStaleCalendarEvents(userId, cutoffDate) {
  await pool.query(
    `DELETE FROM calendar_events
     WHERE user_id = $1
       AND end_time < $2
       AND start_time < NOW()`,
    [userId, cutoffDate],
  );
}

/**
 * Meetings that recently ended (in the last 4 hours) for which the user
 * has NOT already captured notes. "Captured" = a note exists whose
 * created_at falls within the meeting window + 2 hours and whose
 * title/content mentions the meeting title. User-scoped.
 *
 * Drives the "Add notes" chip on completed events in the active zone.
 */
async function getMeetingsNeedingNotes(userId) {
  // A meeting is considered to have notes when EITHER:
  //   (a) calendar_notes has a populated post_note for this event (primary
  //       signal, written by POST /api/calendar-notes/post), OR
  //   (b) a standalone note was created around the meeting window whose
  //       title/content mentions the event title (legacy / heuristic fallback
  //       for meetings captured before the dedicated flow existed).
  const { rows } = await pool.query(
    `SELECT
       ce.id,
       ce.user_id AS "userId",
       ce.account_email AS "accountEmail",
       ce.title,
       ce.start_time AS "startTime",
       ce.end_time AS "endTime",
       ce.entity_id AS "entityId"
     FROM calendar_events ce
     WHERE ce.user_id = $1
       AND ce.end_time < NOW()
       AND ce.end_time > NOW() - INTERVAL '4 hours'
       AND ce.all_day = FALSE
       AND NOT EXISTS (
         SELECT 1 FROM calendar_notes cn
         WHERE cn.user_id = $1
           AND cn.event_id = ce.id
           AND cn.post_note IS NOT NULL
           AND cn.post_note <> ''
       )
       AND NOT EXISTS (
         SELECT 1 FROM notes n
         WHERE n.user_id = $1
           AND n.created_at > ce.start_time
           AND n.created_at < ce.end_time + INTERVAL '2 hours'
           AND (
             n.content ILIKE '%' || ce.title || '%'
             OR n.title   ILIKE '%' || ce.title || '%'
           )
       )
     ORDER BY ce.end_time DESC
     LIMIT 5`,
    [userId],
  );
  return rows;
}

/**
 * List users with at least one enabled Gmail (= GCal) integration row.
 * Used by the sync cron to iterate targets.
 */
async function getUsersWithGcalConnected() {
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id, u.timezone
     FROM users u
     JOIN user_integrations ui ON ui.user_id = u.id
     WHERE ui.integration_type = 'gmail'
       AND ui.is_enabled = TRUE
       AND ui.account_email IS NOT NULL
       AND ui.account_email != ''`,
  );
  return rows;
}

/**
 * Users with at least one active Outlook integration row. Outlook V1
 * bundles both calendar + mail under a single integration_type='outlook'
 * row (like Google bundles Calendar+Gmail under 'gmail').
 */
async function getUsersWithOutlookConnected() {
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id, u.timezone
     FROM users u
     JOIN user_integrations ui ON ui.user_id = u.id
     WHERE ui.integration_type = 'outlook'
       AND ui.is_enabled = TRUE
       AND ui.account_email IS NOT NULL
       AND ui.account_email != ''`,
  );
  return rows;
}

/**
 * No-op placeholder preserved for backward compatibility with callers
 * that still invoke it during boot/migration.
 *
 * Previously seeded founder-specific business entities (Careific, Rose,
 * Buyflip, Care Home, Personal) globally — that seed is now removed to
 * keep new deployments clean and multi-tenant. Users create their own
 * entities via the UI; existing production rows are untouched.
 */
async function seedEntitiesIfEmpty() {
  return;
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
                        tags, visibility, completed, owner, created_by, google_event_id,
                        source_email_id, source_email_subject, source_email_sender,
                        created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, NOW())
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
       source_email_id = COALESCE(EXCLUDED.source_email_id, tasks.source_email_id),
       source_email_subject = COALESCE(EXCLUDED.source_email_subject, tasks.source_email_subject),
       source_email_sender = COALESCE(EXCLUDED.source_email_sender, tasks.source_email_sender),
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
      t.sourceEmailId || null,
      t.sourceEmailSubject || null,
      t.sourceEmailSender || null,
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

// ── Gmail config (tokens moved to user_integrations) ────────────────────────

async function getAllGmailConnectedUsers() {
  const { rows } = await pool.query(
    "SELECT DISTINCT user_id FROM user_integrations WHERE integration_type = 'gmail'"
  );
  return rows.map((r) => r.user_id);
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
/**
 * Batch existence check — given an array of source_ids, returns a Set of
 * those that already exist for this user. Replaces the per-message
 * existence loop that ran one query per scanned message.
 */
async function inboxItemsExistingBySourceIds(userId, sourceIds) {
  if (!Array.isArray(sourceIds) || !sourceIds.length) return new Set();
  const { rows } = await pool.query(
    'SELECT source_id FROM inbox_items WHERE user_id = $1 AND source_id = ANY($2)',
    [userId, sourceIds],
  );
  return new Set(rows.map((r) => r.source_id));
}

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
async function updateInboxItemAction(id, action, userId) {
  // userId is required — defense-in-depth tenant scope so any future caller
  // (Aria tool, refactored bulk path) can't accidentally update another
  // user's row. Returns boolean indicating whether a row matched.
  if (!userId) throw new Error('updateInboxItemAction requires userId');
  const result = await pool.query(
    'UPDATE inbox_items SET action_taken = $2 WHERE id = $1 AND user_id = $3',
    [id, action, userId],
  );
  return result.rowCount > 0;
}

async function flagInboxItem(id, userId, reason) {
  if (!userId) throw new Error('flagInboxItem requires userId');
  const result = await pool.query(
    `UPDATE inbox_items SET flagged_at = NOW(), flagged_reason = $3
     WHERE id = $1 AND user_id = $2`,
    [id, userId, reason || 'manual'],
  );
  return result.rowCount > 0;
}

async function unflagInboxItem(id, userId) {
  if (!userId) throw new Error('unflagInboxItem requires userId');
  const result = await pool.query(
    `UPDATE inbox_items SET flagged_at = NULL, flagged_reason = NULL, flagged_acked_at = NULL
     WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return result.rowCount > 0;
}

async function ackInboxItem(id, userId) {
  if (!userId) throw new Error('ackInboxItem requires userId');
  const result = await pool.query(
    `UPDATE inbox_items SET flagged_acked_at = NOW()
     WHERE id = $1 AND user_id = $2 AND flagged_at IS NOT NULL`,
    [id, userId],
  );
  return result.rowCount > 0;
}

async function unackInboxItem(id, userId) {
  if (!userId) throw new Error('unackInboxItem requires userId');
  const result = await pool.query(
    `UPDATE inbox_items SET flagged_acked_at = NULL
     WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return result.rowCount > 0;
}

async function getFlaggedInboxItems(userId, { includeAcked = false, limit = 100, offset = 0 } = {}) {
  const ackedFilter = includeAcked ? '' : ' AND flagged_acked_at IS NULL';
  const { rows } = await pool.query(
    `SELECT * FROM inbox_items WHERE user_id = $1 AND flagged_at IS NOT NULL${ackedFilter}
     ORDER BY flagged_at DESC LIMIT $2 OFFSET $3`,
    [userId, limit, offset],
  );
  return rows;
}

async function getFlaggedInboxCount(userId, { includeAcked = false } = {}) {
  const ackedFilter = includeAcked ? '' : ' AND flagged_acked_at IS NULL';
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM inbox_items WHERE user_id = $1 AND flagged_at IS NOT NULL${ackedFilter}`,
    [userId],
  );
  return rows[0].count;
}

// "Critical" for the Active Zone tile = flagged + unacked AND the
// CURRENT classification snapshot agrees that it's actionable. Auto-flag
// fires at classification time and never auto-clears, so a demoted promo
// keeps its old flag forever; reading inbox_items in isolation overcounts.
// Predicate: importance_rank >= 3 (high/critical) OR action_required=true,
// excluding newsletter/general categories as a defense against stale rows
// that retained an inconsistent rank/ar after an incomplete reclassify.
// LEFT JOIN preserves manual flags that never went through classifyEmail
// (flagged_reason='manual') — user explicitly flagged, treat as critical.
async function getCriticalFlaggedInboxItems(userId, { limit = 10 } = {}) {
  const predicate = `
    ii.user_id = $1
    AND ii.flagged_at IS NOT NULL
    AND ii.flagged_acked_at IS NULL
    AND (
      ec.id IS NULL
      OR (
        (ec.importance_rank >= 3 OR ec.action_required = true)
        AND COALESCE(ec.category, '') NOT IN ('newsletter', 'general')
      )
    )
  `;
  const join = `LEFT JOIN email_classifications ec
                  ON ec.user_id = ii.user_id AND ec.thread_id = ii.source_id`;
  const [items, countRes] = await Promise.all([
    pool.query(
      `SELECT ii.* FROM inbox_items ii ${join}
       WHERE ${predicate}
       ORDER BY ii.flagged_at DESC LIMIT $2`,
      [userId, limit],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count FROM inbox_items ii ${join}
       WHERE ${predicate}`,
      [userId],
    ),
  ]);
  return { items: items.rows, count: countRes.rows[0].count };
}

async function getInboxItemById(id, userId) {
  const { rows } = await pool.query(
    'SELECT * FROM inbox_items WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  return rows[0] || null;
}

// ── Email labels (Gmail labels + Outlook folders) ─────────────────────────

/**
 * Search inbox_items by ILIKE across title/summary/sender.
 * Used by the AI-summary card path; the live-thread search hits Gmail
 * directly via the provider's listThreads({ query }).
 *
 * @param {string} userId
 * @param {string} q - Search string (raw — caller responsible for trimming).
 * @returns {Promise<Array<Object>>} Matching inbox_items rows, newest first, capped at 50.
 */
async function searchInboxItems(userId, q) {
  const needle = `%${q}%`;
  const { rows } = await pool.query(
    `SELECT * FROM inbox_items
       WHERE user_id = $1
         AND (title ILIKE $2 OR summary ILIKE $2 OR sender ILIKE $2)
     ORDER BY created_at DESC
     LIMIT 50`,
    [userId, needle],
  );
  return rows;
}

/**
 * Insert or update one Gmail label / Outlook folder. Idempotent via the
 * (user_id, account_email, label_id) UNIQUE. Bumps last_seen_at + label_name
 * on every call so renamed labels are reflected.
 */
async function upsertEmailLabel(userId, accountEmail, provider, labelId, labelName) {
  await pool.query(
    `INSERT INTO user_email_labels
       (user_id, account_email, provider, label_id, label_name, last_seen_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (user_id, account_email, label_id)
     DO UPDATE SET label_name = EXCLUDED.label_name,
                   last_seen_at = NOW(),
                   updated_at = NOW()`,
    [userId, accountEmail || '', provider, labelId, labelName],
  );
}

/**
 * Read all email labels for a user.
 * @param {string} userId
 * @param {Object} [opts]
 * @param {boolean} [opts.unmappedOnly=false] - Only return labels with no semantic_category yet.
 * @returns {Promise<Array<{id, accountEmail, provider, labelId, labelName, semanticCategory, messageCount}>>}
 */
async function getEmailLabelsForUser(userId, opts = {}) {
  const cond = opts.unmappedOnly ? 'AND semantic_category IS NULL' : '';
  const { rows } = await pool.query(
    `SELECT id,
            account_email AS "accountEmail",
            provider,
            label_id      AS "labelId",
            label_name    AS "labelName",
            semantic_category AS "semanticCategory",
            message_count AS "messageCount",
            last_seen_at  AS "lastSeenAt"
       FROM user_email_labels
      WHERE user_id = $1 ${cond}
      ORDER BY label_name ASC`,
    [userId],
  );
  return rows;
}

/**
 * Set the semantic category for a label. Idempotent — safe to call
 * repeatedly with the same value. Scoped by userId so a stolen label_id
 * from another user can't update this user's row.
 */
async function updateLabelSemanticCategory(userId, labelId, category) {
  await pool.query(
    `UPDATE user_email_labels
        SET semantic_category = $3, updated_at = NOW()
      WHERE user_id = $1 AND label_id = $2`,
    [userId, labelId, category],
  );
}

// ── Email filing patterns (Inbox V2 — behavioral learning hook) ──────────

/**
 * Upsert a filing pattern row. Same (user_id, account_email, match_type,
 * match_value) increments times_applied and bumps last_applied_at.
 *
 * Confidence ladder (per docs/inbox-v2.md):
 *   1 application → 0.5 (initial)
 *   3 applications → 0.8 (Aria suggests automation)
 *   5 applications → 0.95
 * Caller can pass an explicit confidence to seed; otherwise computed from
 * times_applied via the SQL CASE below.
 */
async function upsertFilingPattern({ userId, accountEmail, matchType, matchValue, targetLabelId, targetLabelName }) {
  const { rows } = await pool.query(
    `INSERT INTO email_filing_patterns
       (user_id, account_email, match_type, match_value,
        target_label_id, target_label_name,
        confidence, times_applied, last_applied_at)
     VALUES ($1, $2, $3, $4, $5, $6, 0.5, 1, NOW())
     ON CONFLICT (user_id, account_email, match_type, match_value)
     DO UPDATE SET
       times_applied = email_filing_patterns.times_applied + 1,
       last_applied_at = NOW(),
       updated_at = NOW(),
       confidence = CASE
         WHEN email_filing_patterns.times_applied + 1 >= 5 THEN 0.95
         WHEN email_filing_patterns.times_applied + 1 >= 3 THEN 0.8
         ELSE 0.5
       END,
       target_label_id = EXCLUDED.target_label_id,
       target_label_name = EXCLUDED.target_label_name
     RETURNING id, confidence, times_applied, user_approved`,
    [userId, accountEmail || '', matchType, matchValue, targetLabelId, targetLabelName],
  );
  return rows[0] || null;
}

// ── Aria Intelligence System (Phase 0) ────────────────────────────────────
//
// All helpers user-scoped. Multi-tenant isolation: every query gates on
// user_id at the SQL layer. Aria learning Lyle's patterns NEVER touches
// Liz's rules — the userId param is the only tenant boundary and there is
// no admin-bypass code path.
//
// Determinism: decision_log is append-only. The only mutation helper is
// updateDecisionOutcome, and it only touches the `outcome` column.

// ── behavior_rules ──

/**
 * Insert or update a behavior rule. (user_id, rule_text) treated as a
 * natural key for upsert semantics — repeated insertion of the same rule
 * text bumps strength + last_reinforced_at via reinforceRule, not via
 * this helper. This helper is the explicit "I want this rule" path.
 */
async function upsertBehaviorRule(userId, rule) {
  const {
    ruleType,
    triggerContext = null,
    ruleText,
    source,
    strength = 0.5,
  } = rule;
  const { rows } = await pool.query(
    `INSERT INTO behavior_rules
       (user_id, rule_type, trigger_context, rule_text, source, strength,
        last_reinforced_at, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), TRUE)
     RETURNING id, user_id AS "userId", rule_type AS "ruleType",
               trigger_context AS "triggerContext", rule_text AS "ruleText",
               source, strength, times_reinforced AS "timesReinforced",
               times_violated AS "timesViolated",
               last_reinforced_at AS "lastReinforcedAt",
               last_violated_at AS "lastViolatedAt",
               is_active AS "isActive",
               created_at AS "createdAt", updated_at AS "updatedAt"`,
    [userId, ruleType, triggerContext, ruleText, source, strength],
  );
  return rows[0] || null;
}

/**
 * Active rules for a user, sorted by strength DESC. Used by both
 * buildPreferencesBlock (Phase 1) and the decision engine (Phase 3).
 * Filters by is_active and the 0.3 inject-into-context threshold.
 */
async function getActiveRulesForUser(userId, opts = {}) {
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 10, 1), 50);
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", rule_type AS "ruleType",
            trigger_context AS "triggerContext", rule_text AS "ruleText",
            source, strength, times_reinforced AS "timesReinforced",
            times_violated AS "timesViolated",
            last_reinforced_at AS "lastReinforcedAt",
            last_violated_at AS "lastViolatedAt",
            is_active AS "isActive",
            created_at AS "createdAt", updated_at AS "updatedAt"
       FROM behavior_rules
      WHERE user_id = $1 AND is_active = TRUE AND strength >= 0.3
      ORDER BY strength DESC, updated_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

/**
 * Bump strength +0.1 (cap 1.0), increment times_reinforced, refresh
 * last_reinforced_at. Used by Phase 4 confirm signal. Scoped by userId
 * so a stolen rule_id from another user can't be promoted.
 */
async function reinforceRule(userId, ruleId) {
  const { rows } = await pool.query(
    `UPDATE behavior_rules
        SET strength = LEAST(1.0, strength + 0.1),
            times_reinforced = times_reinforced + 1,
            last_reinforced_at = NOW(),
            updated_at = NOW()
      WHERE id = $1 AND user_id = $2
      RETURNING id, strength, times_reinforced AS "timesReinforced"`,
    [ruleId, userId],
  );
  return rows[0] || null;
}

/**
 * Reduce strength -0.1 (floor 0.0), increment times_violated, refresh
 * last_violated_at. Used by Phase 4 correction signal.
 */
async function violateRule(userId, ruleId) {
  const { rows } = await pool.query(
    `UPDATE behavior_rules
        SET strength = GREATEST(0.0, strength - 0.1),
            times_violated = times_violated + 1,
            last_violated_at = NOW(),
            updated_at = NOW()
      WHERE id = $1 AND user_id = $2
      RETURNING id, strength, times_violated AS "timesViolated"`,
    [ruleId, userId],
  );
  return rows[0] || null;
}

/**
 * Apply the time-decay formula across all active rules for a user.
 * strength = strength * (0.95 ^ days_since_reinforced)
 * Falls back to created_at when last_reinforced_at is NULL. Returns the
 * count of rows touched. Phase 2 nightly cron drives this.
 */
async function decayRules(userId) {
  const { rowCount } = await pool.query(
    `UPDATE behavior_rules
        SET strength = strength
              * POWER(0.95, EXTRACT(EPOCH FROM (NOW() - COALESCE(last_reinforced_at, created_at))) / 86400.0),
            updated_at = NOW()
      WHERE user_id = $1 AND is_active = TRUE`,
    [userId],
  );
  return rowCount;
}

/**
 * Whole-table decay — single UPDATE for every active rule across all
 * users. Replaces the per-user loop in processRuleDecay (was 1k+ round
 * trips at scale every 3am). Per-row formula is unchanged; the WHERE
 * just drops the user filter.
 */
async function decayAllRules() {
  const { rowCount } = await pool.query(
    `UPDATE behavior_rules
        SET strength = strength
              * POWER(0.95, EXTRACT(EPOCH FROM (NOW() - COALESCE(last_reinforced_at, created_at))) / 86400.0),
            updated_at = NOW()
      WHERE is_active = TRUE`,
  );
  return rowCount;
}

/**
 * Auto-archive rules whose strength has decayed below 0.1. Returns the
 * count archived. Run after decayRules in the same nightly tick.
 */
async function archiveWeakRules(userId) {
  const { rowCount } = await pool.query(
    `UPDATE behavior_rules
        SET is_active = FALSE, updated_at = NOW()
      WHERE user_id = $1 AND is_active = TRUE AND strength < 0.1`,
    [userId],
  );
  return rowCount;
}

/** Whole-table archive companion to decayAllRules — same collapse rationale. */
async function archiveAllWeakRules() {
  const { rowCount } = await pool.query(
    `UPDATE behavior_rules
        SET is_active = FALSE, updated_at = NOW()
      WHERE is_active = TRUE AND strength < 0.1`,
  );
  return rowCount;
}

// ── user_preferences_v2 ──

/**
 * Upsert a key/value preference. JSONB stores arbitrary shape — caller
 * is responsible for the value schema per key. Source 'explicit' = user
 * stated; 'inferred' = pattern detection wrote it.
 */
async function setPreference(userId, key, value, source = 'explicit') {
  const { rows } = await pool.query(
    `INSERT INTO user_preferences_v2
       (user_id, preference_key, preference_value, source,
        confidence, last_confirmed_at)
     VALUES ($1, $2, $3::jsonb, $4,
             CASE WHEN $4 = 'explicit' THEN 1.0 ELSE 0.5 END,
             CASE WHEN $4 = 'explicit' THEN NOW() ELSE NULL END)
     ON CONFLICT (user_id, preference_key) DO UPDATE SET
       preference_value  = EXCLUDED.preference_value,
       source            = EXCLUDED.source,
       confidence        = EXCLUDED.confidence,
       last_confirmed_at = EXCLUDED.last_confirmed_at,
       updated_at        = NOW()
     RETURNING id, user_id AS "userId", preference_key AS "preferenceKey",
               preference_value AS "preferenceValue",
               source, confidence,
               last_confirmed_at AS "lastConfirmedAt",
               created_at AS "createdAt", updated_at AS "updatedAt"`,
    [userId, key, JSON.stringify(value), source],
  );
  return rows[0] || null;
}

async function getPreference(userId, key) {
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", preference_key AS "preferenceKey",
            preference_value AS "preferenceValue",
            source, confidence,
            last_confirmed_at AS "lastConfirmedAt",
            created_at AS "createdAt", updated_at AS "updatedAt"
       FROM user_preferences_v2
      WHERE user_id = $1 AND preference_key = $2`,
    [userId, key],
  );
  return rows[0] || null;
}

async function getAllPreferences(userId) {
  const { rows } = await pool.query(
    `SELECT id, preference_key AS "preferenceKey",
            preference_value AS "preferenceValue",
            source, confidence,
            last_confirmed_at AS "lastConfirmedAt",
            created_at AS "createdAt", updated_at AS "updatedAt"
       FROM user_preferences_v2
      WHERE user_id = $1
      ORDER BY preference_key ASC`,
    [userId],
  );
  return rows;
}

// ── decision_log ──

/**
 * Append a decision row. Returns the created row including id so the
 * caller can stash it for later updateDecisionOutcome calls. This is
 * the only INSERT path; never UPDATE except via updateDecisionOutcome.
 */
async function logDecision(userId, data) {
  const {
    actionType,
    toolCalled = null,
    toolInput = null,
    confidenceScore = null,
    riskScore = null,
    disposition,
    outcome = null,
    ruleIdsApplied = null,
    conflictDetected = false,
    conflictResolution = null,
    correctionId = null,
    contextSummary = null,
    latencyMs = null,
    conflictLevel = null,
  } = data;
  const { rows } = await pool.query(
    `INSERT INTO decision_log
       (user_id, action_type, tool_called, tool_input,
        confidence_score, risk_score, disposition, outcome,
        rule_ids_applied, conflict_detected, conflict_resolution,
        correction_id, context_summary, latency_ms, conflict_level)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id, user_id AS "userId", action_type AS "actionType",
               tool_called AS "toolCalled", tool_input AS "toolInput",
               confidence_score AS "confidenceScore",
               risk_score AS "riskScore",
               disposition, outcome,
               rule_ids_applied AS "ruleIdsApplied",
               conflict_detected AS "conflictDetected",
               conflict_resolution AS "conflictResolution",
               correction_id AS "correctionId",
               context_summary AS "contextSummary",
               latency_ms AS "latencyMs",
               conflict_level AS "conflictLevel",
               created_at AS "createdAt"`,
    [userId, actionType, toolCalled, toolInput ? JSON.stringify(toolInput) : null,
     confidenceScore, riskScore, disposition, outcome,
     ruleIdsApplied, conflictDetected, conflictResolution,
     correctionId, contextSummary, latencyMs, conflictLevel],
  );
  return rows[0] || null;
}

/**
 * Cross-tenant decision feed for the Phase 5 admin Decisions tab. Joins
 * decision_log against users for displayName + email. Optional userId
 * filter narrows to one tenant. Caller MUST be requireSuperAdmin.
 */
async function getAdminDecisions(opts = {}) {
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 100, 1), 500);
  const where = [];
  const vals = [];
  let idx = 1;
  if (opts.userId) { where.push(`d.user_id = $${idx++}`); vals.push(opts.userId); }
  if (opts.toolCalled) { where.push(`d.tool_called = $${idx++}`); vals.push(opts.toolCalled); }
  if (opts.outcome) { where.push(`d.outcome = $${idx++}`); vals.push(opts.outcome); }
  vals.push(limit);
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT d.id, d.user_id AS "userId", u.display_name AS "displayName", u.email,
            d.action_type AS "actionType", d.tool_called AS "toolCalled",
            d.tool_input AS "toolInput",
            d.confidence_score AS "confidenceScore",
            d.risk_score AS "riskScore",
            d.disposition, d.outcome,
            d.conflict_detected AS "conflictDetected",
            d.conflict_resolution AS "conflictResolution",
            d.context_summary AS "contextSummary",
            d.latency_ms AS "latencyMs",
            d.conflict_level AS "conflictLevel",
            d.created_at AS "createdAt"
       FROM decision_log d
       JOIN users u ON u.id = d.user_id
       ${whereClause}
      ORDER BY d.created_at DESC
      LIMIT $${idx}`,
    vals,
  );
  return rows;
}

/** Cross-tenant trust matrix for admin Decisions tab. Caller is super-admin. */
async function getAdminTrustMatrix(opts = {}) {
  const where = [];
  const vals = [];
  let idx = 1;
  if (opts.userId) { where.push(`t.user_id = $${idx++}`); vals.push(opts.userId); }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT t.id, t.user_id AS "userId", u.display_name AS "displayName", u.email,
            t.action_type AS "actionType", t.trust_score AS "trustScore",
            t.disposition, t.is_reversible AS "isReversible",
            t.impact_level AS "impactLevel",
            t.times_auto_executed AS "timesAutoExecuted",
            t.times_confirmed AS "timesConfirmed",
            t.times_rejected AS "timesRejected",
            t.times_corrected AS "timesCorrected",
            t.updated_at AS "updatedAt"
       FROM trust_scores t
       JOIN users u ON u.id = t.user_id
       ${whereClause}
      ORDER BY u.display_name ASC, t.action_type ASC`,
    vals,
  );
  return rows;
}

/** Recent correction events for admin Decisions tab. */
async function getAdminCorrections(opts = {}) {
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 100, 1), 500);
  const where = [];
  const vals = [];
  let idx = 1;
  if (opts.userId) { where.push(`c.user_id = $${idx++}`); vals.push(opts.userId); }
  vals.push(limit);
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT c.id, c.user_id AS "userId", u.display_name AS "displayName",
            c.decision_log_id AS "decisionLogId",
            c.original_action AS "originalAction",
            c.correction_type AS "correctionType",
            c.correction_note AS "correctionNote",
            c.generated_rule_id AS "generatedRuleId",
            c.created_at AS "createdAt"
       FROM correction_events c
       JOIN users u ON u.id = c.user_id
       ${whereClause}
      ORDER BY c.created_at DESC
      LIMIT $${idx}`,
    vals,
  );
  return rows;
}

async function getDecisionHistory(userId, opts = {}) {
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 20, 1), 200);
  const { rows } = await pool.query(
    `SELECT id, action_type AS "actionType", tool_called AS "toolCalled",
            tool_input AS "toolInput",
            confidence_score AS "confidenceScore",
            risk_score AS "riskScore",
            disposition, outcome,
            rule_ids_applied AS "ruleIdsApplied",
            conflict_detected AS "conflictDetected",
            conflict_resolution AS "conflictResolution",
            correction_id AS "correctionId",
            context_summary AS "contextSummary",
            created_at AS "createdAt"
       FROM decision_log
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

/**
 * The ONLY mutation allowed on decision_log. Flips `outcome` only.
 * Userid passed for safety — server should always know which user the
 * decision belongs to before updating.
 */
async function updateDecisionOutcome(userId, decisionId, outcome) {
  const { rows } = await pool.query(
    `UPDATE decision_log
        SET outcome = $3
      WHERE id = $1 AND user_id = $2
      RETURNING id, outcome`,
    [decisionId, userId, outcome],
  );
  return rows[0] || null;
}

// ── trust_scores ──

/**
 * Default trust matrix per the Phase 0 spec. Seeded once per user via
 * seedDefaultTrustScores. All start as confirm_required; auto_allowed
 * is unlocked through Phase 4 trust building.
 */
const DEFAULT_TRUST_MATRIX = [
  { actionType: 'create_task',            score: 0.6,  reversible: true,  impact: 'low',    disposition: 'confirm_required' },
  { actionType: 'complete_task',          score: 0.6,  reversible: true,  impact: 'low',    disposition: 'confirm_required' },
  { actionType: 'create_event',           score: 0.7,  reversible: true,  impact: 'low',    disposition: 'confirm_required' },
  { actionType: 'update_task',            score: 0.65, reversible: true,  impact: 'low',    disposition: 'confirm_required' },
  { actionType: 'delete_task',            score: 0.9,  reversible: false, impact: 'high',   disposition: 'confirm_required' },
  { actionType: 'delete_event',           score: 0.9,  reversible: false, impact: 'high',   disposition: 'confirm_required' },
  { actionType: 'archive_email',          score: 0.65, reversible: true,  impact: 'low',    disposition: 'confirm_required' },
  { actionType: 'mark_email_read',        score: 0.5,  reversible: true,  impact: 'low',    disposition: 'confirm_required' },
  { actionType: 'move_email',             score: 0.6,  reversible: true,  impact: 'low',    disposition: 'confirm_required' },
  { actionType: 'star_email',             score: 0.5,  reversible: true,  impact: 'low',    disposition: 'confirm_required' },
  { actionType: 'send_message',           score: 0.85, reversible: false, impact: 'high',   disposition: 'confirm_required' },
  { actionType: 'create_journal_entry',   score: 0.6,  reversible: true,  impact: 'low',    disposition: 'confirm_required' },
  { actionType: 'close_task_with_note',   score: 0.7,  reversible: true,  impact: 'low',    disposition: 'confirm_required' },
  { actionType: 'add_event_outcome_note', score: 0.6,  reversible: true,  impact: 'low',    disposition: 'confirm_required' },
  { actionType: 'create_contact',         score: 0.7,  reversible: true,  impact: 'low',    disposition: 'confirm_required' },
  { actionType: 'update_contact',         score: 0.75, reversible: true,  impact: 'medium', disposition: 'confirm_required' },
  { actionType: 'grant_shared_access',    score: 0.95, reversible: false, impact: 'high',   disposition: 'confirm_required' },
  { actionType: 'create_project',         score: 0.7,  reversible: true,  impact: 'low',    disposition: 'confirm_required' },
];

async function getTrustScore(userId, actionType) {
  const { rows } = await pool.query(
    `SELECT id, action_type AS "actionType", trust_score AS "trustScore",
            disposition, is_reversible AS "isReversible",
            impact_level AS "impactLevel",
            times_auto_executed AS "timesAutoExecuted",
            times_confirmed AS "timesConfirmed",
            times_rejected AS "timesRejected",
            times_corrected AS "timesCorrected",
            created_at AS "createdAt", updated_at AS "updatedAt"
       FROM trust_scores
      WHERE user_id = $1 AND action_type = $2`,
    [userId, actionType],
  );
  return rows[0] || null;
}

/**
 * Apply a delta to trust_score (clamped 0.0–1.0). Returns the new row.
 * Phase 4 signals call this with +0.02 / -0.05 / -0.1 etc.
 */
async function updateTrustScore(userId, actionType, delta) {
  const { rows } = await pool.query(
    `UPDATE trust_scores
        SET trust_score = LEAST(1.0, GREATEST(0.0, trust_score + $3)),
            updated_at = NOW()
      WHERE user_id = $1 AND action_type = $2
      RETURNING id, action_type AS "actionType",
                trust_score AS "trustScore", disposition,
                is_reversible AS "isReversible",
                impact_level AS "impactLevel"`,
    [userId, actionType, delta],
  );
  return rows[0] || null;
}

/**
 * Phase 4 — atomic trust-feedback application. In one transaction:
 *   1. Flip decision_log.outcome (the existing audit step).
 *   2. Bump trust_scores counters (times_confirmed/rejected/corrected).
 *   3. Apply trust_score delta per the Phase 4 deltas:
 *        confirmed → +0.02
 *        rejected  → -0.05
 *        corrected → -0.10  (caller signals via outcome='corrected'
 *          when a correction_event was logged in the same flow)
 *
 * Counter columns + delta both move so the matrix view (admin Decisions
 * tab) shows both the magnitude and the cumulative pattern.
 *
 * actionType is the tool name from the agentic loop. It maps 1:1 with
 * DEFAULT_TRUST_MATRIX rows; rows that aren't in the matrix silently
 * no-op the trust_score side (no row to update) but still flip outcome.
 */
async function applyTrustFeedback(userId, decisionId, outcome, actionType) {
  const COUNTER_COL = {
    confirmed: 'times_confirmed',
    rejected:  'times_rejected',
    corrected: 'times_corrected',
    executed:  null, // auto_proceed pass-through; no trust signal
    timeout:   null,
  };
  const DELTA = {
    confirmed: +0.02,
    rejected:  -0.05,
    corrected: -0.10,
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Flip decision_log.outcome (same shape as updateDecisionOutcome).
    await client.query(
      `UPDATE decision_log SET outcome = $3 WHERE id = $1 AND user_id = $2`,
      [decisionId, userId, outcome],
    );

    // 2 + 3. Counter + delta (skip if outcome doesn't carry a trust signal,
    // or if the action isn't in the trust matrix yet).
    const counterCol = COUNTER_COL[outcome];
    const delta = DELTA[outcome] || 0;
    let trustRow = null;
    if (counterCol && actionType) {
      const { rows } = await client.query(
        `UPDATE trust_scores
            SET ${counterCol} = ${counterCol} + 1,
                trust_score = LEAST(1.0, GREATEST(0.0, trust_score + $3)),
                updated_at = NOW()
          WHERE user_id = $1 AND action_type = $2
          RETURNING id, action_type AS "actionType",
                    trust_score AS "trustScore", disposition,
                    times_confirmed AS "timesConfirmed",
                    times_rejected AS "timesRejected",
                    times_corrected AS "timesCorrected"`,
        [userId, actionType, delta],
      );
      trustRow = rows[0] || null;
    }

    await client.query('COMMIT');
    return { decisionId, outcome, trustRow };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Phase 4 — count unprocessed correction events for one action_type.
 * "Unprocessed" = generated_rule_id IS NULL. Used by the rule-generator
 * to decide whether the user has corrected this action enough times to
 * warrant materialising the pattern as an explicit behavior_rule.
 */
async function countPendingCorrections(userId, actionType) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM correction_events
      WHERE user_id = $1 AND original_action = $2 AND generated_rule_id IS NULL`,
    [userId, actionType],
  );
  return rows[0]?.n || 0;
}

/**
 * Mark all unprocessed corrections for (userId, actionType) as having
 * been folded into the given behavior_rule id. Single UPDATE.
 */
async function markCorrectionsProcessed(userId, actionType, generatedRuleId) {
  const { rowCount } = await pool.query(
    `UPDATE correction_events
        SET generated_rule_id = $3, trust_score_adjusted = TRUE
      WHERE user_id = $1 AND original_action = $2 AND generated_rule_id IS NULL`,
    [userId, actionType, generatedRuleId],
  );
  return rowCount;
}

/**
 * Idempotent — uses ON CONFLICT DO NOTHING so re-seeding never clobbers
 * a trust_score the user has already moved through Phase 4 signals.
 * Called per user at registration (wired in Phase 1).
 */
async function seedDefaultTrustScores(userId) {
  let seeded = 0;
  for (const row of DEFAULT_TRUST_MATRIX) {
    const r = await pool.query(
      `INSERT INTO trust_scores
         (user_id, action_type, trust_score, disposition,
          is_reversible, impact_level)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, action_type) DO NOTHING`,
      [userId, row.actionType, row.score, row.disposition, row.reversible, row.impact],
    );
    if (r.rowCount) seeded++;
  }
  return seeded;
}

/**
 * Convenience read for the decision engine — returns just the
 * disposition string ('auto_allowed' / 'confirm_required' / 'suggest_only')
 * or null if no row exists for that action type.
 */
async function getDisposition(userId, actionType) {
  const ts = await getTrustScore(userId, actionType);
  return ts ? ts.disposition : null;
}

// ── correction_events ──

/**
 * Log a correction event. trust_score_adjusted defaults FALSE; Phase 4
 * worker flips it after applying the trust score delta so corrections
 * aren't double-counted across retries.
 */
async function logCorrection(userId, data) {
  const {
    decisionLogId = null,
    originalAction,
    originalToolInput = null,
    correctionType,
    correctedInput = null,
    correctionNote = null,
    inferredRuleViolation = null,
    generatedRuleId = null,
    trustScoreAdjusted = false,
  } = data;
  const { rows } = await pool.query(
    `INSERT INTO correction_events
       (user_id, decision_log_id, original_action, original_tool_input,
        correction_type, corrected_input, correction_note,
        inferred_rule_violation, generated_rule_id, trust_score_adjusted)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8, $9, $10)
     RETURNING id, user_id AS "userId",
               decision_log_id AS "decisionLogId",
               original_action AS "originalAction",
               original_tool_input AS "originalToolInput",
               correction_type AS "correctionType",
               corrected_input AS "correctedInput",
               correction_note AS "correctionNote",
               inferred_rule_violation AS "inferredRuleViolation",
               generated_rule_id AS "generatedRuleId",
               trust_score_adjusted AS "trustScoreAdjusted",
               created_at AS "createdAt"`,
    [userId, decisionLogId, originalAction,
     originalToolInput ? JSON.stringify(originalToolInput) : null,
     correctionType,
     correctedInput ? JSON.stringify(correctedInput) : null,
     correctionNote, inferredRuleViolation, generatedRuleId, trustScoreAdjusted],
  );
  return rows[0] || null;
}

// ── Aria Intelligence System (Phase 1) — User Preferences ────────────────
//
// Phase 1's user-facing "preferences" data layers on top of behavior_rules
// from Phase 0. The Phase 0 helpers (upsertBehaviorRule, getActiveRulesForUser,
// reinforceRule, etc.) remain the canonical CRUD path for the decision
// engine in Phase 3. The helpers below add Phase 1's domain vocabulary
// (category / preference_type / 1–5 strength) as a thin translation layer.
//
// Strength translation is bidirectional and lossy:
//   1 ↔ 0.2   (HINT)
//   2 ↔ 0.4   (WEAK)
//   3 ↔ 0.6   (NORMAL)
//   4 ↔ 0.8   (STRONG)
//   5 ↔ 1.0   (ABSOLUTE)
// Phase 3's decision engine reads FLOAT strength as designed (>= 0.8 =
// constraint hard-stop, >= 0.6 = preference confirm). preference_type
// 'never' or 'ask_first' OR strength=5 is stored as rule_type='constraint'
// so Phase 3's existing branching works without modification.

const PREF_VALID_CATEGORIES = new Set(['tasks', 'calendar', 'email', 'communication', 'general']);
const PREF_VALID_TYPES = new Set(['always', 'never', 'ask_first', 'prefer', 'avoid']);

function _strengthIntToFloat(n) {
  const i = Math.min(Math.max(parseInt(n, 10) || 3, 1), 5);
  return [0.2, 0.4, 0.6, 0.8, 1.0][i - 1];
}
function _strengthFloatToInt(f) {
  const v = Number(f);
  if (!Number.isFinite(v)) return 3;
  // Round to the closest 0.2 step, clamp 1..5.
  return Math.min(Math.max(Math.round(v * 5), 1), 5);
}
// 'never' and 'ask_first' are functionally constraints (hard stops or
// mandatory confirmation). 'always' / 'prefer' / 'avoid' are preferences
// (suggestion-strength signals). Strength=5 always upgrades to constraint.
function _deriveRuleType(preferenceType, strengthInt) {
  if (strengthInt === 5) return 'constraint';
  if (preferenceType === 'never' || preferenceType === 'ask_first') return 'constraint';
  return 'preference';
}

/**
 * Create a Phase 1 user preference. Always source='explicit' — Phase 1
 * captures only what the user states. Pattern inference is Phase 2.
 *
 * @param {string} userId
 * @param {string} category - One of PREF_VALID_CATEGORIES.
 * @param {string} preferenceType - One of PREF_VALID_TYPES.
 * @param {string} description - Human-readable preference statement (becomes rule_text).
 * @param {string} [context] - Optional applicability scope (becomes trigger_context).
 * @param {number} [strength=3] - 1–5 integer (5 = ABSOLUTE).
 * @returns {Promise<Object|null>} The created row in Phase 1 shape (strength as 1–5 integer).
 */
async function createUserPreference(userId, category, preferenceType, description, context = null, strength = 3) {
  if (!PREF_VALID_CATEGORIES.has(category)) {
    throw new Error(`Invalid category: ${category}. Must be one of: ${[...PREF_VALID_CATEGORIES].join(', ')}`);
  }
  if (!PREF_VALID_TYPES.has(preferenceType)) {
    throw new Error(`Invalid preference_type: ${preferenceType}. Must be one of: ${[...PREF_VALID_TYPES].join(', ')}`);
  }
  if (!description || typeof description !== 'string') {
    throw new Error('description is required');
  }
  const strengthInt = Math.min(Math.max(parseInt(strength, 10) || 3, 1), 5);
  const strengthFloat = _strengthIntToFloat(strengthInt);
  const ruleType = _deriveRuleType(preferenceType, strengthInt);

  const { rows } = await pool.query(
    `INSERT INTO behavior_rules
       (user_id, rule_type, trigger_context, rule_text, source, strength,
        category, preference_type,
        last_reinforced_at, is_active)
     VALUES ($1, $2, $3, $4, 'explicit', $5, $6, $7, NOW(), TRUE)
     RETURNING id, user_id AS "userId", rule_type AS "ruleType",
               trigger_context AS "context", rule_text AS "description",
               source, strength,
               category, preference_type AS "preferenceType",
               removed_reason AS "removedReason",
               times_reinforced AS "timesReinforced",
               times_violated AS "timesViolated",
               last_reinforced_at AS "lastReinforcedAt",
               last_violated_at AS "lastViolatedAt",
               is_active AS "isActive",
               created_at AS "createdAt", updated_at AS "updatedAt"`,
    [userId, ruleType, context, description, strengthFloat, category, preferenceType],
  );
  const row = rows[0];
  if (!row) return null;
  // Translate FLOAT back to 1–5 integer for the Phase 1 surface.
  row.strength = _strengthFloatToInt(row.strength);
  return row;
}

/**
 * List a user's Phase 1 preferences. Defaults to active only. Optionally
 * filter by category. Returns rows in Phase 1 shape (strength as 1–5).
 */
async function getUserPreferences(userId, category = null, includeInactive = false) {
  const conds = ['user_id = $1', 'preference_type IS NOT NULL'];
  const params = [userId];
  if (!includeInactive) conds.push('is_active = TRUE');
  if (category) {
    if (!PREF_VALID_CATEGORIES.has(category)) {
      throw new Error(`Invalid category: ${category}`);
    }
    params.push(category);
    conds.push(`category = $${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", rule_type AS "ruleType",
            trigger_context AS "context", rule_text AS "description",
            source, strength,
            category, preference_type AS "preferenceType",
            removed_reason AS "removedReason",
            times_reinforced AS "timesReinforced",
            times_violated AS "timesViolated",
            last_reinforced_at AS "lastReinforcedAt",
            last_violated_at AS "lastViolatedAt",
            is_active AS "isActive",
            created_at AS "createdAt", updated_at AS "updatedAt"
       FROM behavior_rules
      WHERE ${conds.join(' AND ')}
      ORDER BY category ASC NULLS LAST, strength DESC, updated_at DESC`,
    params,
  );
  return rows.map((r) => ({ ...r, strength: _strengthFloatToInt(r.strength) }));
}

/**
 * Fetch one preference by id, scoped by userId so a stolen id can't
 * read another user's row.
 */
async function getUserPreferenceById(userId, preferenceId) {
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", rule_type AS "ruleType",
            trigger_context AS "context", rule_text AS "description",
            source, strength,
            category, preference_type AS "preferenceType",
            removed_reason AS "removedReason",
            is_active AS "isActive",
            created_at AS "createdAt", updated_at AS "updatedAt"
       FROM behavior_rules
      WHERE id = $1 AND user_id = $2 AND preference_type IS NOT NULL`,
    [preferenceId, userId],
  );
  const row = rows[0];
  if (!row) return null;
  row.strength = _strengthFloatToInt(row.strength);
  return row;
}

/**
 * Soft-delete a preference: is_active=FALSE + stash reason. Behavior_rules
 * stays append-mostly so the audit trail survives. Scoped by userId.
 */
async function removeUserPreference(userId, preferenceId, reason) {
  const { rows } = await pool.query(
    `UPDATE behavior_rules
        SET is_active = FALSE,
            removed_reason = $3,
            updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND preference_type IS NOT NULL
      RETURNING id, is_active AS "isActive", removed_reason AS "removedReason"`,
    [preferenceId, userId, reason || null],
  );
  return rows[0] || null;
}

// ── Aria Intelligence System (Phase 2) — Inferred Rules ──────────────────

/**
 * Upsert an inferred rule keyed by (user_id, pattern_type, rule_text).
 * If a matching rule exists: bump signal_count, refresh last_reinforced_at,
 * and gently increase strength toward 1.0 (cap +0.05 per signal).
 * If new: insert with the supplied initial strength.
 *
 * NEVER infers constraints — Phase 2 spec is explicit. rule_type is
 * always 'preference' or 'pattern'; source is always 'inferred'.
 *
 * Returns { row, isNew, signalCount }.
 */
async function upsertInferredRule(userId, rule) {
  const {
    ruleType,             // 'preference' | 'pattern' (NEVER 'constraint')
    patternType,          // 'time_preference' | 'entity_affinity' | etc.
    category = null,
    triggerContext = null,
    contextData = null,
    ruleText,
    initialStrength = 0.5,
  } = rule;
  if (ruleType === 'constraint') {
    throw new Error('Phase 2: inference must not produce constraints');
  }
  const safeRuleType = ruleType === 'preference' ? 'preference' : 'pattern';

  // Check for existing rule with same pattern + text. Scope by userId.
  const { rows: existing } = await pool.query(
    `SELECT id, signal_count, strength
       FROM behavior_rules
      WHERE user_id = $1
        AND pattern_type = $2
        AND rule_text = $3
        AND source = 'inferred'
      LIMIT 1`,
    [userId, patternType, ruleText],
  );

  if (existing.length) {
    const cur = existing[0];
    const { rows } = await pool.query(
      `UPDATE behavior_rules
          SET signal_count = signal_count + 1,
              strength = LEAST(1.0, strength + 0.05),
              last_reinforced_at = NOW(),
              is_active = TRUE,
              context_data = COALESCE($3::jsonb, context_data),
              updated_at = NOW()
        WHERE id = $1 AND user_id = $2
        RETURNING id, signal_count AS "signalCount", strength,
                  last_reinforced_at AS "lastReinforcedAt"`,
      [cur.id, userId, contextData ? JSON.stringify(contextData) : null],
    );
    return { row: rows[0], isNew: false, signalCount: rows[0]?.signalCount };
  }

  const { rows } = await pool.query(
    `INSERT INTO behavior_rules
       (user_id, rule_type, source, pattern_type, category,
        trigger_context, context_data, rule_text, strength,
        signal_count, last_reinforced_at, is_active)
     VALUES ($1, $2, 'inferred', $3, $4, $5, $6::jsonb, $7, $8, 1, NOW(), TRUE)
     RETURNING id, signal_count AS "signalCount", strength,
               last_reinforced_at AS "lastReinforcedAt"`,
    [
      userId, safeRuleType, patternType, category, triggerContext,
      contextData ? JSON.stringify(contextData) : null,
      ruleText, initialStrength,
    ],
  );
  return { row: rows[0], isNew: true, signalCount: 1 };
}

/**
 * Read inferred rules for a user. Filters source='inferred', is_active,
 * and the 0.3 inject-into-context threshold by default. Used by
 * buildAgenticContext + the cache layer.
 */
async function getInferredRulesForUser(userId, opts = {}) {
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 20, 1), 100);
  const minStrength = typeof opts.minStrength === 'number' ? opts.minStrength : 0.3;
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", rule_type AS "ruleType",
            pattern_type AS "patternType",
            category, trigger_context AS "triggerContext",
            context_data AS "contextData",
            rule_text AS "ruleText",
            source, strength,
            signal_count AS "signalCount",
            times_reinforced AS "timesReinforced",
            times_violated AS "timesViolated",
            last_reinforced_at AS "lastReinforcedAt",
            last_violated_at AS "lastViolatedAt",
            is_active AS "isActive",
            created_at AS "createdAt", updated_at AS "updatedAt"
       FROM behavior_rules
      WHERE user_id = $1
        AND source = 'inferred'
        AND is_active = TRUE
        AND strength >= $2
      ORDER BY strength DESC, last_reinforced_at DESC NULLS LAST
      LIMIT $3`,
    [userId, minStrength, limit],
  );
  return rows;
}

/**
 * Read every user id. Used by the nightly decay cron to iterate all
 * users. Returns just the id column to keep the result small.
 */
async function getAllUserIds() {
  const { rows } = await pool.query(`SELECT id FROM users`);
  return rows.map((r) => r.id);
}

async function getCorrections(userId, opts = {}) {
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 20, 1), 200);
  const { rows } = await pool.query(
    `SELECT id, decision_log_id AS "decisionLogId",
            original_action AS "originalAction",
            original_tool_input AS "originalToolInput",
            correction_type AS "correctionType",
            corrected_input AS "correctedInput",
            correction_note AS "correctionNote",
            inferred_rule_violation AS "inferredRuleViolation",
            generated_rule_id AS "generatedRuleId",
            trust_score_adjusted AS "trustScoreAdjusted",
            created_at AS "createdAt"
       FROM correction_events
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

// ── Notes ─────────────────────────────────────────────────────────────────────

/**
 * Shared RETURNING clause for note queries. Aliased to camelCase so all
 * note helpers return a consistent shape without per-query duplication.
 * @type {string}
 */
const NOTE_RETURNING = `id, user_id AS "userId", title, content, visibility,
  type, pillar, category, subcategory, tags, pinned, archived, entity_id AS "entityId",
  source_email_id AS "sourceEmailId", source_email_subject AS "sourceEmailSubject",
  source_email_sender AS "sourceEmailSender",
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
  const limit = filters.limit || 100;
  const { rows } = await pool.query(
    `SELECT ${NOTE_RETURNING} FROM notes WHERE ${where.join(' AND ')} ORDER BY pinned DESC, created_at DESC LIMIT $${idx}`,
    [...vals, limit],
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
 * @note Unlike getNotesForUser, this does NOT filter by visibility
 * or type — Aria needs the full picture to give context-aware
 * responses. Archived notes are excluded to avoid stale context.
 *
 * @param {string} userId - User ID.
 * @returns {Promise<Array<Object>>} Notes with id, title, content, visibility, pillar, category.
 * @throws {Error} If the database query fails.
 */
async function getPrivateNotesForAI(userId) {
  const { rows } = await pool.query(
    `SELECT id, title, content, visibility, pillar, category
     FROM notes WHERE user_id = $1 AND archived = FALSE
     ORDER BY created_at DESC LIMIT 50`,
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
async function createNote({ id, userId, title, content, visibility, type, pillar, category, subcategory, tags, entityId, sourceEmailId, sourceEmailSubject, sourceEmailSender }) {
  const { rows } = await pool.query(
    `INSERT INTO notes (id, user_id, title, content, visibility, type, pillar, category, subcategory, tags, entity_id,
                        source_email_id, source_email_subject, source_email_sender)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING ${NOTE_RETURNING}`,
    [id, userId, title || '', content || '', visibility || 'private',
     type || 'quick', pillar || null, category || '', subcategory || '',
     JSON.stringify(tags || []), entityId || null,
     sourceEmailId || null, sourceEmailSubject || null, sourceEmailSender || null],
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
    hustle: ['Work', 'Projects', 'Clients', 'Finance'],
    home: ['Family', 'Household', 'Personal'],
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
async function updateTask(id, userId, fields) {
  // Defense-in-depth: mandate owner = userId on the UPDATE so a missed
  // pre-check in the route layer cannot cross-tenant-mutate.
  const { rows } = await pool.query(
    `UPDATE tasks
     SET title           = COALESCE($3, title),
         description     = COALESCE($4, description),
         priority        = COALESCE($5, priority),
         due_date        = COALESCE($6, due_date),
         due_time        = COALESCE($7, due_time),
         tags            = COALESCE($8, tags),
         visibility      = COALESCE($9, visibility),
         completed       = COALESCE($10, completed),
         google_event_id = COALESCE($11, google_event_id),
         completed_at    = CASE WHEN $12::text = '__null__' THEN NULL WHEN $12::text IS NOT NULL THEN $12::timestamptz ELSE completed_at END,
         completion_note = COALESCE($13, completion_note),
         updated_at      = NOW()
     WHERE id = $1 AND owner = $2
     RETURNING id, title, description, priority, status, due_date AS "dueDate",
               due_time AS "dueTime", tags, visibility, completed, completed_at AS "completedAt", owner, created_by AS "createdBy",
               google_event_id AS "googleEventId", completion_note AS "completionNote", created_at AS "createdAt", updated_at AS "updatedAt"`,
    [
      id,
      userId,
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
    `SELECT u.id, u.timezone, u.role, u.entity_ids AS "entityIds",
            om.org_id AS "orgId"
     FROM users u
     LEFT JOIN org_members om ON om.user_id = u.id
     WHERE u.id = $1
     LIMIT 1`,
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
/**
 * Look up a user by username OR email (case-insensitive). Returns the
 * minimal public-safe projection — no password hash. Used by the entity
 * member invite endpoint so the UI can send a human-readable identifier.
 */
async function getUserByIdentifier(identifier) {
  if (!identifier) return null;
  const { rows } = await pool.query(
    `SELECT id, username, display_name AS "displayName", email
     FROM users
     WHERE username ILIKE $1 OR email ILIKE $1
     LIMIT 1`,
    [String(identifier).trim()],
  );
  return rows[0] || null;
}

async function getUserById(id) {
  const { rows } = await pool.query(
    `SELECT id, username, display_name AS "displayName", password_hash AS "passwordHash",
            email, role, entity_ids AS "entityIds", active,
            persona, assistant_name AS "assistantName", whatsapp_phone AS "whatsappPhone",
            whatsapp_verified_at AS "whatsappVerifiedAt",
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
            whatsapp_verified_at AS "whatsappVerifiedAt",
            profile_name AS "profileName", profile_businesses AS "profileBusinesses",
            profile_household AS "profileHousehold", profile_location AS "profileLocation",
            profile_notes AS "profileNotes", timezone
     FROM users WHERE REGEXP_REPLACE(whatsapp_phone, '[^0-9]', '', 'g') = $1`,
    [normalizedPhone],
  );
  return rows[0] || null;
}

// ── WhatsApp phone verification (anti-takeover) ──────────────────────────

/** Strip everything except digits — same normalization the lookup uses. */
function normalizeWhatsAppPhone(raw) {
  if (!raw) return '';
  return String(raw).replace(/[^0-9]/g, '');
}

/**
 * Issue (or replace) the pending verification row for this user. Caller is
 * responsible for sending the code via UltraMsg to the to-be-claimed phone.
 * Returns nothing — caller already knows the code it minted.
 */
async function mintWhatsAppVerification(userId, phoneNormalized, code, ttlSeconds = 600) {
  await pool.query(
    `INSERT INTO pending_whatsapp_verifications
       (user_id, phone_normalized, code, expires_at, attempts, created_at)
     VALUES ($1, $2, $3, NOW() + ($4 || ' seconds')::interval, 0, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       phone_normalized = EXCLUDED.phone_normalized,
       code             = EXCLUDED.code,
       expires_at       = EXCLUDED.expires_at,
       attempts         = 0,
       created_at       = NOW()`,
    [userId, phoneNormalized, code, String(ttlSeconds)],
  );
}

/**
 * Validate a code against this user's pending verification.
 *   - Returns { ok: true, phoneNormalized } and deletes the row on success.
 *   - Returns { ok: false, reason: 'no_pending' | 'expired' | 'bad_code' | 'too_many_attempts' }
 *     on any failure path. Bumps attempts on a wrong code; gives up at 5.
 */
async function consumeWhatsAppVerification(userId, code) {
  const { rows } = await pool.query(
    `SELECT id, phone_normalized AS "phoneNormalized", code, expires_at AS "expiresAt", attempts
       FROM pending_whatsapp_verifications WHERE user_id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: 'no_pending' };
  if (new Date(row.expiresAt) <= new Date()) {
    await pool.query('DELETE FROM pending_whatsapp_verifications WHERE id = $1', [row.id]);
    return { ok: false, reason: 'expired' };
  }
  if (row.attempts >= 5) {
    await pool.query('DELETE FROM pending_whatsapp_verifications WHERE id = $1', [row.id]);
    return { ok: false, reason: 'too_many_attempts' };
  }
  if (String(row.code) !== String(code)) {
    await pool.query(
      'UPDATE pending_whatsapp_verifications SET attempts = attempts + 1 WHERE id = $1',
      [row.id],
    );
    return { ok: false, reason: 'bad_code' };
  }
  await pool.query('DELETE FROM pending_whatsapp_verifications WHERE id = $1', [row.id]);
  return { ok: true, phoneNormalized: row.phoneNormalized };
}

/**
 * Atomically set a user's whatsapp_phone, catching the UNIQUE-index
 * violation as a clean { ok: false, reason: 'already_claimed' } so callers
 * don't have to handle the raw 23505 SQLSTATE. Also stamps
 * whatsapp_verified_at so future audits can distinguish verified
 * (post-fix) phones from legacy (pre-fix) ones.
 */
async function setVerifiedWhatsAppPhone(userId, phoneNormalized) {
  try {
    await pool.query(
      `UPDATE users SET whatsapp_phone = $2, whatsapp_verified_at = NOW() WHERE id = $1`,
      [userId, phoneNormalized],
    );
    return { ok: true };
  } catch (err) {
    if (err.code === '23505') return { ok: false, reason: 'already_claimed' };
    throw err;
  }
}

/** Clear a user's whatsapp_phone — no verification needed for unsetting. */
async function clearUserWhatsAppPhone(userId) {
  await pool.query(
    `UPDATE users SET whatsapp_phone = NULL, whatsapp_verified_at = NULL WHERE id = $1`,
    [userId],
  );
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
 * @note Founder-specific migration steps (seeding Lyle's entities,
 * promoting user-lyle to superadmin, creating Dizon Household org)
 * have been removed. Existing production rows are untouched.
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
    await pool.query(sql).catch((err) => logger.warn('migration.warn', { label: 'entity col', error: err.message }));
  }

  // Add FK constraint separately (safe if already exists)
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE entities ADD CONSTRAINT entities_parent_id_fkey
        FOREIGN KEY (parent_id) REFERENCES entities(id) ON DELETE SET NULL;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;
  `).catch((err) => logger.warn('migration.warn', { label: 'entity FK', error: err.message }));

  // Seed entity types for existing entities (idempotent)
  await pool.query(`
    UPDATE entities SET type = 'personal'
    WHERE LOWER(name) IN ('personal', 'home', 'family', 'kids')
      AND (type IS NULL OR type = 'business')
  `).catch(() => {});

  // Founder-specific seed/promotion blocks intentionally removed.
  // seedEntitiesIfEmpty() is now a no-op; user-lyle admin/superadmin
  // promotion is no longer performed in migrations. The existing
  // production user row is untouched — role is whatever is stored in DB.

  // Backfill per-user integration rows for superadmins from env vars
  // (one-time safety net so the cutover doesn't drop alerts for
  // existing operators). Idempotent — never overwrites a configured row.
  // ── user_integrations: add account_email + composite UNIQUE (multi-account) ──
  await pool.query(`ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS account_email TEXT DEFAULT ''`)
    .catch((err) => logger.warn('migration.warn', { label: 'user_integrations.account_email', error: err.message }));
  await pool.query(`UPDATE user_integrations SET account_email = '' WHERE account_email IS NULL`).catch(() => {});
  // SET NOT NULL relies on the preceding backfill; if NULLs remain the
  // schema is broken and we crash boot rather than continue silently.
  await criticalMigration(
    `ALTER TABLE user_integrations ALTER COLUMN account_email SET NOT NULL`,
    'user_integrations.account_email.notNull',
  );
  await pool.query(`ALTER TABLE user_integrations ALTER COLUMN account_email SET DEFAULT ''`).catch(() => {});
  await pool.query(`ALTER TABLE user_integrations DROP CONSTRAINT IF EXISTS user_integrations_user_id_integration_type_key`).catch(() => {});
  // Pre-check via pg_catalog — the older EXCEPTION-based guard only
  // caught `duplicate_object`, not `duplicate_table` which Postgres
  // raises when the constraint's backing index name already exists.
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'user_integrations_user_id_type_email_key'
      ) THEN
        ALTER TABLE user_integrations
          ADD CONSTRAINT user_integrations_user_id_type_email_key
          UNIQUE (user_id, integration_type, account_email);
      END IF;
    END $$;
  `).catch((err) => logger.warn('migration.warn', { label: 'user_integrations UNIQUE', error: err.message }));

  // ── user_integrations: provider column (for future multi-provider routing) ──
  await pool.query(`ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'google'`)
    .catch((err) => logger.warn('migration.warn', { label: 'user_integrations.provider', error: err.message }));
  // Explicit backfill — no-op under the default but makes intent clear.
  await pool.query(`UPDATE user_integrations SET provider = 'google' WHERE integration_type = 'gmail' AND provider = 'google'`).catch(() => {});

  // ── Drop legacy gmail_tokens table (tokens now live in user_integrations) ──
  // Any rows were copied into user_integrations by a prior deploy's migration.
  await pool.query(`DROP TABLE IF EXISTS gmail_tokens`).catch((err) =>
    logger.warn('migration.warn', { label: 'drop gmail_tokens', error: err.message }),
  );

  await backfillSuperadminIntegrationsFromEnv()
    .catch((err) => logger.warn('migration.warn', { label: 'backfill integrations', error: err.message }));

  // Backfill per-user settings (apiKeys, alertRules) for superadmins from
  // the legacy global `settings` table. Safe to run repeatedly — never
  // overwrites a per-user row the user has already written.
  await backfillSuperadminSettingsFromGlobal()
    .catch((err) => logger.warn('migration.warn', { label: 'backfill user_settings', error: err.message }));

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

  // Perf indexes flagged by the deep-dive DB review:
  //   - inbox_items(user_id, source_id) — supports the per-scan dedup
  //     check used by gmail/outlook scanners (was sequential-scanning).
  //   - tasks USING gin(tags) — supports the `tags ?| $2` predicate in
  //     getTasksForUser; without it, shared-task lookups scan the table.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_inbox_items_user_source ON inbox_items(user_id, source_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tasks_tags_gin ON tasks USING gin(tags)`).catch(() => {});

  // 8. Add conversation_id column to chat_messages (idempotent)
  await pool.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS conversation_id INTEGER`).catch(() => {});

  // 9. Add type column to chat_conversations (command_center, general, etc.)
  await pool.query(`ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'general'`).catch(() => {});

  // 10. Add missing indexes on frequently queried user_id columns
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_inbox_items_user_id ON inbox_items(user_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_alerts_user_id ON scheduled_alerts(user_id)`).catch(() => {});

  // ── user_email_labels (Inbox V2 — Gmail labels + Outlook folders) ──────
  // Synced from each provider on every scan tick. Semantic_category is
  // populated by labelMapper.cjs via a single Haiku call (Redis-debounced).
  // Aria reads from this to reference labels by name in conversation.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_email_labels (
      id                SERIAL PRIMARY KEY,
      user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_email     TEXT NOT NULL,
      provider          TEXT NOT NULL CHECK (provider IN ('gmail','outlook')),
      label_id          TEXT NOT NULL,
      label_name        TEXT NOT NULL,
      semantic_category TEXT,
      message_count     INT DEFAULT 0,
      last_seen_at      TIMESTAMPTZ,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, account_email, label_id)
    )
  `).catch((err) => logger.warn('migration.warn', { label: 'user_email_labels table', error: err.message }));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_email_labels_user ON user_email_labels(user_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_email_labels_unmapped ON user_email_labels(user_id) WHERE semantic_category IS NULL`).catch(() => {});

  // ── email_filing_patterns (Inbox V2 Phase 2 — behavioral learning) ─────
  // Tracks when a user files emails matching the same predicate so Aria
  // can suggest automation at confidence ≥ 0.8 (3+ applications).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_filing_patterns (
      id                SERIAL PRIMARY KEY,
      user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_email     TEXT NOT NULL,
      match_type        TEXT NOT NULL CHECK (match_type IN ('sender','domain','subject')),
      match_value       TEXT NOT NULL,
      target_label_id   TEXT NOT NULL,
      target_label_name TEXT NOT NULL,
      confidence        FLOAT DEFAULT 0.5,
      times_applied     INT DEFAULT 1,
      last_applied_at   TIMESTAMPTZ DEFAULT NOW(),
      user_approved     BOOLEAN DEFAULT FALSE,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, account_email, match_type, match_value)
    )
  `).catch((err) => logger.warn('migration.warn', { label: 'email_filing_patterns table', error: err.message }));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_filing_patterns_user ON email_filing_patterns(user_id)`).catch(() => {});

  // ── Aria Intelligence System (Phase 0) ───────────────────────────────────
  // Five tables underpinning the deterministic decision engine + learning
  // loop. All scoped by user_id with ON DELETE CASCADE so user deletion
  // wipes the full intelligence trail. decision_log is append-only —
  // updateDecisionOutcome is the only mutation path and only flips
  // `outcome`. correction_events.decision_log_id and generated_rule_id use
  // ON DELETE SET NULL so the audit trail survives source-row archival.

  // 1. behavior_rules — explicit + inferred rules with strength + decay.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS behavior_rules (
      id                   SERIAL PRIMARY KEY,
      user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rule_type            TEXT NOT NULL CHECK (rule_type IN ('preference','constraint','pattern','schedule')),
      trigger_context      TEXT,
      rule_text            TEXT NOT NULL,
      source               TEXT NOT NULL CHECK (source IN ('explicit','inferred')),
      strength             FLOAT NOT NULL DEFAULT 0.5,
      times_reinforced     INT DEFAULT 0,
      times_violated       INT DEFAULT 0,
      last_reinforced_at   TIMESTAMPTZ,
      last_violated_at     TIMESTAMPTZ,
      is_active            BOOLEAN DEFAULT TRUE,
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      updated_at           TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch((err) => logger.warn('migration.warn', { label: 'behavior_rules table', error: err.message }));
  await pool.query(`CREATE INDEX IF NOT EXISTS behavior_rules_user_active_idx ON behavior_rules(user_id, is_active, strength DESC)`).catch(() => {});
  // Phase 1 axes layered on top of the Phase 0 schema. Nullable so existing
  // rows + Phase 0 helpers (upsertBehaviorRule etc.) keep working unchanged.
  // category: filter dimension (tasks|calendar|email|communication|general)
  // preference_type: polarity axis (always|never|ask_first|prefer|avoid)
  // removed_reason: audit string captured by removeUserPreference
  await pool.query(`ALTER TABLE behavior_rules ADD COLUMN IF NOT EXISTS category TEXT`)
    .catch((err) => logger.warn('migration.warn', { label: 'behavior_rules.category', error: err.message }));
  await pool.query(`ALTER TABLE behavior_rules ADD COLUMN IF NOT EXISTS preference_type TEXT`)
    .catch((err) => logger.warn('migration.warn', { label: 'behavior_rules.preference_type', error: err.message }));
  await pool.query(`ALTER TABLE behavior_rules ADD COLUMN IF NOT EXISTS removed_reason TEXT`)
    .catch((err) => logger.warn('migration.warn', { label: 'behavior_rules.removed_reason', error: err.message }));
  // Phase 2 — pattern inference axes. context_data is JSONB structured
  // pattern context (sender, hour buckets, entity ids); trigger_context
  // (Phase 0) stays for free-form scope. signal_count is the
  // automatic-observation counter, distinct from times_reinforced
  // (which counts explicit user confirms in Phase 4).
  // last_reinforced (per spec) intentionally not added — reuses existing
  // last_reinforced_at column.
  await pool.query(`ALTER TABLE behavior_rules ADD COLUMN IF NOT EXISTS pattern_type TEXT`)
    .catch((err) => logger.warn('migration.warn', { label: 'behavior_rules.pattern_type', error: err.message }));
  await pool.query(`ALTER TABLE behavior_rules ADD COLUMN IF NOT EXISTS context_data JSONB`)
    .catch((err) => logger.warn('migration.warn', { label: 'behavior_rules.context_data', error: err.message }));
  await pool.query(`ALTER TABLE behavior_rules ADD COLUMN IF NOT EXISTS signal_count INT DEFAULT 1`)
    .catch((err) => logger.warn('migration.warn', { label: 'behavior_rules.signal_count', error: err.message }));

  // 2. user_preferences_v2 — explicit key-value preference store. _v2
  // namespace because the legacy user_preferences serves DND/cadence.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_preferences_v2 (
      id                  SERIAL PRIMARY KEY,
      user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      preference_key      TEXT NOT NULL,
      preference_value    JSONB NOT NULL,
      source              TEXT NOT NULL CHECK (source IN ('explicit','inferred')),
      confidence          FLOAT DEFAULT 1.0,
      last_confirmed_at   TIMESTAMPTZ,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, preference_key)
    )
  `).catch((err) => logger.warn('migration.warn', { label: 'user_preferences_v2 table', error: err.message }));
  await pool.query(`CREATE INDEX IF NOT EXISTS user_preferences_v2_user_idx ON user_preferences_v2(user_id)`).catch(() => {});

  // 3. decision_log — append-only audit trail of every action evaluation.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS decision_log (
      id                  SERIAL PRIMARY KEY,
      user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action_type         TEXT NOT NULL,
      tool_called         TEXT,
      tool_input          JSONB,
      confidence_score    FLOAT,
      risk_score          FLOAT,
      disposition         TEXT NOT NULL CHECK (disposition IN ('auto_allowed','confirm_required','suggest_only')),
      outcome             TEXT CHECK (outcome IN ('executed','confirmed','rejected','corrected','timeout')),
      rule_ids_applied    INT[],
      conflict_detected   BOOLEAN DEFAULT FALSE,
      conflict_resolution TEXT,
      correction_id       INT,
      context_summary     TEXT,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch((err) => logger.warn('migration.warn', { label: 'decision_log table', error: err.message }));
  await pool.query(`CREATE INDEX IF NOT EXISTS decision_log_user_idx ON decision_log(user_id, created_at DESC)`).catch(() => {});
  // Phase 3 telemetry — wallclock for the 300ms budget + queryable
  // conflict-level tier. Both nullable so historical rows stay valid.
  await pool.query(`ALTER TABLE decision_log ADD COLUMN IF NOT EXISTS latency_ms INT`)
    .catch((err) => logger.warn('migration.warn', { label: 'decision_log.latency_ms', error: err.message }));
  await pool.query(`ALTER TABLE decision_log ADD COLUMN IF NOT EXISTS conflict_level TEXT`)
    .catch((err) => logger.warn('migration.warn', { label: 'decision_log.conflict_level', error: err.message }));

  // 4. trust_scores — per-(user, action_type) trust state driving disposition.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trust_scores (
      id                    SERIAL PRIMARY KEY,
      user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action_type           TEXT NOT NULL,
      trust_score           FLOAT NOT NULL DEFAULT 0.5,
      disposition           TEXT NOT NULL CHECK (disposition IN ('auto_allowed','confirm_required','suggest_only')),
      is_reversible         BOOLEAN NOT NULL,
      impact_level          TEXT NOT NULL CHECK (impact_level IN ('low','medium','high')),
      times_auto_executed   INT DEFAULT 0,
      times_confirmed       INT DEFAULT 0,
      times_rejected        INT DEFAULT 0,
      times_corrected       INT DEFAULT 0,
      created_at            TIMESTAMPTZ DEFAULT NOW(),
      updated_at            TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, action_type)
    )
  `).catch((err) => logger.warn('migration.warn', { label: 'trust_scores table', error: err.message }));
  await pool.query(`CREATE INDEX IF NOT EXISTS trust_scores_user_idx ON trust_scores(user_id)`).catch(() => {});

  // 5. correction_events — when the user countermands an Aria action.
  // FKs to decision_log + behavior_rules use ON DELETE SET NULL so the
  // audit row survives if the source rule/decision is later archived.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS correction_events (
      id                       SERIAL PRIMARY KEY,
      user_id                  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      decision_log_id          INT REFERENCES decision_log(id) ON DELETE SET NULL,
      original_action          TEXT NOT NULL,
      original_tool_input      JSONB,
      correction_type          TEXT NOT NULL CHECK (correction_type IN ('reversed','modified','rejected','flagged')),
      corrected_input          JSONB,
      correction_note          TEXT,
      inferred_rule_violation  TEXT,
      generated_rule_id        INT REFERENCES behavior_rules(id) ON DELETE SET NULL,
      trust_score_adjusted     BOOLEAN DEFAULT FALSE,
      created_at               TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch((err) => logger.warn('migration.warn', { label: 'correction_events table', error: err.message }));
  await pool.query(`CREATE INDEX IF NOT EXISTS correction_events_user_idx ON correction_events(user_id, created_at DESC)`).catch(() => {});

  // Morning brief idempotency lock. Scoped to the morning-brief:* key
  // prefix so the index can be added safely even if other alert_keys
  // carry duplicates elsewhere in the table.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS scheduled_alerts_morning_brief_unique
      ON scheduled_alerts(user_id, alert_key)
      WHERE alert_key LIKE 'morning-brief:%'
  `).catch((err) => logger.warn('migration.warn', { label: 'scheduled_alerts morning-brief unique index', error: err.message }));

  // Daily Wrap: two idempotency axes — push channel cron + web-login nudge.
  // Both reuse the scheduled_alerts idempotency pattern via partial unique
  // indexes so we never fire twice for the same (user, local date).
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS scheduled_alerts_daily_wrap_unique
      ON scheduled_alerts(user_id, alert_key)
      WHERE alert_key LIKE 'daily-wrap:%'
  `).catch((err) => logger.warn('migration.warn', { label: 'scheduled_alerts daily-wrap unique index', error: err.message }));
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS scheduled_alerts_daily_wrap_web_unique
      ON scheduled_alerts(user_id, alert_key)
      WHERE alert_key LIKE 'daily-wrap-web:%'
  `).catch((err) => logger.warn('migration.warn', { label: 'scheduled_alerts daily-wrap-web unique index', error: err.message }));

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
    logger.warn('migration.warn', { label: 'gcal_tokens PK check/migration', error: err.message });
  }

  // Ensure google_email is NOT NULL even if PK migration was already done.
  // The PK migration above already backfilled NULLs to 'primary@placeholder';
  // if any NULLs remain here, the table is in an unexpected state — crash.
  await criticalMigration(
    `ALTER TABLE gcal_tokens ALTER COLUMN google_email SET NOT NULL`,
    'gcal_tokens.google_email.notNull',
  );

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
  `).catch((err) => logger.warn('migration.warn', { label: 'audit_log table', error: err.message }));
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
  `).catch((err) => logger.warn('migration.warn', { label: 'whatsapp_conversations table', error: err.message }));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_whatsapp_conv_phone ON whatsapp_conversations(phone, created_at DESC)`).catch(() => {});

  // ── entity calendar mapping columns ─────────────────────────────────────
  await pool.query(`ALTER TABLE entities ADD COLUMN IF NOT EXISTS calendar_id TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE entities ADD COLUMN IF NOT EXISTS color_source TEXT DEFAULT 'system'`).catch(() => {});

  // ── entity membership Phase 1 ──────────────────────────────────────────
  // Schema only; no route changes yet. Call sites continue to use
  // getEntitiesForUser until Phase 2 swaps them to the canonical access
  // helper.
  await pool.query(`
    ALTER TABLE entities
      ADD COLUMN IF NOT EXISTS visibility TEXT
      NOT NULL DEFAULT 'private'
      CHECK (visibility IN ('private', 'org', 'members'))
  `).catch((err) => logger.warn('migration.warn', { label: 'entities.visibility', error: err.message }));

  await pool.query(`
    ALTER TABLE entities
      ADD COLUMN IF NOT EXISTS org_id TEXT
      REFERENCES organizations(id) ON DELETE SET NULL
  `).catch((err) => logger.warn('migration.warn', { label: 'entities.org_id', error: err.message }));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS entity_members (
      id          SERIAL PRIMARY KEY,
      entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role        TEXT NOT NULL DEFAULT 'editor'
                  CHECK (role IN ('owner', 'editor', 'viewer')),
      invited_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(entity_id, user_id)
    )
  `).catch((err) => logger.warn('migration.warn', { label: 'entity_members table', error: err.message }));
  await pool.query(`CREATE INDEX IF NOT EXISTS entity_members_user_id ON entity_members(user_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS entity_members_entity_id ON entity_members(entity_id)`).catch(() => {});

  // Backfill: shared=true entities become visibility='org' (membership-free
  // org-wide visibility). Only touches rows that are still at the private
  // default so re-runs are no-ops.
  await pool.query(`
    UPDATE entities SET visibility = 'org'
    WHERE shared = TRUE AND visibility = 'private'
  `).catch((err) => logger.warn('migration.warn', { label: 'entities.visibility backfill', error: err.message }));

  // Backfill: creator is always a member (role=owner) of their own entity.
  // ON CONFLICT DO NOTHING makes this idempotent.
  await pool.query(`
    INSERT INTO entity_members (entity_id, user_id, role)
    SELECT id, created_by, 'owner'
    FROM entities
    WHERE created_by IS NOT NULL
    ON CONFLICT (entity_id, user_id) DO NOTHING
  `).catch((err) => logger.warn('migration.warn', { label: 'entity_members creator backfill', error: err.message }));

  // Second pass: entities with created_by IS NULL (pre-migration/seed era).
  // Only assign an owner when there is exactly one user whose entity_ids
  // JSONB array contains the entity id — ambiguous cases are left with
  // no owner rather than guessing (safer: they stay visible only via the
  // org-visibility path or explicit future member rows).
  await pool.query(`
    INSERT INTO entity_members (entity_id, user_id, role)
    SELECT e.id,
           (SELECT u.id FROM users u WHERE u.entity_ids::jsonb ? e.id LIMIT 1),
           'owner'
    FROM entities e
    WHERE e.created_by IS NULL
      AND (SELECT COUNT(*) FROM users u WHERE u.entity_ids::jsonb ? e.id) = 1
    ON CONFLICT (entity_id, user_id) DO NOTHING
  `).catch((err) => logger.warn('migration.warn', { label: 'entity_members null-created_by backfill', error: err.message }));

  // ── calendar_events cache (Session 1) ──────────────────────────────────
  // Local mirror of each user's GCal events so dashboard / brief / context
  // reads avoid per-request Google API calls. Populated by the 15-min sync
  // cron in proxy-server.cjs. No call sites swap to it yet — that comes in
  // a follow-up session.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS calendar_events (
      id            TEXT NOT NULL,
      user_id       TEXT NOT NULL,
      account_email TEXT NOT NULL,
      title         TEXT,
      start_time    TIMESTAMPTZ,
      end_time      TIMESTAMPTZ,
      all_day       BOOLEAN DEFAULT FALSE,
      location      TEXT,
      description   TEXT,
      entity_id     TEXT,
      synced_at     TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, account_email, id)
    )
  `).catch((err) => logger.warn('migration.warn', { label: 'calendar_events table', error: err.message }));
  await pool.query(`
    CREATE INDEX IF NOT EXISTS calendar_events_user_start
    ON calendar_events(user_id, start_time)
  `).catch(() => {});

  // ── Outcome Intelligence Phase 1 — schema only ──────────────────────────
  // See docs/aria-outcome-intelligence-system.md.
  // completion_note already exists (line ~118); the other three are new.
  await pool.query(`
    ALTER TABLE tasks
      ADD COLUMN IF NOT EXISTS completion_note TEXT,
      ADD COLUMN IF NOT EXISTS completion_status TEXT
        CHECK (completion_status IN (
          'success','mixed','neutral','failed','cancelled','no_show'
        )),
      ADD COLUMN IF NOT EXISTS follow_up_needed BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS follow_up_by TIMESTAMPTZ
  `).catch((err) => logger.warn('migration.warn', { label: 'tasks.outcome cols', error: err.message }));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS outcome_records (
      id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source_type     TEXT NOT NULL CHECK (source_type IN ('task','event')),
      source_id       TEXT NOT NULL,
      completed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      title_snapshot  TEXT,
      raw_note        TEXT,
      outcome_status  TEXT CHECK (outcome_status IN (
                        'success','mixed','neutral','failed','cancelled','no_show'
                      )),
      follow_up_needed BOOLEAN DEFAULT FALSE,
      follow_up_by    TIMESTAMPTZ,
      entered_by      TEXT DEFAULT 'user'
                      CHECK (entered_by IN ('user','assistant','system','staff')),
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch((err) => logger.warn('migration.warn', { label: 'outcome_records table', error: err.message }));
  await pool.query(`CREATE INDEX IF NOT EXISTS outcome_records_user_id ON outcome_records(user_id, completed_at DESC)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS outcome_records_source  ON outcome_records(source_type, source_id)`).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS outcome_entities (
      id          SERIAL PRIMARY KEY,
      outcome_id  TEXT NOT NULL REFERENCES outcome_records(id) ON DELETE CASCADE,
      entity_id   TEXT REFERENCES entities(id) ON DELETE SET NULL,
      entity_type TEXT,
      role        TEXT,
      confidence  NUMERIC(3,2),
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch((err) => logger.warn('migration.warn', { label: 'outcome_entities table', error: err.message }));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS outcome_signals (
      id              SERIAL PRIMARY KEY,
      outcome_id      TEXT NOT NULL REFERENCES outcome_records(id) ON DELETE CASCADE,
      signal_name     TEXT NOT NULL,
      signal_value    JSONB,
      confidence      NUMERIC(3,2),
      model_name      TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch((err) => logger.warn('migration.warn', { label: 'outcome_signals table', error: err.message }));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory_facts (
      id               SERIAL PRIMARY KEY,
      user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      entity_id        TEXT REFERENCES entities(id) ON DELETE SET NULL,
      fact_text        TEXT NOT NULL,
      fact_type        TEXT,
      supporting_count INTEGER DEFAULT 1,
      strength_score   NUMERIC(3,2) DEFAULT 0.5,
      first_seen_at    TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch((err) => logger.warn('migration.warn', { label: 'memory_facts table', error: err.message }));
  await pool.query(`CREATE INDEX IF NOT EXISTS memory_facts_user_id ON memory_facts(user_id, strength_score DESC)`).catch(() => {});
  // Unique index required by upsertMemoryFact's ON CONFLICT (user_id, fact_text).
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS memory_facts_user_fact_unique ON memory_facts(user_id, fact_text)`).catch((err) => logger.warn('migration.warn', { label: 'memory_facts unique', error: err.message }));

  // ── People Memory + Shared Access V1 ────────────────────────────────────
  // Schema for contacts, identities, shared access grants, and connections.
  // See docs/shared-access-and-people-memory-v1.md (TBD).
  //
  // memory_facts is extended with a nullable contact_id column so a single
  // table carries both global (contact_id IS NULL) and person-scoped
  // (contact_id IS NOT NULL) facts. The historical unique index is
  // RESHAPED as a partial index so the two axes can coexist (a fact_text
  // can exist once globally AND once per contact for the same user).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      display_name   TEXT NOT NULL,
      primary_email  TEXT,
      primary_phone  TEXT,
      company        TEXT,
      role           TEXT,
      notes          TEXT,
      linked_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      source         TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch((err) => logger.warn('migration.warn', { label: 'contacts table', error: err.message }));
  await pool.query(`CREATE INDEX IF NOT EXISTS contacts_user_id_idx ON contacts(user_id)`).catch(() => {});
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS contacts_user_email_unique
    ON contacts (user_id, LOWER(primary_email))
    WHERE primary_email IS NOT NULL
  `).catch((err) => logger.warn('migration.warn', { label: 'contacts unique email', error: err.message }));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS contact_identities (
      id          SERIAL PRIMARY KEY,
      contact_id  TEXT REFERENCES contacts(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,
      value       TEXT NOT NULL,
      verified    BOOLEAN DEFAULT FALSE,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch((err) => logger.warn('migration.warn', { label: 'contact_identities table', error: err.message }));
  await pool.query(`CREATE INDEX IF NOT EXISTS contact_identities_value_idx ON contact_identities (LOWER(value))`).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shared_access_grants (
      id                   SERIAL PRIMARY KEY,
      grantor_user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      grantee_user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scope                TEXT NOT NULL,
      resource_filter_json JSONB,
      expires_at           TIMESTAMPTZ,
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      revoked_at           TIMESTAMPTZ
    )
  `).catch((err) => logger.warn('migration.warn', { label: 'shared_access_grants table', error: err.message }));
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS shared_access_grants_active_unique
    ON shared_access_grants (grantor_user_id, grantee_user_id, scope)
    WHERE revoked_at IS NULL
  `).catch((err) => logger.warn('migration.warn', { label: 'shared_access_grants unique', error: err.message }));
  await pool.query(`
    CREATE INDEX IF NOT EXISTS shared_access_grants_grantee_idx
    ON shared_access_grants (grantee_user_id)
    WHERE revoked_at IS NULL
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS connections (
      id              SERIAL PRIMARY KEY,
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      peer_user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
      peer_contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE,
      relationship    TEXT,
      status          TEXT NOT NULL DEFAULT 'pending',
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      accepted_at     TIMESTAMPTZ
    )
  `).catch((err) => logger.warn('migration.warn', { label: 'connections table', error: err.message }));
  await pool.query(`CREATE INDEX IF NOT EXISTS connections_user_id_idx ON connections(user_id)`).catch(() => {});
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS connections_user_peer_user_unique
    ON connections (user_id, peer_user_id)
    WHERE peer_user_id IS NOT NULL
  `).catch((err) => logger.warn('migration.warn', { label: 'connections peer_user unique', error: err.message }));
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS connections_user_peer_contact_unique
    ON connections (user_id, peer_contact_id)
    WHERE peer_contact_id IS NOT NULL
  `).catch((err) => logger.warn('migration.warn', { label: 'connections peer_contact unique', error: err.message }));

  // memory_facts: add contact_id, reshape the existing unique index to be
  // partial so global and contact-scoped facts coexist without collision.
  await pool.query(`ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE`)
    .catch((err) => logger.warn('migration.warn', { label: 'memory_facts.contact_id', error: err.message }));
  await pool.query(`CREATE INDEX IF NOT EXISTS memory_facts_contact_id_idx ON memory_facts(contact_id) WHERE contact_id IS NOT NULL`).catch(() => {});
  // Reshape: drop the non-partial global unique so global + per-contact can
  // both hold the same fact_text. Recreate as a partial index on NULL rows.
  // upsertMemoryFact is updated in this commit to match the new partial
  // predicate on its ON CONFLICT clause. No-op on fresh DBs.
  await pool.query(`DROP INDEX IF EXISTS memory_facts_user_fact_unique`)
    .catch((err) => logger.warn('migration.warn', { label: 'drop memory_facts_user_fact_unique', error: err.message }));
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS memory_facts_user_fact_unique
    ON memory_facts (user_id, fact_text)
    WHERE contact_id IS NULL
  `).catch((err) => logger.warn('migration.warn', { label: 'memory_facts global unique (partial)', error: err.message }));
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS memory_facts_contact_scoped_unique
    ON memory_facts (user_id, contact_id, fact_text)
    WHERE contact_id IS NOT NULL
  `).catch((err) => logger.warn('migration.warn', { label: 'memory_facts contact-scoped unique', error: err.message }));

  // ── Daily Wrap + Ambient Capture V1 ────────────────────────────────────
  // journal_entries: one row per user per local day. UPSERT on
  // (user_id, entry_date); completed_at distinguishes a finished wrap
  // from a work-in-progress draft.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS journal_entries (
      id              SERIAL PRIMARY KEY,
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      entry_date      DATE NOT NULL,
      wins            TEXT,
      frustrations    TEXT,
      tomorrow_focus  TEXT,
      raw_freeform    TEXT,
      completed_at    TIMESTAMPTZ,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch((err) => logger.warn('migration.warn', { label: 'journal_entries table', error: err.message }));
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_user_date_unique
    ON journal_entries (user_id, entry_date)
  `).catch((err) => logger.warn('migration.warn', { label: 'journal_entries unique', error: err.message }));
  await pool.query(`CREATE INDEX IF NOT EXISTS journal_entries_user_idx ON journal_entries (user_id, entry_date DESC)`).catch(() => {});

  // pending_close_loop: event-driven queue of "we should ask about X"
  // items. Written from task/event/project complete paths; read by
  // /api/brief/context to populate the active-zone tile queue.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_close_loop (
      id              SERIAL PRIMARY KEY,
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source_type     TEXT NOT NULL CHECK (source_type IN ('task','event','project_task')),
      source_id       TEXT NOT NULL,
      title_snapshot  TEXT,
      triggered_at    TIMESTAMPTZ DEFAULT NOW(),
      dismissed_at    TIMESTAMPTZ,
      resolved_at     TIMESTAMPTZ
    )
  `).catch((err) => logger.warn('migration.warn', { label: 'pending_close_loop table', error: err.message }));
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS pending_close_loop_unique
    ON pending_close_loop (user_id, source_type, source_id)
  `).catch((err) => logger.warn('migration.warn', { label: 'pending_close_loop unique', error: err.message }));
  // Hot path: open items per user, sorted by recency.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS pending_close_loop_open_idx
    ON pending_close_loop (user_id, triggered_at DESC)
    WHERE resolved_at IS NULL
  `).catch(() => {});

  // user_preferences: wrap_time HH:MM string. NULL disables the feature.
  await pool.query(`ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS wrap_time TEXT DEFAULT NULL`)
    .catch((err) => logger.warn('migration.warn', { label: 'user_preferences.wrap_time', error: err.message }));

  // ── Entity Workspace Projects V1 ────────────────────────────────────────
  // See docs/dizon-entity-workspace-spec-v1.md. Membership enforcement
  // lives at the route layer via canAccessEntity; SQL helpers stay
  // entity_id-scoped only.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      entity_id    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      title        TEXT NOT NULL,
      description  TEXT,
      status       TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','completed','archived')),
      created_by   TEXT NOT NULL REFERENCES users(id),
      completed_at TIMESTAMPTZ,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch((err) => logger.warn('migration.warn', { label: 'projects table', error: err.message }));
  await pool.query(`CREATE INDEX IF NOT EXISTS projects_entity_id  ON projects(entity_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS projects_created_by ON projects(created_by)`).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_tasks (
      id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      entity_id    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      title        TEXT NOT NULL,
      description  TEXT,
      status       TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','completed','cancelled')),
      created_by   TEXT NOT NULL REFERENCES users(id),
      completed_at TIMESTAMPTZ,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch((err) => logger.warn('migration.warn', { label: 'project_tasks table', error: err.message }));
  await pool.query(`CREATE INDEX IF NOT EXISTS project_tasks_project_id ON project_tasks(project_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS project_tasks_entity_id  ON project_tasks(entity_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS project_tasks_created_by ON project_tasks(created_by)`).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_checklist_items (
      id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      task_id      TEXT NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
      entity_id    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      text         TEXT NOT NULL,
      is_done      BOOLEAN DEFAULT FALSE,
      created_by   TEXT NOT NULL REFERENCES users(id),
      completed_at TIMESTAMPTZ,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch((err) => logger.warn('migration.warn', { label: 'task_checklist_items table', error: err.message }));
  await pool.query(`CREATE INDEX IF NOT EXISTS task_checklist_items_task_id    ON task_checklist_items(task_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS task_checklist_items_entity_id  ON task_checklist_items(entity_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS task_checklist_items_created_by ON task_checklist_items(created_by)`).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_notes (
      id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      project_id   TEXT REFERENCES projects(id) ON DELETE CASCADE,
      task_id      TEXT REFERENCES project_tasks(id) ON DELETE CASCADE,
      entity_id    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      body         TEXT NOT NULL,
      created_by   TEXT NOT NULL REFERENCES users(id),
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch((err) => logger.warn('migration.warn', { label: 'project_notes table', error: err.message }));
  await pool.query(`CREATE INDEX IF NOT EXISTS project_notes_project_id ON project_notes(project_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS project_notes_task_id    ON project_notes(task_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS project_notes_entity_id  ON project_notes(entity_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS project_notes_created_by ON project_notes(created_by)`).catch(() => {});

  // ── Inbox flagged state (email persistence) ──────────────────────────────
  await pool.query(`ALTER TABLE inbox_items ADD COLUMN IF NOT EXISTS flagged_at TIMESTAMPTZ`).catch(() => {});
  await pool.query(`ALTER TABLE inbox_items ADD COLUMN IF NOT EXISTS flagged_reason TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE inbox_items ADD COLUMN IF NOT EXISTS flagged_acked_at TIMESTAMPTZ`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_inbox_items_flagged ON inbox_items(user_id, flagged_at DESC) WHERE flagged_at IS NOT NULL`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_inbox_items_flagged_unacked ON inbox_items(user_id, flagged_at DESC) WHERE flagged_at IS NOT NULL AND flagged_acked_at IS NULL`).catch(() => {});

  // ── Task/note source email linking ───────────────────────────────────────
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source_email_id TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source_email_subject TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source_email_sender TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE notes ADD COLUMN IF NOT EXISTS source_email_id TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE notes ADD COLUMN IF NOT EXISTS source_email_subject TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE notes ADD COLUMN IF NOT EXISTS source_email_sender TEXT`).catch(() => {});

  // ── Classification feedback loop ──────────────────────────────────────────
  await pool.query(`CREATE TABLE IF NOT EXISTS classification_feedback (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    inbox_item_id TEXT REFERENCES inbox_items(id) ON DELETE SET NULL,
    message_id TEXT,
    feedback_type TEXT NOT NULL CHECK (feedback_type IN ('thumbs_up', 'thumbs_down')),
    classification_snapshot JSONB,
    correction_dimensions JSONB,
    sender_email TEXT,
    sender_domain TEXT,
    subject_snippet TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cf_user_domain ON classification_feedback(user_id, sender_domain)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cf_user_type_created ON classification_feedback(user_id, feedback_type, created_at DESC)`).catch(() => {});

  // Classification reasoning — persisted by the classifier on every call
  await pool.query(`ALTER TABLE email_classifications ADD COLUMN IF NOT EXISTS classification_reasoning JSONB`).catch(() => {});

  // Inferred classification rules — auto-generated from 2+ same-pattern corrections
  await pool.query(`CREATE TABLE IF NOT EXISTS inferred_classification_rules (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pattern_type TEXT NOT NULL CHECK (pattern_type IN ('sender_email', 'sender_domain', 'subject_pattern')),
    pattern_value TEXT NOT NULL,
    suppress_dimension TEXT NOT NULL,
    strength FLOAT DEFAULT 0.3,
    signal_count INT DEFAULT 1,
    last_reinforced_at TIMESTAMPTZ DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, pattern_type, pattern_value, suppress_dimension)
  )`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_icr_user_active ON inferred_classification_rules(user_id, is_active) WHERE is_active = TRUE`).catch(() => {});
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
async function getFinancialAccounts(userId) {
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", name, type, institution, currency,
            entity_id AS "entityId", account_class AS "accountClass", created_at AS "createdAt"
     FROM financial_accounts WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

/**
 * Tenant-scoped lookup for a single financial account. Returns null when
 * the account doesn't exist OR belongs to a different user — callers
 * should treat both as 404 to avoid leaking account-existence info across
 * tenants. Used by the transaction-write paths to verify ownership BEFORE
 * inserting a row tagged with that account_id.
 */
async function getFinancialAccountForUser(accountId, userId) {
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", name, type, institution, currency,
            entity_id AS "entityId", account_class AS "accountClass", created_at AS "createdAt"
     FROM financial_accounts WHERE id = $1 AND user_id = $2`,
    [accountId, userId],
  );
  return rows[0] || null;
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
async function updateFinancialAccount(id, fields, userId) {
  if (!userId) throw new Error('updateFinancialAccount requires userId');
  const sets = [];
  const vals = [id, userId];
  let idx = 3;
  if (fields.name !== undefined) { sets.push(`name = $${idx++}`); vals.push(fields.name); }
  if (fields.type !== undefined) { sets.push(`type = $${idx++}`); vals.push(fields.type); }
  if (fields.institution !== undefined) { sets.push(`institution = $${idx++}`); vals.push(fields.institution); }
  if (fields.currency !== undefined) { sets.push(`currency = $${idx++}`); vals.push(fields.currency); }
  if (fields.entityId !== undefined) { sets.push(`entity_id = $${idx++}`); vals.push(fields.entityId); }
  if (fields.accountClass !== undefined) { sets.push(`account_class = $${idx++}`); vals.push(fields.accountClass); }
  if (sets.length === 0) return null;
  const { rows } = await pool.query(
    `UPDATE financial_accounts SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2
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
async function deleteFinancialAccount(id, userId) {
  // userId scope on both DELETEs — any future direct caller (Aria tool,
  // bulk cleanup) can't wipe another user's account or its transactions.
  // Wrapped in a transaction so a half-failed delete can't leave the
  // account row alive with its transactions already gone (or vice versa).
  if (!userId) throw new Error('deleteFinancialAccount requires userId');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Scope transactions delete via the parent account's user_id — keeps
    // the existing schema (transactions has its own user_id but joining
    // through account_id makes the tenant relationship explicit).
    await client.query(
      `DELETE FROM transactions
        WHERE account_id = $1
          AND account_id IN (SELECT id FROM financial_accounts WHERE id = $1 AND user_id = $2)`,
      [id, userId],
    );
    const result = await client.query(
      'DELETE FROM financial_accounts WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    await client.query('COMMIT');
    return result.rowCount > 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
async function getTransactions(userId, filters = {}) {
  const where = [];
  const vals = [];
  let idx = 1;

  // Always user-scoped. Admin cross-tenant visibility, if ever needed,
  // lives behind a separate helper gated by requireSuperAdmin.
  where.push(`t.user_id = $${idx++}`);
  vals.push(userId);
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
     FROM transactions t ${whereClause}
     ORDER BY t.date DESC, t.created_at DESC
     LIMIT $${idx}`,
    [...vals, Math.min(parseInt(filters.limit, 10) || 500, 2000)],
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
async function deleteTransaction(id, userId) {
  if (!userId) throw new Error('deleteTransaction requires userId');
  const result = await pool.query('DELETE FROM transactions WHERE id = $1 AND user_id = $2', [id, userId]);
  return result.rowCount > 0;
}

/**
 * Partial-update a transaction. Only fields present in input are SET.
 *
 * @param {string} id - Transaction ID.
 * @param {Object} fields - Fields to update (date, description, amount, type, category, entityId, accountClass, notes).
 * @returns {Promise<Object|null>} Updated row, or null if no fields or not found.
 */
async function updateTransaction(id, fields, userId) {
  if (!userId) throw new Error('updateTransaction requires userId');
  const sets = [];
  const vals = [id, userId];
  let idx = 3;
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
    `UPDATE transactions SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2
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
 * @param {string} userId - Authenticated user ID. Always scoped — cross-
 *   tenant aggregation (if ever needed) belongs behind a separate helper
 *   gated by requireSuperAdmin, not this one.
 * @returns {Promise<Object>} { monthly, balances, topCategories }.
 *
 * @note This is an aggregate query — may become expensive as
 * transaction volume grows. Consider caching or pagination
 * if needed at scale.
 */
async function getFinancialSummary(userId) {
  const vals = [userId];

  const { rows } = await pool.query(
    `SELECT t.entity_id AS "entityId", t.account_class AS "accountClass",
            SUBSTRING(t.date FROM 1 FOR 7) AS month,
            SUM(CASE WHEN t.type = 'credit' THEN t.amount ELSE 0 END)::float AS income,
            SUM(CASE WHEN t.type = 'debit' THEN t.amount ELSE 0 END)::float AS expenses
     FROM transactions t WHERE t.user_id = $1
     GROUP BY t.entity_id, t.account_class, SUBSTRING(t.date FROM 1 FOR 7)
     ORDER BY month DESC`,
    vals,
  );

  // Account balances
  const { rows: balanceRows } = await pool.query(
    `SELECT a.id AS "accountId", a.name, a.type, a.entity_id AS "entityId", a.account_class AS "accountClass",
            COALESCE(SUM(CASE WHEN t.type = 'credit' THEN t.amount ELSE -t.amount END), 0)::float AS balance
     FROM financial_accounts a
     LEFT JOIN transactions t ON t.account_id = a.id
     WHERE a.user_id = $1
     GROUP BY a.id, a.name, a.type, a.entity_id, a.account_class`,
    vals,
  );

  // Top spending categories
  const { rows: categoryRows } = await pool.query(
    `SELECT t.category, SUM(t.amount)::float AS total
     FROM transactions t WHERE t.user_id = $1 AND t.type = 'debit'
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
  if (!tz) tz = user?.timezone || DEFAULT_TIMEZONE;
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
/**
 * Return users who have at least one enabled "morning-brief" rule in
 * their user_settings.alertRules. Reads the canonical per-user alertRules
 * JSON and extracts the brief time ('HH:MM').
 */
async function getUsersWithMorningBriefEnabled() {
  const { rows } = await pool.query(
    `SELECT u.id, u.timezone, u.display_name AS "displayName", u.username,
            s.value_json AS "alertRules"
     FROM users u
     JOIN user_settings s ON s.user_id = u.id AND s.setting_key = 'alertRules'
     WHERE s.value_json IS NOT NULL`
  );
  return rows
    .filter((u) => {
      const rules = Array.isArray(u.alertRules) ? u.alertRules : [];
      return rules.some((r) => r?.condition?.type === 'morning-brief' && r?.enabled !== false);
    })
    .map((u) => {
      const rules = u.alertRules;
      const rule = rules.find((r) => r?.condition?.type === 'morning-brief');
      return {
        id: u.id,
        timezone: u.timezone || DEFAULT_TIMEZONE,
        displayName: u.displayName,
        username: u.username,
        briefTime: rule?.condition?.time || '08:00',
      };
    });
}

/**
 * Atomically claim the right to send today's morning brief for a user.
 * Returns true iff this call is the one that locked it (and should send);
 * false means another run already sent (or locked) for this local-day.
 * Uses a scheduled_alerts row with alert_key 'morning-brief:{userId}:{YYYY-MM-DD}'
 * and relies on a partial unique index scoped to this key prefix.
 */
async function checkAndLockMorningBriefSent(userId, dateKey) {
  const alertKey = `morning-brief:${userId}:${dateKey}`;
  const { rows } = await pool.query(
    `INSERT INTO scheduled_alerts (user_id, alert_key, message, channels, fire_at, fired, fired_at)
     VALUES ($1, $2, 'morning-brief', '[]'::jsonb, NOW(), TRUE, NOW())
     ON CONFLICT (user_id, alert_key)
     WHERE alert_key LIKE 'morning-brief:%'
     DO NOTHING
     RETURNING id`,
    [userId, alertKey]
  );
  // rows.length === 1 → we just locked it, caller should send.
  // rows.length === 0 → another run already locked it, caller should skip.
  return rows.length === 0;
}

/**
 * Users who have an enabled Daily Wrap rule in their alertRules. Mirrors
 * getUsersWithMorningBriefEnabled exactly — only the rule condition type
 * differs. Returned shape: {id, timezone, displayName, username, wrapTime}.
 */
async function getUsersWithDailyWrapEnabled() {
  const { rows } = await pool.query(
    `SELECT u.id, u.timezone, u.display_name AS "displayName", u.username,
            s.value_json AS "alertRules"
     FROM users u
     JOIN user_settings s ON s.user_id = u.id AND s.setting_key = 'alertRules'
     WHERE s.value_json IS NOT NULL`
  );
  return rows
    .filter((u) => {
      const rules = Array.isArray(u.alertRules) ? u.alertRules : [];
      return rules.some((r) => r?.condition?.type === 'daily-wrap' && r?.enabled !== false);
    })
    .map((u) => {
      const rules = u.alertRules;
      const rule = rules.find((r) => r?.condition?.type === 'daily-wrap');
      return {
        id: u.id,
        timezone: u.timezone || DEFAULT_TIMEZONE,
        displayName: u.displayName,
        username: u.username,
        wrapTime: rule?.condition?.time || '18:00',
      };
    });
}

/**
 * Atomically claim the right to send today's Daily Wrap push for a user.
 * Mirrors checkAndLockMorningBriefSent — returns TRUE when already sent,
 * FALSE when we just acquired the claim (caller should send).
 */
async function checkAndLockDailyWrapSent(userId, dateKey) {
  const alertKey = `daily-wrap:${userId}:${dateKey}`;
  const { rows } = await pool.query(
    `INSERT INTO scheduled_alerts (user_id, alert_key, message, channels, fire_at, fired, fired_at)
     VALUES ($1, $2, 'daily-wrap', '[]'::jsonb, NOW(), TRUE, NOW())
     ON CONFLICT (user_id, alert_key)
     WHERE alert_key LIKE 'daily-wrap:%'
     DO NOTHING
     RETURNING id`,
    [userId, alertKey]
  );
  return rows.length === 0;
}

/**
 * Atomically claim the web-side Daily Wrap nudge for a (user, local day).
 * Returns TRUE when a prior claim already exists (caller should suppress
 * the UI prompt), FALSE when we just acquired the claim (caller should
 * fire the nudge — typically by pushing an assistant CC message).
 *
 * Mirrors checkAndLockMorningBriefSent exactly — two-tab safety comes
 * from the partial unique index on `alert_key LIKE 'daily-wrap-web:%'`.
 */
async function checkAndLockDailyWrapWeb(userId, dateKey) {
  const alertKey = `daily-wrap-web:${userId}:${dateKey}`;
  const { rows } = await pool.query(
    `INSERT INTO scheduled_alerts (user_id, alert_key, message, channels, fire_at, fired, fired_at)
     VALUES ($1, $2, 'daily-wrap-web', '[]'::jsonb, NOW(), TRUE, NOW())
     ON CONFLICT (user_id, alert_key)
     WHERE alert_key LIKE 'daily-wrap-web:%'
     DO NOTHING
     RETURNING id`,
    [userId, alertKey]
  );
  return rows.length === 0;
}

/** Max delivery attempts before an alert is dead-lettered (marked fired with
 *  last_error captured) so it stops blocking the cron. Five gives ~5 minutes
 *  of recovery for transient outages without spamming channels indefinitely. */
const SCHEDULED_ALERT_MAX_ATTEMPTS = 5;

async function getUnfiredAlerts() {
  // Per-user DND check: compute each user's local time via AT TIME ZONE.
  //
  // LEFT JOIN tasks (was INNER) so alerts for deleted tasks AND task-less
  // alerts (custom one-off reminders, alert_key without task_id) are still
  // delivered — the prior INNER JOIN silently dropped both classes forever.
  // The completed-task filter still applies when a task row exists.
  //
  // attempts < MAX guards against infinite retry on permanently-failing
  // alerts (no whatsapp configured, no email recipient, etc.); past that,
  // the cron's give-up branch marks them fired with last_error captured.
  const { rows } = await pool.query(
    `SELECT sa.id, sa.user_id, sa.task_id, sa.alert_key, sa.message, sa.channels,
            sa.fire_at, sa.attempts, u.email
     FROM scheduled_alerts sa
     JOIN users u ON u.id = sa.user_id
     LEFT JOIN tasks t ON t.id = sa.task_id
     LEFT JOIN user_preferences up ON up.user_id = sa.user_id
     WHERE sa.fired = FALSE AND sa.fire_at <= NOW()
       AND sa.attempts < $1
       AND (sa.task_id IS NULL OR t.completed = FALSE)
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
     LIMIT 50`,
    [SCHEDULED_ALERT_MAX_ATTEMPTS]
  );
  return rows;
}

/**
 * Mark an alert as fired so it is not returned by getUnfiredAlerts() again.
 * Called by the cron scheduler after successful delivery, OR after the cron
 * has exhausted retries (in which case lastError captures the give-up reason
 * for postmortem visibility).
 *
 * @param {number} alertId - Scheduled alert row ID.
 * @param {string|null} [lastError=null] - Reason for marking fired without
 *   delivery; null on the success path.
 * @returns {Promise<void>}
 */
async function markScheduledAlertFired(alertId, lastError = null) {
  await pool.query(
    `UPDATE scheduled_alerts
        SET fired = TRUE, fired_at = NOW(), last_error = COALESCE($2, last_error)
      WHERE id = $1`,
    [alertId, lastError]
  );
}

/**
 * Bump attempts and capture last_error after a delivery attempt where every
 * configured channel failed. Leaves fired=FALSE so the next cron tick retries
 * (until SCHEDULED_ALERT_MAX_ATTEMPTS is reached and the row drops out of
 * getUnfiredAlerts).
 *
 * @param {number} alertId
 * @param {string} lastError - Comma-joined "Channel:reason" string.
 */
async function incrementAlertAttempt(alertId, lastError) {
  await pool.query(
    `UPDATE scheduled_alerts
        SET attempts = attempts + 1, last_error = $2
      WHERE id = $1`,
    [alertId, lastError]
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

/**
 * Positional-arg helper for saving a post-meeting note. Narrower than
 * upsertCalendarNote (handles post_note only, requires event metadata)
 * — intended for the active-zone meeting notes flow.
 */
async function upsertCalendarNotePost(userId, eventId, eventTitle, eventStart, eventEnd, accountEmail, postNote) {
  const { rows } = await pool.query(
    `INSERT INTO calendar_notes
       (user_id, event_id, event_title, event_start, event_end, source_account, post_note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, event_id)
     DO UPDATE SET
       event_title    = COALESCE(EXCLUDED.event_title,    calendar_notes.event_title),
       event_start    = COALESCE(EXCLUDED.event_start,    calendar_notes.event_start),
       event_end      = COALESCE(EXCLUDED.event_end,      calendar_notes.event_end),
       source_account = COALESCE(EXCLUDED.source_account, calendar_notes.source_account),
       post_note      = EXCLUDED.post_note,
       updated_at     = NOW()
     RETURNING id, user_id AS "userId", event_id AS "eventId", event_title AS "eventTitle",
               event_start AS "eventStart", event_end AS "eventEnd", source_account AS "sourceAccount",
               pre_note AS "preNote", post_note AS "postNote", post_alert_sent AS "postAlertSent",
               created_at AS "createdAt", updated_at AS "updatedAt"`,
    [userId, eventId, eventTitle || null, eventStart || null, eventEnd || null, accountEmail || null, postNote],
  );
  return rows[0];
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
  // JOIN calendar_events so notes created via the Aria tool (which
  // passes null for event_start/title/end) still surface by falling back
  // to canonical event metadata. COALESCE picks note-side values first
  // so legacy rows with their own denormalized copy still work.
  const { rows } = await pool.query(
    `SELECT cn.event_id AS "eventId",
            COALESCE(NULLIF(cn.event_title, ''), ce.title) AS "eventTitle",
            COALESCE(cn.event_start, ce.start_time)        AS "eventStart",
            COALESCE(cn.event_end,   ce.end_time)          AS "eventEnd",
            cn.source_account AS "sourceAccount",
            cn.pre_note  AS "preNote",
            cn.post_note AS "postNote"
     FROM calendar_notes cn
     LEFT JOIN calendar_events ce
       ON ce.id = cn.event_id AND ce.user_id = cn.user_id
     WHERE cn.user_id = $1
       AND (cn.pre_note IS NOT NULL OR cn.post_note IS NOT NULL)
       AND COALESCE(cn.event_start, ce.start_time, NOW()) >= NOW() - INTERVAL '7 days'
       AND COALESCE(cn.event_start, ce.start_time, NOW()) <= NOW() + INTERVAL '7 days'
     ORDER BY COALESCE(cn.event_start, ce.start_time, NOW()) ASC
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

async function getWhatsAppHistory(userId, phone, limit = 6) {
  // Oldest-first so callers can feed directly into the agentic messages array.
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT role, content, created_at AS "createdAt"
       FROM whatsapp_conversations
       WHERE user_id = $1 AND phone = $2
       ORDER BY created_at DESC
       LIMIT $3
     ) sub
     ORDER BY "createdAt" ASC`,
    [userId, phone, limit],
  );
  return rows;
}

async function saveWhatsAppMessage(userId, phone, role, content) {
  await pool.query(
    `INSERT INTO whatsapp_conversations (user_id, phone, role, content)
     VALUES ($1, $2, $3, $4)`,
    [userId, phone, role, content],
  );
}

// ── Entity Workspace Projects helpers (V1) ─────────────────────────────────
// Membership enforcement happens at the route layer via canAccessEntity.
// These helpers are scoped by id / entity_id only.

const PROJECT_FIELDS = `id, entity_id AS "entityId", title, description, status,
  created_by AS "createdBy", completed_at AS "completedAt",
  created_at AS "createdAt", updated_at AS "updatedAt"`;
const TASK_FIELDS = `id, project_id AS "projectId", entity_id AS "entityId",
  title, description, status, created_by AS "createdBy",
  completed_at AS "completedAt", created_at AS "createdAt", updated_at AS "updatedAt"`;
const CHECKLIST_FIELDS = `id, task_id AS "taskId", entity_id AS "entityId",
  text, is_done AS "isDone", created_by AS "createdBy",
  completed_at AS "completedAt", created_at AS "createdAt", updated_at AS "updatedAt"`;
const NOTE_FIELDS = `id, project_id AS "projectId", task_id AS "taskId",
  entity_id AS "entityId", body, created_by AS "createdBy",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

async function listProjectsForEntity(entityId) {
  const { rows } = await pool.query(
    `SELECT ${PROJECT_FIELDS} FROM projects WHERE entity_id = $1 ORDER BY updated_at DESC`,
    [entityId],
  );
  return rows;
}
async function getProjectById(id) {
  const { rows } = await pool.query(`SELECT ${PROJECT_FIELDS} FROM projects WHERE id = $1`, [id]);
  return rows[0] || null;
}
async function createProject({ entityId, title, description, createdBy }) {
  const { rows } = await pool.query(
    `INSERT INTO projects (entity_id, title, description, created_by)
     VALUES ($1, $2, $3, $4) RETURNING ${PROJECT_FIELDS}`,
    [entityId, title, description || null, createdBy],
  );
  return rows[0];
}
async function updateProject(id, fields) {
  const sets = [];
  const vals = [id];
  let idx = 2;
  if (fields.title !== undefined)       { sets.push(`title = $${idx++}`);       vals.push(fields.title); }
  if (fields.description !== undefined) { sets.push(`description = $${idx++}`); vals.push(fields.description); }
  if (fields.status !== undefined)      {
    sets.push(`status = $${idx++}`);    vals.push(fields.status);
    sets.push(`completed_at = CASE WHEN $${idx} = 'completed' THEN NOW() ELSE completed_at END`); vals.push(fields.status); idx++;
  }
  if (!sets.length) return getProjectById(id);
  sets.push(`updated_at = NOW()`);
  const { rows } = await pool.query(
    `UPDATE projects SET ${sets.join(', ')} WHERE id = $1 RETURNING ${PROJECT_FIELDS}`,
    vals,
  );
  return rows[0] || null;
}
async function deleteProject(id) {
  await pool.query('DELETE FROM projects WHERE id = $1', [id]);
}

async function listTasksForProject(projectId) {
  const { rows } = await pool.query(
    `SELECT ${TASK_FIELDS} FROM project_tasks WHERE project_id = $1 ORDER BY created_at ASC`,
    [projectId],
  );
  return rows;
}
async function getProjectTaskById(id) {
  const { rows } = await pool.query(`SELECT ${TASK_FIELDS} FROM project_tasks WHERE id = $1`, [id]);
  return rows[0] || null;
}
async function createProjectTask({ projectId, entityId, title, description, createdBy }) {
  const { rows } = await pool.query(
    `INSERT INTO project_tasks (project_id, entity_id, title, description, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${TASK_FIELDS}`,
    [projectId, entityId, title, description || null, createdBy],
  );
  return rows[0];
}
async function updateProjectTask(id, fields) {
  const sets = [];
  const vals = [id];
  let idx = 2;
  if (fields.title !== undefined)       { sets.push(`title = $${idx++}`);       vals.push(fields.title); }
  if (fields.description !== undefined) { sets.push(`description = $${idx++}`); vals.push(fields.description); }
  if (fields.status !== undefined)      {
    sets.push(`status = $${idx++}`); vals.push(fields.status);
    sets.push(`completed_at = CASE WHEN $${idx} = 'completed' THEN NOW() ELSE completed_at END`); vals.push(fields.status); idx++;
  }
  if (!sets.length) return getProjectTaskById(id);
  sets.push(`updated_at = NOW()`);
  const { rows } = await pool.query(
    `UPDATE project_tasks SET ${sets.join(', ')} WHERE id = $1 RETURNING ${TASK_FIELDS}`,
    vals,
  );
  return rows[0] || null;
}
async function deleteProjectTask(id) {
  await pool.query('DELETE FROM project_tasks WHERE id = $1', [id]);
}
async function completeProjectTask(id) {
  const { rows } = await pool.query(
    `UPDATE project_tasks SET status = 'completed', completed_at = NOW(), updated_at = NOW()
     WHERE id = $1 RETURNING ${TASK_FIELDS}`,
    [id],
  );
  return rows[0] || null;
}
async function countOpenChecklistForTask(taskId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS open FROM task_checklist_items WHERE task_id = $1 AND is_done = FALSE`,
    [taskId],
  );
  return rows[0]?.open || 0;
}

async function listChecklistForTask(taskId) {
  const { rows } = await pool.query(
    `SELECT ${CHECKLIST_FIELDS} FROM task_checklist_items WHERE task_id = $1 ORDER BY created_at ASC`,
    [taskId],
  );
  return rows;
}
async function getChecklistItemById(id) {
  const { rows } = await pool.query(`SELECT ${CHECKLIST_FIELDS} FROM task_checklist_items WHERE id = $1`, [id]);
  return rows[0] || null;
}
async function createChecklistItem({ taskId, entityId, text, createdBy }) {
  const { rows } = await pool.query(
    `INSERT INTO task_checklist_items (task_id, entity_id, text, created_by)
     VALUES ($1, $2, $3, $4) RETURNING ${CHECKLIST_FIELDS}`,
    [taskId, entityId, text, createdBy],
  );
  return rows[0];
}
async function updateChecklistItem(id, fields) {
  const sets = [];
  const vals = [id];
  let idx = 2;
  if (fields.text !== undefined) { sets.push(`text = $${idx++}`); vals.push(fields.text); }
  if (!sets.length) return getChecklistItemById(id);
  sets.push(`updated_at = NOW()`);
  const { rows } = await pool.query(
    `UPDATE task_checklist_items SET ${sets.join(', ')} WHERE id = $1 RETURNING ${CHECKLIST_FIELDS}`,
    vals,
  );
  return rows[0] || null;
}
async function deleteChecklistItem(id) {
  await pool.query('DELETE FROM task_checklist_items WHERE id = $1', [id]);
}
async function toggleChecklistItem(id) {
  const { rows } = await pool.query(
    `UPDATE task_checklist_items
     SET is_done = NOT is_done,
         completed_at = CASE WHEN NOT is_done THEN NOW() ELSE NULL END,
         updated_at = NOW()
     WHERE id = $1 RETURNING ${CHECKLIST_FIELDS}`,
    [id],
  );
  return rows[0] || null;
}

async function listNotesForProject(projectId) {
  const { rows } = await pool.query(
    `SELECT ${NOTE_FIELDS} FROM project_notes WHERE project_id = $1 ORDER BY created_at DESC`,
    [projectId],
  );
  return rows;
}
async function listNotesForTask(taskId) {
  const { rows } = await pool.query(
    `SELECT ${NOTE_FIELDS} FROM project_notes WHERE task_id = $1 ORDER BY created_at DESC`,
    [taskId],
  );
  return rows;
}
async function getProjectNoteById(id) {
  const { rows } = await pool.query(`SELECT ${NOTE_FIELDS} FROM project_notes WHERE id = $1`, [id]);
  return rows[0] || null;
}
async function createProjectNote({ projectId, taskId, entityId, body, createdBy }) {
  const { rows } = await pool.query(
    `INSERT INTO project_notes (project_id, task_id, entity_id, body, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${NOTE_FIELDS}`,
    [projectId || null, taskId || null, entityId, body, createdBy],
  );
  return rows[0];
}
async function updateProjectNote(id, body) {
  const { rows } = await pool.query(
    `UPDATE project_notes SET body = $2, updated_at = NOW() WHERE id = $1 RETURNING ${NOTE_FIELDS}`,
    [id, body],
  );
  return rows[0] || null;
}
async function deleteProjectNote(id) {
  await pool.query('DELETE FROM project_notes WHERE id = $1', [id]);
}

/**
 * Active projects across every entity the user can access (member or owner).
 * Used by buildAgenticContext so Aria can reference open project state +
 * by /api/brief/context for the active-zone Projects card.
 *
 * Each row carries:
 *   {id, title, status, entityId, entityName,
 *    openTasks, completedTasks,
 *    openTaskTitles: ["…", "…"],     // top 2 by recency
 *    recentNote: "…"|null}            // newest note body, truncated 100 chars
 */
async function getProjectContextForUser(userId, limit = 5) {
  // Step 1: project rollup (counts + identity).
  // Entity-access paths covered (mirrors the broader visibility surface
  // used elsewhere in the app, plus legacy fallbacks):
  //   1. entity_members rows for this user (canonical Phase 1 path)
  //   2. entities the user created (created_by)
  //   3. entities flagged as shared=true (legacy badge, still in use)
  //   4. entities whose NAMES appear in users.entity_ids JSONB (legacy
  //      list stores names, not ids — must resolve via entities.name)
  const { rows: projects } = await pool.query(
    `SELECT p.id, p.title, p.status, p.entity_id AS "entityId",
            e.name AS "entityName",
            COUNT(DISTINCT pt.id) FILTER (WHERE pt.status = 'open')      AS "openTasks",
            COUNT(DISTINCT pt.id) FILTER (WHERE pt.status = 'completed') AS "completedTasks"
     FROM projects p
     JOIN entities e ON e.id = p.entity_id
     LEFT JOIN project_tasks pt ON pt.project_id = p.id
     WHERE p.entity_id IN (
       SELECT entity_id FROM entity_members WHERE user_id = $1
       UNION
       SELECT id FROM entities WHERE created_by = $1
       UNION
       SELECT id FROM entities WHERE shared = TRUE
       UNION
       SELECT e2.id FROM entities e2
       WHERE e2.name = ANY(
         SELECT jsonb_array_elements_text(u.entity_ids)
         FROM users u WHERE u.id = $1
       )
     )
       AND LOWER(p.status) = 'active'
     GROUP BY p.id, e.name
     ORDER BY p.updated_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  if (!projects.length) return [];

  const ids = projects.map((p) => p.id);

  // Step 2: top 2 open task titles per project (window function).
  const { rows: taskRows } = await pool.query(
    `SELECT project_id AS "projectId", title FROM (
       SELECT project_id, title,
              ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY created_at DESC) AS rn
       FROM project_tasks
       WHERE project_id = ANY($1::text[]) AND status = 'open'
     ) t WHERE rn <= 2`,
    [ids],
  );
  const tasksByProject = new Map();
  for (const r of taskRows) {
    if (!tasksByProject.has(r.projectId)) tasksByProject.set(r.projectId, []);
    tasksByProject.get(r.projectId).push(r.title);
  }

  // Step 3: most recent note body per project.
  const { rows: noteRows } = await pool.query(
    `SELECT project_id AS "projectId", body FROM (
       SELECT project_id, body,
              ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY created_at DESC) AS rn
       FROM project_notes
       WHERE project_id = ANY($1::text[])
     ) n WHERE rn = 1`,
    [ids],
  );
  const noteByProject = new Map(noteRows.map((r) => [r.projectId, r.body]));

  return projects.map((p) => ({
    ...p,
    openTaskTitles: tasksByProject.get(p.id) || [],
    recentNote: noteByProject.has(p.id) ? String(noteByProject.get(p.id)).slice(0, 100) : null,
  }));
}

/**
 * Open project tasks across every entity a user can access. Used by the
 * brief-context "Still open" rollup so personal tasks and project tasks
 * surface together.
 */
async function getOpenProjectTasksForUser(userId, limit = 5) {
  const { rows } = await pool.query(
    `SELECT pt.id, pt.title, p.title AS "projectTitle",
            e.name AS "entityName", pt.entity_id AS "entityId",
            pt.project_id AS "projectId"
     FROM project_tasks pt
     JOIN projects p ON p.id = pt.project_id
     JOIN entities e ON e.id = pt.entity_id
     WHERE pt.entity_id IN (
       SELECT entity_id FROM entity_members WHERE user_id = $1
       UNION
       SELECT id FROM entities WHERE created_by = $1
       UNION
       SELECT id FROM entities WHERE shared = TRUE
       UNION
       SELECT e2.id FROM entities e2
       WHERE e2.name = ANY(
         SELECT jsonb_array_elements_text(u.entity_ids)
         FROM users u WHERE u.id = $1
       )
     )
       AND LOWER(pt.status) = 'open'
     ORDER BY pt.created_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

// ── People Memory + Shared Access helpers (Phase 0) ────────────────────────
// Multi-tenant contract:
//   • Every helper is scoped to the authenticated userId at the query level.
//   • Cross-user reads only happen through shared_access_grants + hasActiveGrant.
//   • No helper accepts a role or authz-shaped parameter (see CLAUDE.md Ray rules).

const CONTACT_FIELDS = `
  id, user_id AS "userId",
  display_name AS "displayName",
  primary_email AS "primaryEmail",
  primary_phone AS "primaryPhone",
  company, role, notes,
  linked_user_id AS "linkedUserId",
  source,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

async function getContactsForUser(userId) {
  const { rows } = await pool.query(
    `SELECT ${CONTACT_FIELDS}
     FROM contacts WHERE user_id = $1
     ORDER BY display_name ASC`,
    [userId],
  );
  return rows;
}

async function getContactById(contactId, userId) {
  const { rows } = await pool.query(
    `SELECT ${CONTACT_FIELDS}
     FROM contacts WHERE id = $1 AND user_id = $2`,
    [contactId, userId],
  );
  return rows[0] || null;
}

async function createContact(userId, data) {
  const { displayName, primaryEmail, primaryPhone, company, role, notes, linkedUserId, source } = data || {};
  if (!displayName) throw new Error('displayName required');
  const { rows } = await pool.query(
    `INSERT INTO contacts
       (user_id, display_name, primary_email, primary_phone, company, role, notes, linked_user_id, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${CONTACT_FIELDS}`,
    [
      userId, displayName,
      primaryEmail ? String(primaryEmail).toLowerCase() : null,
      primaryPhone || null, company || null, role || null, notes || null,
      linkedUserId || null, source || null,
    ],
  );
  return rows[0];
}

async function updateContact(contactId, userId, patch) {
  const sets = [];
  const vals = [contactId, userId];
  let i = 3;
  const map = {
    displayName: 'display_name',
    primaryEmail: 'primary_email',
    primaryPhone: 'primary_phone',
    company: 'company',
    role: 'role',
    notes: 'notes',
    linkedUserId: 'linked_user_id',
    source: 'source',
  };
  for (const [k, col] of Object.entries(map)) {
    if (patch[k] === undefined) continue;
    let v = patch[k];
    if (k === 'primaryEmail' && v) v = String(v).toLowerCase();
    sets.push(`${col} = $${i++}`);
    vals.push(v);
  }
  if (!sets.length) return getContactById(contactId, userId);
  sets.push(`updated_at = NOW()`);
  const { rows } = await pool.query(
    `UPDATE contacts SET ${sets.join(', ')}
     WHERE id = $1 AND user_id = $2
     RETURNING ${CONTACT_FIELDS}`,
    vals,
  );
  return rows[0] || null;
}

async function deleteContact(contactId, userId) {
  const r = await pool.query(
    `DELETE FROM contacts WHERE id = $1 AND user_id = $2`,
    [contactId, userId],
  );
  return r.rowCount > 0;
}

/**
 * Resolve a contact for a user by email. Checks contact_identities first
 * (kind='email'), then falls back to contacts.primary_email. Case-insensitive.
 * Scoped to userId — never crosses tenants.
 */
async function resolveContactByEmail(email, userId) {
  if (!email) return null;
  const lc = String(email).toLowerCase();
  // Try identities table first (includes verified + unverified aliases).
  const { rows: idRows } = await pool.query(
    `SELECT c.id
     FROM contact_identities ci
     JOIN contacts c ON c.id = ci.contact_id
     WHERE ci.kind = 'email'
       AND LOWER(ci.value) = $1
       AND c.user_id = $2
     LIMIT 1`,
    [lc, userId],
  );
  if (idRows.length) return getContactById(idRows[0].id, userId);
  // Fallback: primary_email on contacts itself.
  const { rows } = await pool.query(
    `SELECT ${CONTACT_FIELDS}
     FROM contacts
     WHERE user_id = $1 AND LOWER(primary_email) = $2
     LIMIT 1`,
    [userId, lc],
  );
  return rows[0] || null;
}

async function resolveContactByName(name, userId) {
  if (!name) return null;
  const { rows } = await pool.query(
    `SELECT ${CONTACT_FIELDS}
     FROM contacts
     WHERE user_id = $1 AND display_name ILIKE $2
     ORDER BY display_name ASC
     LIMIT 5`,
    [userId, `%${name}%`],
  );
  return rows;
}

async function addContactIdentity(contactId, kind, value) {
  if (!contactId || !kind || !value) throw new Error('contactId, kind, value required');
  const { rows } = await pool.query(
    `INSERT INTO contact_identities (contact_id, kind, value)
     VALUES ($1, $2, $3)
     RETURNING id, contact_id AS "contactId", kind, value, verified, created_at AS "createdAt"`,
    [contactId, kind, String(value).toLowerCase()],
  );
  return rows[0];
}

async function getContactIdentities(contactId) {
  const { rows } = await pool.query(
    `SELECT id, contact_id AS "contactId", kind, value, verified, created_at AS "createdAt"
     FROM contact_identities WHERE contact_id = $1
     ORDER BY created_at ASC`,
    [contactId],
  );
  return rows;
}

// ── Shared access grants ────────────────────────────────────────────────────

const GRANT_FIELDS = `
  id,
  grantor_user_id AS "grantorUserId",
  grantee_user_id AS "granteeUserId",
  scope,
  resource_filter_json AS "resourceFilter",
  expires_at AS "expiresAt",
  created_at AS "createdAt",
  revoked_at AS "revokedAt"
`;

async function createGrant(grantorUserId, granteeUserId, scope, resourceFilterJson, expiresAt) {
  if (!grantorUserId || !granteeUserId || !scope) throw new Error('grantor, grantee, scope required');
  if (grantorUserId === granteeUserId) throw new Error('Cannot grant access to yourself');
  const { rows } = await pool.query(
    `INSERT INTO shared_access_grants
       (grantor_user_id, grantee_user_id, scope, resource_filter_json, expires_at)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING ${GRANT_FIELDS}`,
    [
      grantorUserId, granteeUserId, scope,
      resourceFilterJson ? JSON.stringify(resourceFilterJson) : null,
      expiresAt || null,
    ],
  );
  return rows[0];
}

async function revokeGrant(grantId, grantorUserId) {
  const r = await pool.query(
    `UPDATE shared_access_grants
     SET revoked_at = NOW()
     WHERE id = $1 AND grantor_user_id = $2 AND revoked_at IS NULL`,
    [grantId, grantorUserId],
  );
  return r.rowCount > 0;
}

async function getGrantsForGrantor(userId) {
  const { rows } = await pool.query(
    `SELECT ${GRANT_FIELDS}
     FROM shared_access_grants
     WHERE grantor_user_id = $1
     ORDER BY revoked_at NULLS FIRST, created_at DESC`,
    [userId],
  );
  return rows;
}

async function getGrantsForGrantee(userId) {
  const { rows } = await pool.query(
    `SELECT ${GRANT_FIELDS}
     FROM shared_access_grants
     WHERE grantee_user_id = $1
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

/**
 * Boolean check: does granteeUserId have an active grant from grantorUserId
 * for the given scope? Active = not revoked, not expired.
 */
async function hasActiveGrant(granteeUserId, grantorUserId, scope) {
  if (!granteeUserId || !grantorUserId || !scope) return false;
  const { rows } = await pool.query(
    `SELECT 1
     FROM shared_access_grants
     WHERE grantor_user_id = $1
       AND grantee_user_id = $2
       AND scope = $3
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 1`,
    [grantorUserId, granteeUserId, scope],
  );
  return rows.length > 0;
}

// ── Connections (person-to-person graph) ────────────────────────────────────

const CONNECTION_FIELDS = `
  id,
  user_id AS "userId",
  peer_user_id AS "peerUserId",
  peer_contact_id AS "peerContactId",
  relationship,
  status,
  created_at AS "createdAt",
  accepted_at AS "acceptedAt"
`;

async function createConnection(userId, peerUserId, peerContactId, relationship) {
  if (!userId) throw new Error('userId required');
  if (!peerUserId && !peerContactId) throw new Error('peerUserId or peerContactId required');
  if (peerUserId && peerContactId) throw new Error('Provide only one of peerUserId or peerContactId');
  const { rows } = await pool.query(
    `INSERT INTO connections
       (user_id, peer_user_id, peer_contact_id, relationship, status)
     VALUES ($1, $2, $3, $4, 'pending')
     RETURNING ${CONNECTION_FIELDS}`,
    [userId, peerUserId || null, peerContactId || null, relationship || null],
  );
  return rows[0];
}

async function updateConnectionStatus(connectionId, userId, status) {
  const { rows } = await pool.query(
    `UPDATE connections
     SET status = $3,
         accepted_at = CASE WHEN $3 = 'accepted' THEN NOW() ELSE accepted_at END
     WHERE id = $1 AND user_id = $2
     RETURNING ${CONNECTION_FIELDS}`,
    [connectionId, userId, status],
  );
  return rows[0] || null;
}

async function getConnectionsForUser(userId) {
  const { rows } = await pool.query(
    `SELECT ${CONNECTION_FIELDS}
     FROM connections WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

async function getConnectionByPeer(userId, peerUserId) {
  if (!userId || !peerUserId) return null;
  const { rows } = await pool.query(
    `SELECT ${CONNECTION_FIELDS}
     FROM connections
     WHERE user_id = $1 AND peer_user_id = $2
     LIMIT 1`,
    [userId, peerUserId],
  );
  return rows[0] || null;
}

// ── Contact-scoped memory facts (targets the contact-scoped partial index) ──

async function addContactFact(userId, contactId, factText, factType, strengthScore) {
  if (!userId || !contactId || !factText) throw new Error('userId, contactId, factText required');
  const start = Number.isFinite(strengthScore) ? Math.max(0, Math.min(1, strengthScore)) : 0.5;
  await pool.query(
    `INSERT INTO memory_facts
       (user_id, contact_id, fact_text, fact_type, supporting_count, strength_score, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, $4, 1, $5, NOW(), NOW())
     ON CONFLICT (user_id, contact_id, fact_text) WHERE contact_id IS NOT NULL
     DO UPDATE SET
       supporting_count = memory_facts.supporting_count + 1,
       strength_score   = LEAST(1.0, memory_facts.strength_score + 0.1),
       last_seen_at     = NOW()`,
    [userId, contactId, factText, factType || null, start],
  );
}

/**
 * Most-relevant contacts for Aria context. Ranked by most-recent
 * memory_fact activity (so contacts we've been learning about recently
 * float up) with a stable tiebreaker on updated_at.
 */
async function getRelevantContacts(userId, limit = 10) {
  const { rows } = await pool.query(
    `SELECT c.id, c.user_id AS "userId",
            c.display_name AS "displayName",
            c.primary_email AS "primaryEmail",
            c.primary_phone AS "primaryPhone",
            c.company, c.role, c.notes,
            c.linked_user_id AS "linkedUserId",
            c.source,
            c.created_at AS "createdAt",
            c.updated_at AS "updatedAt",
            MAX(mf.last_seen_at) AS "lastFactAt"
     FROM contacts c
     LEFT JOIN memory_facts mf ON mf.contact_id = c.id
     WHERE c.user_id = $1
     GROUP BY c.id
     ORDER BY MAX(mf.last_seen_at) DESC NULLS LAST,
              c.updated_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

/**
 * Top N facts for a contact by strength, excluding free-form notes.
 * Returns just the text strings for direct block formatting.
 */
async function getTopContactFacts(contactId, userId, limit = 3) {
  const { rows } = await pool.query(
    `SELECT fact_text AS "factText"
     FROM memory_facts
     WHERE contact_id = $1
       AND user_id = $2
       AND (fact_type IS NULL OR fact_type <> 'note')
     ORDER BY strength_score DESC, last_seen_at DESC
     LIMIT $3`,
    [contactId, userId, limit],
  );
  return rows.map((r) => r.factText);
}

/**
 * Summary of active shared-access grants touching this user, used by
 * the Aria context block.
 */
async function getSharedAccessSummary(userId) {
  const [givenRes, receivedRes] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS n
       FROM shared_access_grants
       WHERE grantor_user_id = $1
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [userId],
    ),
    pool.query(
      `SELECT scope
       FROM shared_access_grants
       WHERE grantee_user_id = $1
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [userId],
    ),
  ]);
  const scopes = [...new Set(receivedRes.rows.map((r) => r.scope))];
  return {
    grantsGiven: givenRes.rows[0]?.n || 0,
    grantsReceived: receivedRes.rows.length,
    scopes,
  };
}

// ── Daily Wrap + Ambient Capture helpers (V1) ─────────────────────────────

const JOURNAL_FIELDS = `
  id,
  user_id AS "userId",
  entry_date AS "entryDate",
  wins, frustrations,
  tomorrow_focus AS "tomorrowFocus",
  raw_freeform AS "rawFreeform",
  completed_at AS "completedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

/**
 * Upsert today's (or any specified) journal entry for a user. Merges
 * patch fields in — a second call with only `tomorrow_focus` does NOT
 * wipe previously-set `wins`. Pass completed=true to stamp completed_at.
 */
async function upsertJournalEntry(userId, entryDate, patch = {}) {
  if (!userId || !entryDate) throw new Error('userId + entryDate required');
  const hasWins = patch.wins !== undefined;
  const hasFrust = patch.frustrations !== undefined;
  const hasTF = patch.tomorrowFocus !== undefined;
  const hasFree = patch.rawFreeform !== undefined;
  const markComplete = patch.completed === true;
  const { rows } = await pool.query(
    `INSERT INTO journal_entries
       (user_id, entry_date, wins, frustrations, tomorrow_focus, raw_freeform, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7 THEN NOW() ELSE NULL END)
     ON CONFLICT (user_id, entry_date) DO UPDATE SET
       wins            = CASE WHEN $8::bool THEN EXCLUDED.wins            ELSE journal_entries.wins            END,
       frustrations    = CASE WHEN $9::bool THEN EXCLUDED.frustrations    ELSE journal_entries.frustrations    END,
       tomorrow_focus  = CASE WHEN $10::bool THEN EXCLUDED.tomorrow_focus ELSE journal_entries.tomorrow_focus  END,
       raw_freeform    = CASE WHEN $11::bool THEN EXCLUDED.raw_freeform   ELSE journal_entries.raw_freeform    END,
       completed_at    = CASE WHEN $7 THEN NOW() ELSE journal_entries.completed_at END,
       updated_at      = NOW()
     RETURNING ${JOURNAL_FIELDS}`,
    [
      userId, entryDate,
      hasWins ? patch.wins : null,
      hasFrust ? patch.frustrations : null,
      hasTF ? patch.tomorrowFocus : null,
      hasFree ? patch.rawFreeform : null,
      markComplete,
      hasWins, hasFrust, hasTF, hasFree,
    ],
  );
  return rows[0];
}

async function getJournalEntryByDate(userId, entryDate) {
  const { rows } = await pool.query(
    `SELECT ${JOURNAL_FIELDS}
     FROM journal_entries
     WHERE user_id = $1 AND entry_date = $2`,
    [userId, entryDate],
  );
  return rows[0] || null;
}

async function listJournalEntries(userId, { limit = 20, offset = 0, sinceDate = null } = {}) {
  const params = [userId];
  let where = `WHERE user_id = $1`;
  if (sinceDate) { params.push(sinceDate); where += ` AND entry_date >= $${params.length}`; }
  params.push(limit); const limitIdx = params.length;
  params.push(offset); const offsetIdx = params.length;
  const { rows } = await pool.query(
    `SELECT ${JOURNAL_FIELDS}
     FROM journal_entries ${where}
     ORDER BY entry_date DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  );
  return rows;
}

/**
 * Has this user completed a wrap for the given local date? Canonical
 * check — both the cron and the web login trigger use this before
 * firing any reminder.
 */
async function hasCompletedWrap(userId, entryDate) {
  const { rows } = await pool.query(
    `SELECT 1 FROM journal_entries
     WHERE user_id = $1 AND entry_date = $2 AND completed_at IS NOT NULL
     LIMIT 1`,
    [userId, entryDate],
  );
  return rows.length > 0;
}

// ── Close-loop queue ──────────────────────────────────────────────────────

const CLOSE_LOOP_FIELDS = `
  id,
  user_id AS "userId",
  source_type AS "sourceType",
  source_id AS "sourceId",
  title_snapshot AS "titleSnapshot",
  triggered_at AS "triggeredAt",
  dismissed_at AS "dismissedAt",
  resolved_at AS "resolvedAt"
`;

/**
 * Emit a close-loop row. Idempotent on (user_id, source_type, source_id)
 * via the partial unique index — a second emit clears prior dismiss/resolve
 * so the item can resurface (e.g. reopened task).
 */
async function emitCloseLoopItem(userId, sourceType, sourceId, titleSnapshot) {
  if (!userId || !sourceType || !sourceId) return null;
  const { rows } = await pool.query(
    `INSERT INTO pending_close_loop
       (user_id, source_type, source_id, title_snapshot)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, source_type, source_id) DO UPDATE SET
       title_snapshot = EXCLUDED.title_snapshot,
       triggered_at   = NOW(),
       dismissed_at   = NULL,
       resolved_at    = NULL
     RETURNING ${CLOSE_LOOP_FIELDS}`,
    [userId, sourceType, sourceId, titleSnapshot || null],
  );
  return rows[0];
}

/**
 * Open close-loop items for today. "Open" = not resolved AND either
 * never dismissed OR dismissed before today's local-midnight cutoff
 * (i.e. dismiss-for-today-only, per spec decision 2).
 */
async function getOpenCloseLoopItems(userId, localMidnightUtc, limit = 5) {
  const { rows } = await pool.query(
    `SELECT ${CLOSE_LOOP_FIELDS}
     FROM pending_close_loop
     WHERE user_id = $1
       AND resolved_at IS NULL
       AND (dismissed_at IS NULL OR dismissed_at < $2)
     ORDER BY triggered_at DESC
     LIMIT $3`,
    [userId, localMidnightUtc, limit],
  );
  return rows;
}

async function dismissCloseLoopItem(userId, sourceType, sourceId) {
  const r = await pool.query(
    `UPDATE pending_close_loop
     SET dismissed_at = NOW()
     WHERE user_id = $1 AND source_type = $2 AND source_id = $3
       AND resolved_at IS NULL`,
    [userId, sourceType, sourceId],
  );
  return r.rowCount > 0;
}

async function resolveCloseLoopItem(userId, sourceType, sourceId) {
  const r = await pool.query(
    `UPDATE pending_close_loop
     SET resolved_at = NOW()
     WHERE user_id = $1 AND source_type = $2 AND source_id = $3
       AND resolved_at IS NULL`,
    [userId, sourceType, sourceId],
  );
  return r.rowCount > 0;
}

// ── Wrap-time preference ──────────────────────────────────────────────────

async function getWrapTimeForUser(userId) {
  const { rows } = await pool.query(
    `SELECT wrap_time AS "wrapTime"
     FROM user_preferences WHERE user_id = $1`,
    [userId],
  );
  return rows[0]?.wrapTime || null;
}

async function setWrapTimeForUser(userId, wrapTime) {
  if (wrapTime && !/^\d{2}:\d{2}$/.test(wrapTime)) {
    throw new Error('wrap_time must be HH:MM');
  }
  await pool.query(
    `INSERT INTO user_preferences (user_id, wrap_time, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET wrap_time = EXCLUDED.wrap_time, updated_at = NOW()`,
    [userId, wrapTime || null],
  );
}

async function getContactFacts(contactId, userId) {
  const { rows } = await pool.query(
    `SELECT id, fact_text AS "factText", fact_type AS "factType",
            supporting_count AS "supportingCount",
            strength_score AS "strengthScore",
            first_seen_at AS "firstSeenAt",
            last_seen_at AS "lastSeenAt"
     FROM memory_facts
     WHERE contact_id = $1 AND user_id = $2
     ORDER BY strength_score DESC, last_seen_at DESC`,
    [contactId, userId],
  );
  return rows;
}

// ── Outcome Intelligence helpers (Phase 1) ─────────────────────────────────

/**
 * Persist an outcome record for a completed task or event. `enteredBy`
 * defaults to 'user' for direct captures; Phase 2 will set 'assistant'
 * for Aria-parsed notes and 'system' for auto-classified events.
 */
async function createOutcomeRecord(userId, {
  sourceType, sourceId, completedAt, titleSnapshot,
  rawNote, outcomeStatus, followUpNeeded, followUpBy,
  enteredBy = 'user',
}) {
  const { rows } = await pool.query(
    `INSERT INTO outcome_records (
       user_id, source_type, source_id, completed_at,
       title_snapshot, raw_note, outcome_status,
       follow_up_needed, follow_up_by, entered_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      userId, sourceType, sourceId,
      completedAt || new Date(),
      titleSnapshot, rawNote, outcomeStatus,
      followUpNeeded || false, followUpBy, enteredBy,
    ],
  );
  return rows[0];
}

/** Paginated list of a user's outcome records, newest first. */
async function getOutcomeRecordsForUser(userId, limit = 20, offset = 0) {
  const { rows } = await pool.query(
    `SELECT * FROM outcome_records
     WHERE user_id = $1
     ORDER BY completed_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset],
  );
  return rows;
}

/** Persist a single enrichment signal on an outcome. Idempotent by default. */
async function createOutcomeSignal(outcomeId, signalName, signalValue, confidence, modelName) {
  await pool.query(
    `INSERT INTO outcome_signals
       (outcome_id, signal_name, signal_value, confidence, model_name)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT DO NOTHING`,
    [outcomeId, signalName, JSON.stringify(signalValue), confidence, modelName],
  );
}

/**
 * Flip follow_up_needed on an outcome_records row and optionally log a
 * follow-up suggestion as a signal. User-scoped on the UPDATE to prevent
 * cross-tenant mutation.
 */
async function updateOutcomeFollowUp(outcomeId, userId, followUpNeeded, suggestion) {
  await pool.query(
    `UPDATE outcome_records
     SET follow_up_needed = $3, updated_at = NOW()
     WHERE id = $1 AND user_id = $2`,
    [outcomeId, userId, followUpNeeded],
  );
  if (suggestion) {
    await pool.query(
      `INSERT INTO outcome_signals
         (outcome_id, signal_name, signal_value, confidence, model_name)
       VALUES ($1, 'follow_up_suggestion', $2::jsonb, 0.8, 'claude-haiku-4-5-20251001')
       ON CONFLICT DO NOTHING`,
      [outcomeId, JSON.stringify(suggestion)],
    );
  }
}

/**
 * Upsert a memory fact keyed on (user_id, fact_text). Repeat observations
 * bump supporting_count and raise strength_score (capped at 1.0).
 * `source` is accepted for caller symmetry but not persisted — add a
 * source column later if provenance becomes important.
 */
async function upsertMemoryFact(userId, entityId, factText, factType /*, source */) {
  // NOTE: the global unique index on (user_id, fact_text) is partial
  // `WHERE contact_id IS NULL` so the ON CONFLICT inference needs the
  // matching predicate. Rows inserted here have contact_id NULL and so
  // target the global uniqueness axis only. Contact-scoped upserts live
  // in addContactFact() below.
  await pool.query(
    `INSERT INTO memory_facts
       (user_id, entity_id, fact_text, fact_type, supporting_count, strength_score, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, $4, 1, 0.5, NOW(), NOW())
     ON CONFLICT (user_id, fact_text) WHERE contact_id IS NULL
     DO UPDATE SET
       supporting_count = memory_facts.supporting_count + 1,
       strength_score   = LEAST(1.0, memory_facts.strength_score + 0.1),
       last_seen_at     = NOW()`,
    [userId, entityId, factText, factType],
  );
}

/**
 * Return strongest global memory facts for a user, strength-first.
 * Excludes contact-scoped rows (contact_id IS NOT NULL) — those surface
 * in the PEOPLE & RELATIONSHIPS block via getTopContactFacts.
 */
async function getMemoryFactsForUser(userId, limit = 10) {
  const { rows } = await pool.query(
    `SELECT fact_text, fact_type, supporting_count, strength_score, last_seen_at
     FROM memory_facts
     WHERE user_id = $1
       AND contact_id IS NULL
     ORDER BY strength_score DESC, last_seen_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

/**
 * Recent outcomes with narrative notes — fed into the Aria system prompt
 * so responses reflect what actually happened on prior tasks/events.
 */
async function getRecentOutcomeContext(userId, limit = 5) {
  const { rows } = await pool.query(
    `SELECT title_snapshot, raw_note, outcome_status,
            follow_up_needed, completed_at, source_type
     FROM outcome_records
     WHERE user_id = $1
       AND raw_note IS NOT NULL
       AND raw_note <> ''
     ORDER BY completed_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

/**
 * Open pending_confirmations for a user — ones that are still waiting for
 * YES/NO and haven't expired. Used by the Active Zone candidate detector
 * to surface a "pending_confirmation" tile at priority 95.
 */
async function getOpenPendingConfirmations(userId, limit = 5) {
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", tool_name AS "toolName", params_json AS "params",
            channel, status, expires_at AS "expiresAt", created_at AS "createdAt"
       FROM pending_confirmations
      WHERE user_id = $1 AND status = 'pending' AND expires_at > NOW()
      ORDER BY created_at ASC
      LIMIT $2`,
    [userId, Math.min(parseInt(limit, 10) || 5, 50)],
  );
  return rows;
}

// ── active_zone_tiles helpers ────────────────────────────────────────────

/**
 * UPSERT a tile by (user_id, candidate_key). Detector re-runs always flow
 * through this helper so an unchanged situation updates the same row
 * rather than flickering the UI with delete+insert. Preserves user-set
 * status/deferred_until/dismissed_until across re-runs — the detector
 * doesn't get to override a "not now" the user just clicked.
 */
async function upsertActiveZoneTile(tile) {
  const {
    id, userId, candidateType, candidateKey, priorityScore, urgency,
    headline, body, primaryAction, secondaryAction, itemsPreview,
    composerSource,
  } = tile;
  const { rows } = await pool.query(
    `INSERT INTO active_zone_tiles
       (id, user_id, candidate_type, candidate_key, priority_score, urgency,
        headline, body, primary_action, secondary_action, items_preview,
        composer_source, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb,
             $12, 'pending', NOW(), NOW())
     ON CONFLICT (user_id, candidate_key) DO UPDATE SET
       priority_score   = EXCLUDED.priority_score,
       urgency          = EXCLUDED.urgency,
       headline         = EXCLUDED.headline,
       body             = EXCLUDED.body,
       primary_action   = EXCLUDED.primary_action,
       secondary_action = EXCLUDED.secondary_action,
       items_preview    = EXCLUDED.items_preview,
       composer_source  = EXCLUDED.composer_source,
       updated_at       = NOW()
     RETURNING id, user_id AS "userId", candidate_type AS "candidateType",
               candidate_key AS "candidateKey", priority_score AS "priorityScore",
               urgency, headline, body,
               primary_action AS "primaryAction",
               secondary_action AS "secondaryAction",
               items_preview AS "itemsPreview",
               status, deferred_until AS "deferredUntil",
               dismissed_until AS "dismissedUntil",
               composer_source AS "composerSource",
               created_at AS "createdAt", updated_at AS "updatedAt"`,
    [id, userId, candidateType, candidateKey, priorityScore, urgency || null,
     headline || '', body || '',
     JSON.stringify(primaryAction || {}),
     JSON.stringify(secondaryAction || {}),
     JSON.stringify(itemsPreview || []),
     composerSource || null],
  );
  return rows[0];
}

/**
 * Active tiles for a user, ranked by priority. Excludes tiles currently
 * deferred/dismissed with a future resume time. Returns up to `limit`
 * (default 3).
 */
async function getActiveZoneTiles(userId, limit = 3) {
  const { rows } = await pool.query(
    `SELECT id, candidate_type AS "candidateType", candidate_key AS "candidateKey",
            priority_score AS "priorityScore", urgency,
            headline, body,
            primary_action AS "primaryAction",
            secondary_action AS "secondaryAction",
            items_preview AS "itemsPreview",
            status, deferred_until AS "deferredUntil",
            dismissed_until AS "dismissedUntil",
            composer_source AS "composerSource",
            created_at AS "createdAt", updated_at AS "updatedAt"
       FROM active_zone_tiles
      WHERE user_id = $1
        AND status = 'pending'
        AND (deferred_until IS NULL OR deferred_until <= NOW())
        AND (dismissed_until IS NULL OR dismissed_until <= NOW())
      ORDER BY priority_score DESC, updated_at ASC
      LIMIT $2`,
    [userId, Math.min(parseInt(limit, 10) || 3, 10)],
  );
  return rows;
}

/** Single tile by id, tenant-scoped. */
async function getActiveZoneTileById(id, userId) {
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", candidate_type AS "candidateType",
            candidate_key AS "candidateKey", priority_score AS "priorityScore",
            urgency, headline, body,
            primary_action AS "primaryAction",
            secondary_action AS "secondaryAction",
            items_preview AS "itemsPreview",
            status, deferred_until AS "deferredUntil",
            dismissed_until AS "dismissedUntil",
            composer_source AS "composerSource"
       FROM active_zone_tiles WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0] || null;
}

/** Update tile status with optional time-gate (deferred/dismissed). */
async function updateActiveZoneTileStatus(id, userId, status, resumeAt = null) {
  const col = status === 'deferred' ? 'deferred_until'
            : status === 'dismissed' ? 'dismissed_until'
            : null;
  if (col) {
    const { rowCount } = await pool.query(
      `UPDATE active_zone_tiles SET status = $3, ${col} = $4, updated_at = NOW()
         WHERE id = $1 AND user_id = $2`,
      [id, userId, status, resumeAt],
    );
    return rowCount > 0;
  }
  const { rowCount } = await pool.query(
    `UPDATE active_zone_tiles SET status = $3, updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
    [id, userId, status],
  );
  return rowCount > 0;
}

/**
 * Re-pend any deferred/dismissed tiles whose resume time has elapsed.
 * Run BEFORE the detector's upsert loop so a tile dismissed yesterday
 * comes back as 'pending' today (assuming the underlying situation
 * still triggers a candidate). Without this, dismissed/deferred tiles
 * stayed locked in their non-pending status forever, since
 * upsertActiveZoneTile preserves status on conflict.
 *
 * Returns the count of rows re-pended.
 */
async function rependElapsedActiveZoneTiles(userId) {
  const { rowCount } = await pool.query(
    `UPDATE active_zone_tiles
        SET status = 'pending',
            dismissed_until = NULL,
            deferred_until = NULL,
            updated_at = NOW()
      WHERE user_id = $1
        AND status IN ('deferred','dismissed')
        AND COALESCE(dismissed_until, deferred_until) <= NOW()`,
    [userId],
  );
  return rowCount || 0;
}

/**
 * Active candidate_keys the user is currently hiding (deferred or
 * dismissed with future resume time). The detector consults this set
 * to skip composition for situations the user has explicitly silenced
 * — saves the LLM cost of a tile we'd never display.
 */
async function getHiddenActiveZoneCandidateKeys(userId) {
  const { rows } = await pool.query(
    `SELECT candidate_key
       FROM active_zone_tiles
      WHERE user_id = $1
        AND status IN ('deferred','dismissed')
        AND COALESCE(dismissed_until, deferred_until) > NOW()`,
    [userId],
  );
  return new Set(rows.map((r) => r.candidate_key));
}

/**
 * Mark every pending tile whose candidate_key is NOT in the active set as
 * resolved — used by the detector to drop tiles whose underlying situation
 * no longer exists (task completed, meeting ended, etc.). Preserves
 * deferred/dismissed tiles since those are explicit user actions.
 */
async function resolveStaleActiveZoneTiles(userId, activeKeys) {
  if (!Array.isArray(activeKeys)) return 0;
  const { rowCount } = await pool.query(
    `UPDATE active_zone_tiles
        SET status = 'resolved', updated_at = NOW()
      WHERE user_id = $1
        AND status = 'pending'
        AND NOT (candidate_key = ANY($2))`,
    [userId, activeKeys.length ? activeKeys : ['__none__']],
  );
  return rowCount;
}

/**
 * Aggregate metrics for the admin Active Zone dashboard: tile counts per
 * composer_source (llm/fallback/cache) + status + candidate_type in the
 * last N hours. Caller is super-admin.
 */
async function getActiveZoneMetrics({ sinceHours = 24 } = {}) {
  const { rows } = await pool.query(
    `SELECT candidate_type AS "candidateType",
            composer_source AS "composerSource",
            status,
            COUNT(*)::int AS n
       FROM active_zone_tiles
      WHERE updated_at >= NOW() - ($1 || ' hours')::interval
      GROUP BY candidate_type, composer_source, status
      ORDER BY n DESC`,
    [String(sinceHours)],
  );
  return rows;
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
  getEntitiesForUserWithMembership,
  getEntityMembers,
  addEntityMember,
  removeEntityMember,
  getEntityMemberRole,
  getEntityById,
  createEntity,
  updateEntity,
  deleteEntity,
  upsertCalendarEvents,
  getCalendarEventsForUser,
  deleteStaleCalendarEvents,
  getUsersWithGcalConnected,
  getUsersWithOutlookConnected,
  getMeetingsNeedingNotes,
  createOutcomeRecord,
  getOutcomeRecordsForUser,
  getRecentOutcomeContext,
  createOutcomeSignal,
  updateOutcomeFollowUp,
  upsertMemoryFact,
  getMemoryFactsForUser,
  // People Memory + Shared Access (Phase 0)
  getContactsForUser,
  getContactById,
  createContact,
  updateContact,
  deleteContact,
  resolveContactByEmail,
  resolveContactByName,
  addContactIdentity,
  getContactIdentities,
  createGrant,
  revokeGrant,
  getGrantsForGrantor,
  getGrantsForGrantee,
  hasActiveGrant,
  createConnection,
  updateConnectionStatus,
  getConnectionsForUser,
  getConnectionByPeer,
  addContactFact,
  getContactFacts,
  getRelevantContacts,
  getTopContactFacts,
  getSharedAccessSummary,
  // Daily Wrap + Ambient Capture (Phase 0)
  upsertJournalEntry,
  getJournalEntryByDate,
  listJournalEntries,
  hasCompletedWrap,
  emitCloseLoopItem,
  getOpenCloseLoopItems,
  dismissCloseLoopItem,
  resolveCloseLoopItem,
  getWrapTimeForUser,
  setWrapTimeForUser,
  // Entity workspace projects
  listProjectsForEntity,
  getProjectById,
  createProject,
  updateProject,
  deleteProject,
  listTasksForProject,
  getProjectTaskById,
  createProjectTask,
  updateProjectTask,
  deleteProjectTask,
  completeProjectTask,
  countOpenChecklistForTask,
  listChecklistForTask,
  getChecklistItemById,
  createChecklistItem,
  updateChecklistItem,
  deleteChecklistItem,
  toggleChecklistItem,
  listNotesForProject,
  listNotesForTask,
  getProjectNoteById,
  createProjectNote,
  updateProjectNote,
  deleteProjectNote,
  getProjectContextForUser,
  getOpenProjectTasksForUser,
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
  getUserByIdentifier,
  updateUserPassword,
  seedUsersIfEmpty,
  runMigrations,
  getFinancialAccounts,
  createFinancialAccount,
  updateFinancialAccount,
  deleteFinancialAccount,
  getTransactions,
  getFinancialAccountForUser,
  createTransaction,
  bulkCreateTransactions,
  deleteTransaction,
  updateTransaction,
  getFinancialSummary,
  getAllGmailConnectedUsers,
  getGmailConfigForUser,
  setGmailConfigForUser,
  getInboxItemsForUser,
  createInboxItem,
  inboxItemExistsBySourceId,
  inboxItemsExistingBySourceIds,
  updateInboxItemAction,
  flagInboxItem,
  unflagInboxItem,
  ackInboxItem,
  unackInboxItem,
  getFlaggedInboxItems,
  getFlaggedInboxCount,
  getCriticalFlaggedInboxItems,
  getInboxItemById,
  searchInboxItems,
  upsertEmailLabel,
  getEmailLabelsForUser,
  updateLabelSemanticCategory,
  upsertFilingPattern,
  // Aria Intelligence System (Phase 0)
  upsertBehaviorRule,
  getActiveRulesForUser,
  reinforceRule,
  violateRule,
  decayRules,
  decayAllRules,
  archiveWeakRules,
  archiveAllWeakRules,
  setPreference,
  getPreference,
  getAllPreferences,
  logDecision,
  getDecisionHistory,
  getAdminDecisions,
  getAdminTrustMatrix,
  getAdminCorrections,
  updateDecisionOutcome,
  getTrustScore,
  updateTrustScore,
  seedDefaultTrustScores,
  applyTrustFeedback,
  countPendingCorrections,
  markCorrectionsProcessed,
  getDisposition,
  logCorrection,
  getCorrections,
  // Aria Intelligence System (Phase 1) — User Preferences vocabulary
  createUserPreference,
  getUserPreferences,
  getUserPreferenceById,
  removeUserPreference,
  // Aria Intelligence System (Phase 2) — Inferred Rules
  upsertInferredRule,
  getInferredRulesForUser,
  getAllUserIds,
  getUserByWhatsAppPhone,
  normalizeWhatsAppPhone,
  mintWhatsAppVerification,
  consumeWhatsAppVerification,
  setVerifiedWhatsAppPhone,
  clearUserWhatsAppPhone,
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
  getUsersWithMorningBriefEnabled,
  checkAndLockMorningBriefSent,
  checkAndLockDailyWrapWeb,
  getUsersWithDailyWrapEnabled,
  checkAndLockDailyWrapSent,
  markScheduledAlertFired,
  incrementAlertAttempt,
  SCHEDULED_ALERT_MAX_ATTEMPTS,
  DEFAULT_CADENCE_CONFIGS,
  getCalendarNote,
  upsertCalendarNote,
  upsertCalendarNotePost,
  getCalendarNotesHistory,
  getCalendarNotesForAI,
  getRecentlyEndedEventsForAlerts,
  markCalendarNoteAlertSent,
  getWhatsAppHistory,
  saveWhatsAppMessage,
  getUserIntegration,
  getUserIntegrations,
  getUserIntegrationsByType,
  getUserIntegrationById,
  getGmailIntegrationByEmail,
  upsertUserIntegration,
  deleteUserIntegration,
  deleteUserIntegrationById,
  upsertQbConnection,
  getQbConnectionsByUser,
  getQbConnectionById,
  updateQbConnectionTokens,
  deleteQbConnectionById,
  getAllQbConnections,
  upsertQbSnapshot,
  getLatestQbSnapshotsForUser,
  getQbSnapshotHistory,
  upsertQbTransactions,
  getQbTransactionsForUser,
  backfillSuperadminIntegrationsFromEnv,
  getUserSetting,
  getUserSettings,
  upsertUserSetting,
  deleteUserSetting,
  backfillSuperadminSettingsFromGlobal,
  logAgentAction,
  createPendingConfirmation,
  deletePendingConfirmation,
  getPendingConfirmation,
  updatePendingConfirmationStatus,
  findLatestPendingConfirmation,
  cleanupPendingConfirmations,
  getConfirmationChannel,
  getConfirmationById,
  notifyConfirmation,
  listenForConfirmation,
  createOrUpdateLearning,
  getUserLearnings,
  deactivateLearning,
  getRules,
  createRule,
  updateRule,
  deleteRule,
  getClassification,
  upsertClassification,
  batchGetClassifications,
  getClassificationsByEntity,
  getImportantUnread,
  getRecentClassifications,
  getEmailCleanPolicy,
  upsertEmailCleanPolicy,
  // Classification feedback loop
  insertClassificationFeedback,
  hasExistingFeedback,
  getClassificationFeedbackByPattern,
  getPositiveFeedbackCount,
  upsertInferredClassificationRule,
  getActiveInferredClassificationRules,
  decayInferredClassificationRules,
  getOpenPendingConfirmations,
  // Active Zone
  upsertActiveZoneTile,
  getActiveZoneTiles,
  getActiveZoneTileById,
  updateActiveZoneTileStatus,
  resolveStaleActiveZoneTiles,
  rependElapsedActiveZoneTiles,
  getHiddenActiveZoneCandidateKeys,
  getActiveZoneMetrics,
};
