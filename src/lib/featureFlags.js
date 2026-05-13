// Centralized feature flag exports. Vite inlines import.meta.env values at
// build time, so flag flips in Railway env vars require a redeploy.
//
// Default semantics: any non-'true' string (including undefined) is false.
// Set VITE_DRAFT_NEW=true in .env.local for dev or Railway env for prod ship.

export const DRAFT_NEW = import.meta.env.VITE_DRAFT_NEW === 'true';
