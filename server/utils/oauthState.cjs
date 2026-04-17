'use strict';

/**
 * server/utils/oauthState.cjs — CSRF-safe OAuth state tokens.
 *
 * Replaces the legacy "state = userId" pattern, which let an attacker
 * craft a callback URL pointing at any victim's userId and bind tokens
 * to the wrong account (classic OAuth login-CSRF).
 *
 * mintState(userId) issues a cryptographically random 64-char token,
 * stores {state -> userId} in Redis with a 10-min TTL, and returns the
 * token. consumeState(state) fetches and deletes (one-time use) and
 * returns the bound userId — or null if the token is unknown, expired,
 * or already consumed.
 *
 * Fails closed: if Redis is unavailable, mintState throws (so the
 * auth-url endpoint surfaces a 500 to the user) and consumeState
 * returns null (so the callback rejects). Cache-style "best effort"
 * is the wrong default for a security control.
 */

const crypto = require('crypto');
const { getRedisClient } = require('../lib/redis.cjs');

const KEY_PREFIX = 'oauth:state:';
const TTL_SECONDS = 600; // 10 minutes — covers normal consent flows + slow typers

async function mintState(userId) {
  if (userId === undefined || userId === null) {
    throw new Error('mintState requires a userId');
  }
  const client = await getRedisClient();
  if (!client) {
    throw new Error('Redis unavailable; cannot mint OAuth state token');
  }
  const state = crypto.randomBytes(32).toString('hex');
  await client.set(`${KEY_PREFIX}${state}`, JSON.stringify({ userId }), { EX: TTL_SECONDS });
  return state;
}

async function consumeState(state) {
  if (!state || typeof state !== 'string') return null;
  const client = await getRedisClient();
  if (!client) return null;
  const key = `${KEY_PREFIX}${state}`;
  let raw;
  try {
    raw = await client.get(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  try { await client.del(key); } catch { /* TTL will reap it */ }
  try {
    const parsed = JSON.parse(raw);
    return parsed.userId ?? null;
  } catch {
    return null;
  }
}

module.exports = { mintState, consumeState };
