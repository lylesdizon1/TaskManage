import { useEffect } from 'react';

// Listen for the event apiFetch actually dispatches when a refresh
// fails (App.jsx:75). The hook previously listened for 'auth:logout',
// which nothing ever dispatches — leaving the logout handler dead.
export function useAuthLogout(onLogout) {
  useEffect(() => {
    const handler = () => {
      console.warn('[Auth] Session expired — logging out');
      onLogout();
    };
    window.addEventListener('session-expired', handler);
    return () => window.removeEventListener('session-expired', handler);
  }, [onLogout]);
}
