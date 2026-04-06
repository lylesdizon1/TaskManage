'use strict';

const crypto = require('crypto');

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY; // Must be 32 chars

const encrypt = (text) => {
  if (!text || !ENCRYPTION_KEY) return text;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'utf8'), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
};

const decrypt = (text) => {
  if (!text || !ENCRYPTION_KEY) return text;
  try {
    const [ivHex, encrypted] = text.split(':');
    if (!ivHex || !encrypted) return text; // not encrypted, return as-is
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'utf8'), iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return text; // decryption failed (likely unencrypted legacy data), return as-is
  }
};

const encryptTokens = (tokens) => {
  if (!tokens || !ENCRYPTION_KEY) return tokens;
  return encrypt(JSON.stringify(tokens));
};

const decryptTokens = (stored) => {
  if (!stored || !ENCRYPTION_KEY) return stored;
  if (typeof stored === 'object') return stored; // already a plain object (unencrypted legacy)
  try {
    return JSON.parse(decrypt(stored));
  } catch {
    return stored; // couldn't decrypt/parse, return as-is
  }
};

module.exports = { encrypt, decrypt, encryptTokens, decryptTokens, ENCRYPTION_KEY };
