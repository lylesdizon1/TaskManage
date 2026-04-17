'use strict';

/**
 * server/utils/timezone.cjs — single source of truth for the platform
 * default IANA timezone.
 *
 * CLAUDE.md rule 10: timezone always flows from req.user.timezone — never
 * hardcode 'America/Los_Angeles' in app logic. The auth middleware
 * guarantees req.user.timezone is populated for every authenticated
 * request (using DEFAULT_TIMEZONE as the only fallback when the user
 * row's timezone column is null).
 *
 * Cron paths use DEFAULT_TIMEZONE as a guard for the rare legacy user
 * row whose timezone is null. Anywhere else that imports this constant
 * is acting as a documented fallback site, not a hardcoded literal.
 *
 * To change the platform default, edit ONLY this file. SQL column
 * DEFAULT and SQL COALESCE clauses in db.cjs intentionally stay as
 * raw literals — those are schema-side concerns and migrations would
 * need to coordinate.
 */

const DEFAULT_TIMEZONE = 'America/Los_Angeles';

module.exports = { DEFAULT_TIMEZONE };
