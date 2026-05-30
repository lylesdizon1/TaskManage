import { useState, useEffect } from 'react';

const API_BASE = '';

export default function LoginScreen({ onLogin }) {
  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Invite state
  const [inviteToken, setInviteToken] = useState('');
  const [inviteInfo, setInviteInfo] = useState(null); // { orgName, role, email }
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteError, setInviteError] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (token) {
      setInviteToken(token);
      setMode('register');
      setInviteLoading(true);
      fetch(`${API_BASE}/api/invites/${token}`)
        .then((res) => res.json())
        .then((data) => {
          if (data.error) {
            setInviteError(data.error);
          } else {
            setInviteInfo(data);
          }
        })
        .catch(() => setInviteError('Unable to verify invite'))
        .finally(() => setInviteLoading(false));
    }
  }, []);

  async function handleLogin(e) {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Login failed');
        return;
      }
      localStorage.setItem('tm_token', data.token);
      localStorage.setItem('tm_user', JSON.stringify(data.user));
      onLogin(data.user, data.token);
    } catch {
      setError('Unable to connect to server');
    } finally {
      setLoading(false);
    }
  }

  async function handleRegister(e) {
    e.preventDefault();
    if (!username.trim() || !password || !inviteToken) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: inviteToken, username: username.trim(), password, displayName: displayName.trim() || username.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Registration failed');
        return;
      }
      localStorage.setItem('tm_token', data.token);
      localStorage.setItem('tm_user', JSON.stringify(data.user));
      onLogin(data.user, data.token);
    } catch {
      setError('Unable to connect to server');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-surface-container-low flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-14 h-14 bg-primary rounded-2xl flex items-center justify-center shadow-lg mx-auto mb-4">
            <svg className="w-7 h-7 text-on-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-on-surface">Dizon.ai</h1>
          <p className="text-sm text-on-surface-variant mt-1">Life OS for high performers</p>
        </div>

        {mode === 'login' ? (
          <form onSubmit={handleLogin} className="bg-surface-container-lowest rounded-2xl shadow-sm border border-outline-variant p-6 space-y-4">
            {error && (
              <div className="bg-danger-surface border border-danger text-danger text-sm px-3 py-2 rounded-lg">
                {error}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-on-surface mb-1.5">Username</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Enter username"
                autoFocus
                autoComplete="username"
                className="w-full px-3 py-2.5 bg-surface-container-low border border-outline-variant rounded-lg text-sm text-on-surface placeholder:text-text-faint focus:outline-none focus:ring-2 focus:ring-primary focus:bg-surface-container-lowest transition"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-on-surface mb-1.5">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password"
                autoComplete="current-password"
                className="w-full px-3 py-2.5 bg-surface-container-low border border-outline-variant rounded-lg text-sm text-on-surface placeholder:text-text-faint focus:outline-none focus:ring-2 focus:ring-primary focus:bg-surface-container-lowest transition"
              />
            </div>

            <button
              type="submit"
              disabled={loading || !username.trim() || !password}
              className="w-full px-4 py-2.5 bg-primary text-on-primary rounded-xl hover:bg-primary font-medium text-sm transition-colors shadow-sm disabled:opacity-50"
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>
        ) : (
          <div className="bg-surface-container-lowest rounded-2xl shadow-sm border border-outline-variant p-6 space-y-4">
            {inviteLoading ? (
              <p className="text-sm text-on-surface-variant text-center">Verifying invite...</p>
            ) : inviteError || !inviteInfo ? (
              <div className="text-center space-y-3">
                <div className="bg-warning-surface border border-warning text-warning text-sm px-3 py-2 rounded-lg">
                  {inviteError || 'Registration is invite-only. Please use your invite link.'}
                </div>
                <button
                  onClick={() => { setMode('login'); setError(''); }}
                  className="text-sm text-primary hover:opacity-80 font-medium"
                >
                  Back to Sign In
                </button>
              </div>
            ) : (
              <form onSubmit={handleRegister} className="space-y-4">
                <div className="bg-accent-surface border border-primary text-primary text-sm px-3 py-2 rounded-lg text-center">
                  You&rsquo;ve been invited to join <strong>{inviteInfo.orgName}</strong> as <strong>{inviteInfo.role}</strong>
                </div>

                {error && (
                  <div className="bg-danger-surface border border-danger text-danger text-sm px-3 py-2 rounded-lg">
                    {error}
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-on-surface mb-1.5">Display Name</label>
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Your name"
                    className="w-full px-3 py-2.5 bg-surface-container-low border border-outline-variant rounded-lg text-sm text-on-surface placeholder:text-text-faint focus:outline-none focus:ring-2 focus:ring-primary focus:bg-surface-container-lowest transition"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-on-surface mb-1.5">Username</label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="Choose a username"
                    autoFocus
                    autoComplete="username"
                    className="w-full px-3 py-2.5 bg-surface-container-low border border-outline-variant rounded-lg text-sm text-on-surface placeholder:text-text-faint focus:outline-none focus:ring-2 focus:ring-primary focus:bg-surface-container-lowest transition"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-on-surface mb-1.5">Password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Choose a password"
                    autoComplete="new-password"
                    className="w-full px-3 py-2.5 bg-surface-container-low border border-outline-variant rounded-lg text-sm text-on-surface placeholder:text-text-faint focus:outline-none focus:ring-2 focus:ring-primary focus:bg-surface-container-lowest transition"
                  />
                </div>

                <div className="text-xs text-text-faint">
                  Email: {inviteInfo.email}
                </div>

                <button
                  type="submit"
                  disabled={loading || !username.trim() || !password}
                  className="w-full px-4 py-2.5 bg-primary text-on-primary rounded-xl hover:bg-primary font-medium text-sm transition-colors shadow-sm disabled:opacity-50"
                >
                  {loading ? 'Creating account...' : 'Create Account'}
                </button>

                <button
                  type="button"
                  onClick={() => { setMode('login'); setError(''); }}
                  className="w-full text-sm text-primary hover:opacity-80 font-medium"
                >
                  Already have an account? Sign In
                </button>
              </form>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
