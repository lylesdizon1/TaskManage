import { useEffect } from 'react';

export function useAuthLogout(onLogout) {
  useEffect(() => {
    const handler = () => {
      console.warn('[Auth] Session expired — logging out');
      onLogout();
    };
    window.addEventListener('auth:logout', handler);
    return () => window.removeEventListener('auth:logout', handler);
  }, [onLogout]);
}
