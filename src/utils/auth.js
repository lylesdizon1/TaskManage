/** Decode a JWT payload without a library (base64url decode the middle section). */
export function decodeJwtPayload(token) {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(base64));
  } catch { return null; }
}

/** Returns true if the token expires within `thresholdSeconds` (default 7 days). */
export function tokenExpiresSoon(token, thresholdSeconds = 7 * 86400) {
  const payload = decodeJwtPayload(token);
  if (!payload || !payload.exp) return false;
  return payload.exp - Date.now() / 1000 < thresholdSeconds;
}
