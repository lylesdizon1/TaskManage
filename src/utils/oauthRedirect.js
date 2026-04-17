// Validate OAuth provider redirect URLs before navigating to them.
// Defends against open-redirect via a compromised or buggy backend that
// returns an attacker-controlled URL from /api/*/auth-url.
//
// Allowlist is hostname-exact (not startsWith on the full URL) to avoid
// confusion attacks like https://accounts.google.com.attacker.com.

const ALLOWED_HOSTS = new Set([
  'accounts.google.com',
  'login.microsoftonline.com',
]);

export function isValidOAuthUrl(url) {
  if (!url || typeof url !== 'string') return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'https:') return false;
  return ALLOWED_HOSTS.has(parsed.hostname);
}
