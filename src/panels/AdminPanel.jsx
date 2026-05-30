import { useState, useEffect, useCallback } from 'react';

const API_BASE = '';

export default function AdminPanel({ authToken }) {
  const [tab, setTab] = useState('orgs');
  const [orgs, setOrgs] = useState([]);
  const [users, setUsers] = useState([]);
  const [auditLog, setAuditLog] = useState([]);
  const [auditPage, setAuditPage] = useState(1);
  const [memories, setMemories] = useState([]);
  const [memoryUserFilter, setMemoryUserFilter] = useState('');
  const [memoryPage, setMemoryPage] = useState(1);
  // Phase 5 — Aria decisions visibility
  const [decisions, setDecisions] = useState([]);
  // AZ8 — Active Zone metrics
  const [azMetrics, setAzMetrics] = useState(null);
  const [azWindow, setAzWindow] = useState(24);
  const [trustMatrix, setTrustMatrix] = useState([]);
  const [corrections, setCorrections] = useState([]);
  const [decisionsUserFilter, setDecisionsUserFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Org modal state
  const [showCreateOrg, setShowCreateOrg] = useState(false);
  const [newOrg, setNewOrg] = useState({ name: '', type: 'household', adminEmail: '' });

  // User create state
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [newUser, setNewUser] = useState({ username: '', displayName: '', email: '', password: '', role: 'member', orgId: '' });

  // Inline edit state
  const [editingUser, setEditingUser] = useState(null); // { id, field: 'password'|'email'|'org', value: '' }

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` };

  const fetchOrgs = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/admin/orgs`, { headers });
      if (res.ok) setOrgs(await res.json());
    } catch {}
  }, [authToken]);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/admin/users`, { headers });
      if (res.ok) setUsers(await res.json());
    } catch {}
  }, [authToken]);

  const fetchAuditLog = useCallback(async (page = 1) => {
    try {
      const res = await fetch(`${API_BASE}/api/admin/audit-log?page=${page}`, { headers });
      if (res.ok) setAuditLog(await res.json());
    } catch {}
  }, [authToken]);

  const fetchMemories = useCallback(async (page = 1, userId = '') => {
    try {
      const params = new URLSearchParams({ page });
      if (userId) params.set('userId', userId);
      const res = await fetch(`${API_BASE}/api/admin/memory?${params}`, { headers });
      if (res.ok) setMemories(await res.json());
    } catch {}
  }, [authToken]);

  const fetchDecisionsBundle = useCallback(async (userId = '') => {
    const qs = userId ? `?userId=${encodeURIComponent(userId)}` : '';
    try {
      const [d, t, c] = await Promise.all([
        fetch(`${API_BASE}/api/admin/decisions${qs}`, { headers }).then((r) => r.ok ? r.json() : []),
        fetch(`${API_BASE}/api/admin/trust-matrix${qs}`, { headers }).then((r) => r.ok ? r.json() : []),
        fetch(`${API_BASE}/api/admin/corrections${qs}`, { headers }).then((r) => r.ok ? r.json() : []),
      ]);
      setDecisions(d); setTrustMatrix(t); setCorrections(c);
    } catch {}
  }, [authToken]);

  useEffect(() => {
    if (tab === 'orgs') fetchOrgs();
    else if (tab === 'users') { fetchUsers(); fetchOrgs(); }
    else if (tab === 'audit') fetchAuditLog(auditPage);
    else if (tab === 'memory') { fetchUsers(); fetchMemories(memoryPage, memoryUserFilter); }
    else if (tab === 'decisions') { fetchUsers(); fetchDecisionsBundle(decisionsUserFilter); }
    else if (tab === 'activeZone') {
      (async () => {
        try {
          const r = await fetch(`${API_BASE}/api/admin/active-zone/metrics?sinceHours=${azWindow}`, { headers });
          if (r.ok) setAzMetrics(await r.json()); else setAzMetrics(null);
        } catch { setAzMetrics(null); }
      })();
    }
  }, [tab, auditPage, memoryPage, memoryUserFilter, decisionsUserFilter, azWindow]);

  async function handleCreateOrg(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/api/admin/orgs`, {
        method: 'POST', headers,
        body: JSON.stringify(newOrg),
      });
      if (!res.ok) { const d = await res.json(); setError(d.error); return; }
      setShowCreateOrg(false);
      setNewOrg({ name: '', type: 'household', adminEmail: '' });
      fetchOrgs();
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }

  async function suspendOrg(id) {
    await fetch(`${API_BASE}/api/admin/orgs/${id}/suspend`, { method: 'PUT', headers });
    fetchOrgs();
  }

  async function suspendUser(id) {
    await fetch(`${API_BASE}/api/admin/users/${id}/suspend`, { method: 'PUT', headers });
    fetchUsers();
  }

  async function deleteUser(id, displayName) {
    if (!window.confirm(`Delete ${displayName}? This cannot be undone.`)) return;
    try {
      const res = await fetch(`${API_BASE}/api/admin/users/${id}`, { method: 'DELETE', headers });
      if (!res.ok) { const d = await res.json(); setError(d.error); return; }
      fetchUsers();
    } catch (err) { setError(err.message); }
  }

  async function deleteMemory(id) {
    if (!window.confirm('Delete this memory entry?')) return;
    await fetch(`${API_BASE}/api/admin/memory/${id}`, { method: 'DELETE', headers });
    fetchMemories(memoryPage, memoryUserFilter);
  }

  // Clear date-keyed user-data caches that aren't namespaced per user.
  // Without this, the admin's cached Aria messages, daily digest, and
  // unsent chat draft bleed into the impersonated session — and back
  // into the admin's session on exit. Mirrors handleLogin/handleLogout
  // in App.jsx.
  function clearUserScopedCaches() {
    try {
      Object.keys(localStorage).forEach((key) => {
        if (key.startsWith('cc_messages_') || key.startsWith('timeline_summary_') || key.startsWith('digest_')) {
          localStorage.removeItem(key);
        }
      });
      localStorage.removeItem('tm_chat_draft');
      localStorage.removeItem('qc_lastPillar');
    } catch {}
  }

  async function impersonateUser(userId) {
    try {
      const res = await fetch(`${API_BASE}/api/admin/impersonate/${userId}`, { method: 'POST', headers });
      if (!res.ok) return;
      const data = await res.json();
      localStorage.setItem('tm_impersonation_token', localStorage.getItem('tm_token'));
      localStorage.setItem('tm_token', data.token);
      localStorage.setItem('tm_user', JSON.stringify(data.user));
      clearUserScopedCaches();
      window.location.reload();
    } catch {}
  }

  async function handleCreateUser(e) {
    e.preventDefault();
    if (!newUser.username.trim() || !newUser.password) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/api/admin/users`, {
        method: 'POST', headers,
        body: JSON.stringify(newUser),
      });
      if (!res.ok) { const d = await res.json(); setError(d.error); return; }
      setShowCreateUser(false);
      setNewUser({ username: '', displayName: '', email: '', password: '', role: 'member', orgId: '' });
      fetchUsers();
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }

  async function handleInlineAction() {
    if (!editingUser) return;
    const { id, field, value } = editingUser;
    setLoading(true);
    setError('');
    try {
      let url, body;
      if (field === 'password') {
        url = `${API_BASE}/api/admin/users/${id}/password`;
        body = { password: value };
      } else if (field === 'email') {
        url = `${API_BASE}/api/admin/users/${id}/email`;
        body = { email: value };
      } else if (field === 'org') {
        url = `${API_BASE}/api/admin/users/${id}/org`;
        body = { orgId: value, role: 'member' };
      }
      const res = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(body) });
      if (!res.ok) { const d = await res.json(); setError(d.error); return; }
      setEditingUser(null);
      fetchUsers();
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }

  const isImpersonating = !!localStorage.getItem('tm_impersonation_token');

  function exitImpersonation() {
    const originalToken = localStorage.getItem('tm_impersonation_token');
    if (originalToken) {
      localStorage.setItem('tm_token', originalToken);
      localStorage.removeItem('tm_impersonation_token');
      clearUserScopedCaches();
      window.location.reload();
    }
  }

  const tabClass = (t) =>
    `px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
      tab === t ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-container'
    }`;

  return (
    <div className="max-w-5xl mx-auto p-6">
      {isImpersonating && (
        <div className="mb-4 bg-warning-surface border border-warning text-warning px-4 py-3 rounded-xl flex items-center justify-between">
          <span className="text-sm font-medium flex items-center gap-2">
            <span className="material-symbols-outlined text-lg">visibility</span>
            You are impersonating another user
          </span>
          <button onClick={exitImpersonation} className="text-sm font-medium text-warning hover:opacity-80 underline">
            Exit Impersonation
          </button>
        </div>
      )}

      <div className="flex items-center gap-3 mb-6">
        <span className="material-symbols-outlined text-2xl text-primary">admin_panel_settings</span>
        <h1 className="text-xl font-bold text-on-surface" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>Super Admin</h1>
      </div>

      <div className="flex flex-nowrap gap-2 mb-6 overflow-x-auto">
        <button onClick={() => setTab('orgs')} className={tabClass('orgs')}>Organizations</button>
        <button onClick={() => setTab('users')} className={tabClass('users')}>Users</button>
        <button onClick={() => setTab('audit')} className={tabClass('audit')}>Audit Log</button>
        <button onClick={() => setTab('memory')} className={tabClass('memory')}>Memory</button>
        <button onClick={() => setTab('decisions')} className={tabClass('decisions')}>Decisions</button>
        <button onClick={() => setTab('activeZone')} className={tabClass('activeZone')}>Active Zone</button>
      </div>

      {error && <div className="mb-4 bg-danger-surface border border-danger text-danger text-sm px-3 py-2 rounded-lg">{error}</div>}

      {/* Organizations Tab */}
      {tab === 'orgs' && (
        <div>
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-sm font-semibold text-on-surface-variant uppercase tracking-wide">Organizations</h2>
            <button onClick={() => setShowCreateOrg(true)} className="px-3 py-1.5 bg-primary text-on-primary text-sm rounded-lg hover:bg-primary transition-colors flex items-center gap-1">
              <span className="material-symbols-outlined text-base">add</span> Create Org + Invite Admin
            </button>
          </div>

          {showCreateOrg && (
            <form onSubmit={handleCreateOrg} className="mb-4 bg-surface border border-outline-variant rounded-xl p-4 space-y-3">
              <input type="text" placeholder="Organization name" value={newOrg.name} onChange={(e) => setNewOrg({ ...newOrg, name: e.target.value })} required className="w-full px-3 py-2 bg-surface-container-lowest border border-outline-variant rounded-lg text-sm" />
              <select value={newOrg.type} onChange={(e) => setNewOrg({ ...newOrg, type: e.target.value })} className="w-full px-3 py-2 bg-surface-container-lowest border border-outline-variant rounded-lg text-sm">
                <option value="household">Household</option>
                <option value="business">Business</option>
                <option value="team">Team</option>
              </select>
              <input type="email" placeholder="Admin email (for invite)" value={newOrg.adminEmail} onChange={(e) => setNewOrg({ ...newOrg, adminEmail: e.target.value })} className="w-full px-3 py-2 bg-surface-container-lowest border border-outline-variant rounded-lg text-sm" />
              <div className="flex gap-2">
                <button type="submit" disabled={loading} className="px-4 py-2 bg-primary text-on-primary text-sm rounded-lg disabled:opacity-50">Create</button>
                <button type="button" onClick={() => setShowCreateOrg(false)} className="px-4 py-2 text-on-surface-variant text-sm">Cancel</button>
              </div>
            </form>
          )}

          <div className="bg-surface-container-lowest rounded-xl border border-outline-variant overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="bg-surface-container-low text-on-surface-variant text-xs uppercase">
                <th className="px-4 py-3 text-left">Name</th>
                <th className="px-4 py-3 text-left">Type</th>
                <th className="px-4 py-3 text-center">Members</th>
                <th className="px-4 py-3 text-left">Created</th>
                <th className="px-4 py-3 text-center">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr></thead>
              <tbody>
                {orgs.map((org) => (
                  <tr key={org.id} className="border-t border-outline-variant">
                    <td className="px-4 py-3 font-medium text-on-surface">{org.name}</td>
                    <td className="px-4 py-3 text-on-surface-variant">{org.type}</td>
                    <td className="px-4 py-3 text-center text-on-surface-variant">{org.memberCount}</td>
                    <td className="px-4 py-3 text-on-surface-variant">{new Date(org.createdAt).toLocaleDateString()}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-block px-2 py-0.5 text-xs rounded-full ${org.active ? 'bg-success-surface text-success' : 'bg-danger-surface text-danger'}`}>
                        {org.active ? 'Active' : 'Suspended'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {org.active && (
                        <button onClick={() => suspendOrg(org.id)} className="text-xs text-danger hover:opacity-80 font-medium">Suspend</button>
                      )}
                    </td>
                  </tr>
                ))}
                {orgs.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-text-faint">No organizations</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Users Tab */}
      {tab === 'users' && (
        <div>
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-sm font-semibold text-on-surface-variant uppercase tracking-wide">Users</h2>
            <button onClick={() => setShowCreateUser(true)} className="px-3 py-1.5 bg-primary text-on-primary text-sm rounded-lg hover:bg-primary transition-colors flex items-center gap-1">
              <span className="material-symbols-outlined text-base">add</span> Create User
            </button>
          </div>

          {showCreateUser && (
            <form onSubmit={handleCreateUser} className="mb-4 bg-surface border border-outline-variant rounded-xl p-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <input type="text" placeholder="Username *" value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} required className="px-3 py-2 bg-surface-container-lowest border border-outline-variant rounded-lg text-sm" />
                <input type="text" placeholder="Display name" value={newUser.displayName} onChange={(e) => setNewUser({ ...newUser, displayName: e.target.value })} className="px-3 py-2 bg-surface-container-lowest border border-outline-variant rounded-lg text-sm" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <input type="email" placeholder="Email" value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} className="px-3 py-2 bg-surface-container-lowest border border-outline-variant rounded-lg text-sm" />
                <input type="password" placeholder="Password *" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} required className="px-3 py-2 bg-surface-container-lowest border border-outline-variant rounded-lg text-sm" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <select value={newUser.role} onChange={(e) => setNewUser({ ...newUser, role: e.target.value })} className="px-3 py-2 bg-surface-container-lowest border border-outline-variant rounded-lg text-sm">
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
                <select value={newUser.orgId} onChange={(e) => setNewUser({ ...newUser, orgId: e.target.value })} className="px-3 py-2 bg-surface-container-lowest border border-outline-variant rounded-lg text-sm">
                  <option value="">No org</option>
                  {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </div>
              <div className="flex gap-2">
                <button type="submit" disabled={loading} className="px-4 py-2 bg-primary text-on-primary text-sm rounded-lg disabled:opacity-50">Create</button>
                <button type="button" onClick={() => setShowCreateUser(false)} className="px-4 py-2 text-on-surface-variant text-sm">Cancel</button>
              </div>
            </form>
          )}

          <div className="bg-surface-container-lowest rounded-xl border border-outline-variant overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="bg-surface-container-low text-on-surface-variant text-xs uppercase">
                <th className="px-4 py-3 text-left">Name</th>
                <th className="px-4 py-3 text-left">Email</th>
                <th className="px-4 py-3 text-left">Role</th>
                <th className="px-4 py-3 text-left">Org</th>
                <th className="px-4 py-3 text-center">Status</th>
                <th className="px-4 py-3 text-left">Last Active</th>
                <th className="px-4 py-3 text-left">Joined</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr></thead>
              <tbody>
                {users.map((u) => {
                  const lastActiveRaw = u.lastLogin || u.last_login || u.updatedAt || u.updated_at;
                  const lastActive = lastActiveRaw ? new Date(lastActiveRaw).toLocaleDateString('en-US') : '\u2014';
                  const joined = u.createdAt || u.created_at;
                  const joinedStr = joined ? new Date(joined).toLocaleDateString('en-US') : '\u2014';
                  return (
                  <>
                    <tr key={u.id} className="border-t border-outline-variant">
                      <td className="px-4 py-3 font-medium text-on-surface">{u.displayName || u.username}</td>
                      <td className="px-4 py-3 text-on-surface-variant">{u.email || '-'}</td>
                      <td className="px-4 py-3 text-on-surface-variant">{u.role}</td>
                      <td className="px-4 py-3 text-on-surface-variant">{u.orgName || '-'}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`inline-block px-2 py-0.5 text-xs rounded-full ${u.active ? 'bg-success-surface text-success' : 'bg-danger-surface text-danger'}`}>
                          {u.active ? 'Active' : 'Suspended'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-on-surface-variant">{lastActive}</td>
                      <td className="px-4 py-3 text-on-surface-variant">{joinedStr}</td>
                      <td className="px-4 py-3 text-right space-x-2">
                        <button onClick={() => setEditingUser({ id: u.id, field: 'email', value: u.email || '' })} className="text-xs text-on-surface-variant hover:text-on-surface font-medium">Email</button>
                        <button onClick={() => setEditingUser({ id: u.id, field: 'password', value: '' })} className="text-xs text-on-surface-variant hover:text-on-surface font-medium">Password</button>
                        <button onClick={() => setEditingUser({ id: u.id, field: 'org', value: '' })} className="text-xs text-on-surface-variant hover:text-on-surface font-medium">Org</button>
                        <button onClick={() => impersonateUser(u.id)} className="text-xs text-primary hover:opacity-80 font-medium">Impersonate</button>
                        {u.active && (
                          <button onClick={() => suspendUser(u.id)} className="text-xs text-danger hover:opacity-80 font-medium">Suspend</button>
                        )}
                        {u.role !== 'superadmin' && (
                          <button onClick={() => deleteUser(u.id, u.displayName || u.username)} className="text-xs text-danger hover:opacity-80 font-medium">Delete</button>
                        )}
                      </td>
                    </tr>
                    {editingUser?.id === u.id && (
                      <tr key={`${u.id}-edit`} className="bg-surface-container-low">
                        <td colSpan={8} className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <span className="text-xs font-medium text-on-surface-variant uppercase w-16">
                              {editingUser.field === 'password' ? 'New pw' : editingUser.field === 'email' ? 'Email' : 'Org'}
                            </span>
                            {editingUser.field === 'org' ? (
                              <select
                                value={editingUser.value}
                                onChange={(e) => setEditingUser({ ...editingUser, value: e.target.value })}
                                className="flex-1 px-3 py-1.5 bg-surface-container-lowest border border-outline-variant rounded-lg text-sm"
                              >
                                <option value="">Select org...</option>
                                {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                              </select>
                            ) : (
                              <input
                                type={editingUser.field === 'password' ? 'password' : 'text'}
                                value={editingUser.value}
                                onChange={(e) => setEditingUser({ ...editingUser, value: e.target.value })}
                                placeholder={editingUser.field === 'password' ? 'New password (min 4 chars)' : 'Email address'}
                                className="flex-1 px-3 py-1.5 bg-surface-container-lowest border border-outline-variant rounded-lg text-sm"
                                autoFocus
                              />
                            )}
                            <button
                              onClick={handleInlineAction}
                              disabled={!editingUser.value || loading}
                              className="px-3 py-1.5 bg-primary text-on-primary text-xs rounded-lg disabled:opacity-50"
                            >Save</button>
                            <button onClick={() => setEditingUser(null)} className="px-3 py-1.5 text-on-surface-variant text-xs">Cancel</button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                  );
                })}
                {users.length === 0 && <tr><td colSpan={8} className="px-4 py-8 text-center text-text-faint">No users</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Audit Log Tab */}
      {tab === 'audit' && (
        <div>
          <h2 className="text-sm font-semibold text-on-surface-variant uppercase tracking-wide mb-4">Audit Log</h2>
          <div className="bg-surface-container-lowest rounded-xl border border-outline-variant overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="bg-surface-container-low text-on-surface-variant text-xs uppercase">
                <th className="px-4 py-3 text-left">Timestamp</th>
                <th className="px-4 py-3 text-left">Action</th>
                <th className="px-4 py-3 text-left">Target</th>
                <th className="px-4 py-3 text-left">Performed By</th>
              </tr></thead>
              <tbody>
                {auditLog.map((entry) => (
                  <tr key={entry.id} className="border-t border-outline-variant">
                    <td className="px-4 py-3 text-on-surface-variant">{new Date(entry.createdAt).toLocaleString()}</td>
                    <td className="px-4 py-3 font-medium text-on-surface">{entry.action}</td>
                    <td className="px-4 py-3 text-on-surface-variant">{entry.targetType ? `${entry.targetType}/${entry.targetId}` : '-'}</td>
                    <td className="px-4 py-3 text-on-surface-variant">{entry.superAdminUserId}</td>
                  </tr>
                ))}
                {auditLog.length === 0 && <tr><td colSpan={4} className="px-4 py-8 text-center text-text-faint">No audit entries</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="flex justify-center gap-2 mt-4">
            <button onClick={() => setAuditPage((p) => Math.max(1, p - 1))} disabled={auditPage <= 1} className="px-3 py-1.5 text-sm text-on-surface-variant bg-surface-container rounded-lg disabled:opacity-50">Prev</button>
            <span className="px-3 py-1.5 text-sm text-on-surface-variant">Page {auditPage}</span>
            <button onClick={() => { if (auditLog.length === 20) setAuditPage((p) => p + 1); }} disabled={auditLog.length < 20} className="px-3 py-1.5 text-sm text-on-surface-variant bg-surface-container rounded-lg disabled:opacity-50">Next</button>
          </div>
        </div>
      )}

      {/* Memory Tab */}
      {tab === 'memory' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-on-surface uppercase tracking-wide">Agent Memory</h3>
            <div className="flex items-center gap-2">
              <select
                value={memoryUserFilter}
                onChange={(e) => { setMemoryUserFilter(e.target.value); setMemoryPage(1); fetchMemories(1, e.target.value); }}
                className="text-xs px-2 py-1.5 border border-outline-variant rounded-lg bg-surface-container-lowest"
              >
                <option value="">All users</option>
                {users.map(u => (
                  <option key={u.id} value={u.id}>{u.displayName || u.username}</option>
                ))}
              </select>
            </div>
          </div>
          {(() => {
            // Server pages at 20/row now; client just renders what came back.
            const pageRows = memories;
            return (
              <>
                <div className="bg-surface-container-lowest rounded-xl border border-outline-variant overflow-hidden" style={{ maxHeight: '600px', overflowY: 'auto' }}>
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 z-10">
                      <tr className="bg-surface-container-low text-on-surface-variant text-xs uppercase">
                        <th className="px-4 py-3 text-left">User</th>
                        <th className="px-4 py-3 text-left">When</th>
                        <th className="px-4 py-3 text-left">Tool</th>
                        <th className="px-4 py-3 text-left">Memory</th>
                        <th className="px-4 py-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageRows.map((m) => (
                        <tr key={m.id} className="border-t border-outline-variant hover:bg-surface-container-low">
                          <td className="px-4 py-3 text-on-surface font-medium whitespace-nowrap">{m.displayName || m.username}</td>
                          <td className="px-4 py-3 text-on-surface-variant whitespace-nowrap text-xs">
                            {new Date(m.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}{' '}
                            {new Date(m.createdAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                          </td>
                          <td className="px-4 py-3">
                            {m.tool && (
                              <span className="inline-block px-2 py-0.5 text-[10px] font-bold rounded-full bg-accent-surface text-primary uppercase tracking-wide">
                                {m.tool.replace('_', ' ')}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-on-surface">{m.content}</td>
                          <td className="px-4 py-3 text-right">
                            <button
                              onClick={() => deleteMemory(m.id)}
                              className="text-xs text-danger hover:opacity-80 font-medium"
                            >
                              Delete
                            </button>
                          </td>
                        </tr>
                      ))}
                      {memories.length === 0 && (
                        <tr><td colSpan={5} className="px-4 py-8 text-center text-text-faint">No memories yet — tool use will populate this</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="flex justify-center gap-2 mt-4">
                  <button
                    onClick={() => setMemoryPage((p) => Math.max(1, p - 1))}
                    disabled={memoryPage <= 1}
                    className="px-3 py-1.5 text-sm text-on-surface-variant bg-surface-container rounded-lg disabled:opacity-50"
                  >Prev</button>
                  <span className="px-3 py-1.5 text-sm text-on-surface-variant">Page {memoryPage}</span>
                  <button
                    onClick={() => { if (memories.length === 20) setMemoryPage((p) => p + 1); }}
                    disabled={memories.length < 20}
                    className="px-3 py-1.5 text-sm text-on-surface-variant bg-surface-container rounded-lg disabled:opacity-50"
                  >Next</button>
                </div>
              </>
            );
          })()}
        </div>
      )}

      {/* Decisions Tab — Phase 5 Aria intelligence visibility */}
      {tab === 'decisions' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-on-surface uppercase tracking-wide">Aria Decisions</h3>
            <select
              value={decisionsUserFilter}
              onChange={(e) => setDecisionsUserFilter(e.target.value)}
              className="text-xs px-2 py-1.5 border border-outline-variant rounded-lg bg-surface-container-lowest"
            >
              <option value="">All users</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.displayName || u.username}</option>)}
            </select>
          </div>

          {/* Trust matrix */}
          <div>
            <h4 className="text-xs font-semibold text-on-surface-variant uppercase tracking-wide mb-2">Trust Matrix</h4>
            <div className="bg-surface-container-lowest rounded-xl border border-outline-variant overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-surface-container-low text-on-surface-variant text-xs uppercase">
                    <th className="px-3 py-2 text-left">User</th>
                    <th className="px-3 py-2 text-left">Action</th>
                    <th className="px-3 py-2 text-right">Score</th>
                    <th className="px-3 py-2 text-left">Disposition</th>
                    <th className="px-3 py-2 text-right">✓</th>
                    <th className="px-3 py-2 text-right">✗</th>
                    <th className="px-3 py-2 text-right">↺</th>
                  </tr>
                </thead>
                <tbody>
                  {trustMatrix.map((t) => (
                    <tr key={t.id} className="border-t border-outline-variant">
                      <td className="px-3 py-2 text-on-surface whitespace-nowrap">{t.displayName}</td>
                      <td className="px-3 py-2 text-on-surface">{t.actionType}</td>
                      <td className="px-3 py-2 text-right font-mono text-on-surface">{Number(t.trustScore).toFixed(2)}</td>
                      <td className="px-3 py-2 text-xs text-on-surface-variant">{t.disposition}</td>
                      <td className="px-3 py-2 text-right text-success">{t.timesConfirmed}</td>
                      <td className="px-3 py-2 text-right text-danger">{t.timesRejected}</td>
                      <td className="px-3 py-2 text-right text-warning">{t.timesCorrected}</td>
                    </tr>
                  ))}
                  {trustMatrix.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-text-faint">No trust data yet</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          {/* Recent decisions */}
          <div>
            <h4 className="text-xs font-semibold text-on-surface-variant uppercase tracking-wide mb-2">Recent Decisions (last 100)</h4>
            <div className="bg-surface-container-lowest rounded-xl border border-outline-variant overflow-hidden" style={{ maxHeight: '500px', overflowY: 'auto' }}>
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-surface-container-low text-on-surface-variant text-xs uppercase">
                    <th className="px-3 py-2 text-left">When</th>
                    <th className="px-3 py-2 text-left">User</th>
                    <th className="px-3 py-2 text-left">Tool</th>
                    <th className="px-3 py-2 text-left">Disposition</th>
                    <th className="px-3 py-2 text-left">Outcome</th>
                    <th className="px-3 py-2 text-right">Latency</th>
                    <th className="px-3 py-2 text-left">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {decisions.map((d) => (
                    <tr key={d.id} className="border-t border-outline-variant hover:bg-surface-container-low">
                      <td className="px-3 py-2 text-on-surface-variant whitespace-nowrap text-xs">{new Date(d.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
                      <td className="px-3 py-2 text-on-surface whitespace-nowrap">{d.displayName}</td>
                      <td className="px-3 py-2 text-on-surface">{d.toolCalled || d.actionType}</td>
                      <td className="px-3 py-2 text-xs text-on-surface-variant">{d.disposition}</td>
                      <td className={`px-3 py-2 text-xs font-medium ${d.outcome === 'rejected' ? 'text-danger' : d.outcome === 'confirmed' ? 'text-success' : 'text-on-surface-variant'}`}>{d.outcome || '—'}</td>
                      <td className="px-3 py-2 text-right text-xs text-on-surface-variant font-mono">{d.latencyMs != null ? `${d.latencyMs}ms` : '—'}</td>
                      <td className="px-3 py-2 text-xs text-on-surface-variant truncate max-w-md">{d.contextSummary || d.conflictResolution || ''}</td>
                    </tr>
                  ))}
                  {decisions.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-text-faint">No decisions yet</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          {/* Corrections + auto-generated rules */}
          <div>
            <h4 className="text-xs font-semibold text-on-surface-variant uppercase tracking-wide mb-2">Corrections (last 100)</h4>
            <div className="bg-surface-container-lowest rounded-xl border border-outline-variant overflow-hidden" style={{ maxHeight: '300px', overflowY: 'auto' }}>
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-surface-container-low text-on-surface-variant text-xs uppercase">
                    <th className="px-3 py-2 text-left">When</th>
                    <th className="px-3 py-2 text-left">User</th>
                    <th className="px-3 py-2 text-left">Action</th>
                    <th className="px-3 py-2 text-left">Type</th>
                    <th className="px-3 py-2 text-left">Note</th>
                    <th className="px-3 py-2 text-left">Generated Rule</th>
                  </tr>
                </thead>
                <tbody>
                  {corrections.map((c) => (
                    <tr key={c.id} className="border-t border-outline-variant">
                      <td className="px-3 py-2 text-on-surface-variant whitespace-nowrap text-xs">{new Date(c.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
                      <td className="px-3 py-2 text-on-surface whitespace-nowrap">{c.displayName}</td>
                      <td className="px-3 py-2 text-on-surface">{c.originalAction}</td>
                      <td className="px-3 py-2 text-xs text-on-surface-variant">{c.correctionType}</td>
                      <td className="px-3 py-2 text-xs text-on-surface-variant truncate max-w-md">{c.correctionNote || ''}</td>
                      <td className="px-3 py-2 text-xs text-primary">{c.generatedRuleId ? `#${c.generatedRuleId}` : '—'}</td>
                    </tr>
                  ))}
                  {corrections.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-text-faint">No corrections yet</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Active Zone Tab — AZ8 metrics */}
      {tab === 'activeZone' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-on-surface uppercase tracking-wide">Active Zone</h3>
            <select
              value={azWindow}
              onChange={(e) => setAzWindow(parseInt(e.target.value, 10))}
              className="text-xs px-2 py-1.5 border border-outline-variant rounded-lg bg-surface-container-lowest"
            >
              <option value={1}>Last 1 h</option>
              <option value={6}>Last 6 h</option>
              <option value={24}>Last 24 h</option>
              <option value={168}>Last 7 days</option>
            </select>
          </div>

          {!azMetrics ? (
            <div className="text-sm text-text-faint">Loading…</div>
          ) : (
            <>
              {/* Headline counters */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Stat label="Tiles composed" value={azMetrics.totalTiles} />
                <Stat label="LLM call rate"  value={`${azMetrics.llmCallRate}%`} />
                <Stat label="Cache hit rate" value={`${azMetrics.cacheHitRate}%`} sub={`${azMetrics.cache} hits`} />
                <Stat label="Fallback rate"  value={`${azMetrics.fallbackRate}%`} sub={`${azMetrics.fallback} renders`} subClass={azMetrics.fallbackRate > 10 ? 'text-danger' : 'text-on-surface-variant'} />
              </div>

              {/* Per-(candidate × source × status) breakdown */}
              <div>
                <h4 className="text-xs font-semibold text-on-surface-variant uppercase tracking-wide mb-2">Breakdown</h4>
                <div className="bg-surface-container-lowest rounded-xl border border-outline-variant overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-surface-container-low text-on-surface-variant text-xs uppercase">
                        <th className="px-3 py-2 text-left">Candidate type</th>
                        <th className="px-3 py-2 text-left">Composer source</th>
                        <th className="px-3 py-2 text-left">Status</th>
                        <th className="px-3 py-2 text-right">N</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(azMetrics.breakdown || []).map((r, i) => (
                        <tr key={i} className="border-t border-outline-variant">
                          <td className="px-3 py-2 text-on-surface">{r.candidateType}</td>
                          <td className="px-3 py-2 text-xs"><SourceBadge source={r.composerSource} /></td>
                          <td className="px-3 py-2 text-xs text-on-surface-variant">{r.status}</td>
                          <td className="px-3 py-2 text-right font-mono text-on-surface">{r.n}</td>
                        </tr>
                      ))}
                      {(!azMetrics.breakdown || !azMetrics.breakdown.length) && (
                        <tr><td colSpan={4} className="px-3 py-6 text-center text-text-faint">No tile activity in window</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, sub, subClass }) {
  return (
    <div className="bg-surface-container-lowest border border-outline-variant rounded-xl p-3">
      <div className="text-[10px] uppercase tracking-wider text-on-surface-variant font-semibold">{label}</div>
      <div className="text-2xl font-bold text-on-surface mt-1">{value}</div>
      {sub && <div className={`text-[11px] mt-0.5 ${subClass || 'text-on-surface-variant'}`}>{sub}</div>}
    </div>
  );
}

function SourceBadge({ source }) {
  const styles = {
    llm:      'bg-accent-surface text-primary border-primary',
    cache:    'bg-success-surface text-success border-success',
    fallback: 'bg-warning-surface text-warning border-warning',
  };
  const cls = styles[source] || 'bg-surface-container-low text-on-surface-variant border-outline-variant';
  return <span className={`inline-block px-2 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-wide ${cls}`}>{source || 'unknown'}</span>;
}
