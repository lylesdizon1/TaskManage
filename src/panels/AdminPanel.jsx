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

  useEffect(() => {
    if (tab === 'orgs') fetchOrgs();
    else if (tab === 'users') { fetchUsers(); fetchOrgs(); }
    else if (tab === 'audit') fetchAuditLog(auditPage);
    else if (tab === 'memory') { fetchUsers(); fetchMemories(memoryPage, memoryUserFilter); }
  }, [tab, auditPage, memoryPage, memoryUserFilter]);

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

  async function impersonateUser(userId) {
    try {
      const res = await fetch(`${API_BASE}/api/admin/impersonate/${userId}`, { method: 'POST', headers });
      if (!res.ok) return;
      const data = await res.json();
      localStorage.setItem('tm_impersonation_token', localStorage.getItem('tm_token'));
      localStorage.setItem('tm_token', data.token);
      localStorage.setItem('tm_user', JSON.stringify(data.user));
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
      window.location.reload();
    }
  }

  const tabClass = (t) =>
    `px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
      tab === t ? 'bg-[#4f4dcf] text-white' : 'text-gray-600 hover:bg-gray-100'
    }`;

  return (
    <div className="max-w-5xl mx-auto p-6">
      {isImpersonating && (
        <div className="mb-4 bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-xl flex items-center justify-between">
          <span className="text-sm font-medium flex items-center gap-2">
            <span className="material-symbols-outlined text-lg">visibility</span>
            You are impersonating another user
          </span>
          <button onClick={exitImpersonation} className="text-sm font-medium text-amber-700 hover:text-amber-900 underline">
            Exit Impersonation
          </button>
        </div>
      )}

      <div className="flex items-center gap-3 mb-6">
        <span className="material-symbols-outlined text-2xl text-[#4f4dcf]">admin_panel_settings</span>
        <h1 className="text-xl font-bold text-gray-900" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>Super Admin</h1>
      </div>

      <div className="flex flex-nowrap gap-2 mb-6 overflow-x-auto">
        <button onClick={() => setTab('orgs')} className={tabClass('orgs')}>Organizations</button>
        <button onClick={() => setTab('users')} className={tabClass('users')}>Users</button>
        <button onClick={() => setTab('audit')} className={tabClass('audit')}>Audit Log</button>
        <button onClick={() => setTab('memory')} className={tabClass('memory')}>Memory</button>
      </div>

      {error && <div className="mb-4 bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2 rounded-lg">{error}</div>}

      {/* Organizations Tab */}
      {tab === 'orgs' && (
        <div>
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Organizations</h2>
            <button onClick={() => setShowCreateOrg(true)} className="px-3 py-1.5 bg-[#4f4dcf] text-white text-sm rounded-lg hover:bg-[#3f3dbf] transition-colors flex items-center gap-1">
              <span className="material-symbols-outlined text-base">add</span> Create Org + Invite Admin
            </button>
          </div>

          {showCreateOrg && (
            <form onSubmit={handleCreateOrg} className="mb-4 bg-[#fbf8fe] border border-gray-200 rounded-xl p-4 space-y-3">
              <input type="text" placeholder="Organization name" value={newOrg.name} onChange={(e) => setNewOrg({ ...newOrg, name: e.target.value })} required className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm" />
              <select value={newOrg.type} onChange={(e) => setNewOrg({ ...newOrg, type: e.target.value })} className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm">
                <option value="household">Household</option>
                <option value="business">Business</option>
                <option value="team">Team</option>
              </select>
              <input type="email" placeholder="Admin email (for invite)" value={newOrg.adminEmail} onChange={(e) => setNewOrg({ ...newOrg, adminEmail: e.target.value })} className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm" />
              <div className="flex gap-2">
                <button type="submit" disabled={loading} className="px-4 py-2 bg-[#4f4dcf] text-white text-sm rounded-lg disabled:opacity-50">Create</button>
                <button type="button" onClick={() => setShowCreateOrg(false)} className="px-4 py-2 text-gray-600 text-sm">Cancel</button>
              </div>
            </form>
          )}

          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="bg-gray-50 text-gray-500 text-xs uppercase">
                <th className="px-4 py-3 text-left">Name</th>
                <th className="px-4 py-3 text-left">Type</th>
                <th className="px-4 py-3 text-center">Members</th>
                <th className="px-4 py-3 text-left">Created</th>
                <th className="px-4 py-3 text-center">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr></thead>
              <tbody>
                {orgs.map((org) => (
                  <tr key={org.id} className="border-t border-gray-100">
                    <td className="px-4 py-3 font-medium text-gray-900">{org.name}</td>
                    <td className="px-4 py-3 text-gray-600">{org.type}</td>
                    <td className="px-4 py-3 text-center text-gray-600">{org.memberCount}</td>
                    <td className="px-4 py-3 text-gray-500">{new Date(org.createdAt).toLocaleDateString()}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-block px-2 py-0.5 text-xs rounded-full ${org.active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                        {org.active ? 'Active' : 'Suspended'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {org.active && (
                        <button onClick={() => suspendOrg(org.id)} className="text-xs text-red-600 hover:text-red-700 font-medium">Suspend</button>
                      )}
                    </td>
                  </tr>
                ))}
                {orgs.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">No organizations</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Users Tab */}
      {tab === 'users' && (
        <div>
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Users</h2>
            <button onClick={() => setShowCreateUser(true)} className="px-3 py-1.5 bg-[#4f4dcf] text-white text-sm rounded-lg hover:bg-[#3f3dbf] transition-colors flex items-center gap-1">
              <span className="material-symbols-outlined text-base">add</span> Create User
            </button>
          </div>

          {showCreateUser && (
            <form onSubmit={handleCreateUser} className="mb-4 bg-[#fbf8fe] border border-gray-200 rounded-xl p-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <input type="text" placeholder="Username *" value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} required className="px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm" />
                <input type="text" placeholder="Display name" value={newUser.displayName} onChange={(e) => setNewUser({ ...newUser, displayName: e.target.value })} className="px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <input type="email" placeholder="Email" value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} className="px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm" />
                <input type="password" placeholder="Password *" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} required className="px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <select value={newUser.role} onChange={(e) => setNewUser({ ...newUser, role: e.target.value })} className="px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm">
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
                <select value={newUser.orgId} onChange={(e) => setNewUser({ ...newUser, orgId: e.target.value })} className="px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm">
                  <option value="">No org</option>
                  {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </div>
              <div className="flex gap-2">
                <button type="submit" disabled={loading} className="px-4 py-2 bg-[#4f4dcf] text-white text-sm rounded-lg disabled:opacity-50">Create</button>
                <button type="button" onClick={() => setShowCreateUser(false)} className="px-4 py-2 text-gray-600 text-sm">Cancel</button>
              </div>
            </form>
          )}

          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="bg-gray-50 text-gray-500 text-xs uppercase">
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
                    <tr key={u.id} className="border-t border-gray-100">
                      <td className="px-4 py-3 font-medium text-gray-900">{u.displayName || u.username}</td>
                      <td className="px-4 py-3 text-gray-600">{u.email || '-'}</td>
                      <td className="px-4 py-3 text-gray-600">{u.role}</td>
                      <td className="px-4 py-3 text-gray-600">{u.orgName || '-'}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`inline-block px-2 py-0.5 text-xs rounded-full ${u.active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                          {u.active ? 'Active' : 'Suspended'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-600">{lastActive}</td>
                      <td className="px-4 py-3 text-gray-600">{joinedStr}</td>
                      <td className="px-4 py-3 text-right space-x-2">
                        <button onClick={() => setEditingUser({ id: u.id, field: 'email', value: u.email || '' })} className="text-xs text-gray-500 hover:text-gray-700 font-medium">Email</button>
                        <button onClick={() => setEditingUser({ id: u.id, field: 'password', value: '' })} className="text-xs text-gray-500 hover:text-gray-700 font-medium">Password</button>
                        <button onClick={() => setEditingUser({ id: u.id, field: 'org', value: '' })} className="text-xs text-gray-500 hover:text-gray-700 font-medium">Org</button>
                        <button onClick={() => impersonateUser(u.id)} className="text-xs text-[#4f4dcf] hover:text-[#3f3dbf] font-medium">Impersonate</button>
                        {u.active && (
                          <button onClick={() => suspendUser(u.id)} className="text-xs text-red-600 hover:text-red-700 font-medium">Suspend</button>
                        )}
                        {u.role !== 'superadmin' && (
                          <button onClick={() => deleteUser(u.id, u.displayName || u.username)} className="text-xs text-red-600 hover:text-red-700 font-medium">Delete</button>
                        )}
                      </td>
                    </tr>
                    {editingUser?.id === u.id && (
                      <tr key={`${u.id}-edit`} className="bg-gray-50">
                        <td colSpan={8} className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <span className="text-xs font-medium text-gray-500 uppercase w-16">
                              {editingUser.field === 'password' ? 'New pw' : editingUser.field === 'email' ? 'Email' : 'Org'}
                            </span>
                            {editingUser.field === 'org' ? (
                              <select
                                value={editingUser.value}
                                onChange={(e) => setEditingUser({ ...editingUser, value: e.target.value })}
                                className="flex-1 px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-sm"
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
                                className="flex-1 px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-sm"
                                autoFocus
                              />
                            )}
                            <button
                              onClick={handleInlineAction}
                              disabled={!editingUser.value || loading}
                              className="px-3 py-1.5 bg-[#4f4dcf] text-white text-xs rounded-lg disabled:opacity-50"
                            >Save</button>
                            <button onClick={() => setEditingUser(null)} className="px-3 py-1.5 text-gray-500 text-xs">Cancel</button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                  );
                })}
                {users.length === 0 && <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-400">No users</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Audit Log Tab */}
      {tab === 'audit' && (
        <div>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-4">Audit Log</h2>
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="bg-gray-50 text-gray-500 text-xs uppercase">
                <th className="px-4 py-3 text-left">Timestamp</th>
                <th className="px-4 py-3 text-left">Action</th>
                <th className="px-4 py-3 text-left">Target</th>
                <th className="px-4 py-3 text-left">Performed By</th>
              </tr></thead>
              <tbody>
                {auditLog.map((entry) => (
                  <tr key={entry.id} className="border-t border-gray-100">
                    <td className="px-4 py-3 text-gray-500">{new Date(entry.createdAt).toLocaleString()}</td>
                    <td className="px-4 py-3 font-medium text-gray-900">{entry.action}</td>
                    <td className="px-4 py-3 text-gray-600">{entry.targetType ? `${entry.targetType}/${entry.targetId}` : '-'}</td>
                    <td className="px-4 py-3 text-gray-600">{entry.superAdminUserId}</td>
                  </tr>
                ))}
                {auditLog.length === 0 && <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-400">No audit entries</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="flex justify-center gap-2 mt-4">
            <button onClick={() => setAuditPage((p) => Math.max(1, p - 1))} disabled={auditPage <= 1} className="px-3 py-1.5 text-sm text-gray-600 bg-gray-100 rounded-lg disabled:opacity-50">Prev</button>
            <span className="px-3 py-1.5 text-sm text-gray-500">Page {auditPage}</span>
            <button onClick={() => { if (auditLog.length === 20) setAuditPage((p) => p + 1); }} disabled={auditLog.length < 20} className="px-3 py-1.5 text-sm text-gray-600 bg-gray-100 rounded-lg disabled:opacity-50">Next</button>
          </div>
        </div>
      )}

      {/* Memory Tab */}
      {tab === 'memory' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Agent Memory</h3>
            <div className="flex items-center gap-2">
              <select
                value={memoryUserFilter}
                onChange={(e) => { setMemoryUserFilter(e.target.value); setMemoryPage(1); fetchMemories(1, e.target.value); }}
                className="text-xs px-2 py-1.5 border border-gray-200 rounded-lg bg-white"
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
                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden" style={{ maxHeight: '600px', overflowY: 'auto' }}>
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 z-10">
                      <tr className="bg-gray-50 text-gray-500 text-xs uppercase">
                        <th className="px-4 py-3 text-left">User</th>
                        <th className="px-4 py-3 text-left">When</th>
                        <th className="px-4 py-3 text-left">Tool</th>
                        <th className="px-4 py-3 text-left">Memory</th>
                        <th className="px-4 py-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageRows.map((m) => (
                        <tr key={m.id} className="border-t border-gray-100 hover:bg-gray-50">
                          <td className="px-4 py-3 text-gray-700 font-medium whitespace-nowrap">{m.displayName || m.username}</td>
                          <td className="px-4 py-3 text-gray-500 whitespace-nowrap text-xs">
                            {new Date(m.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}{' '}
                            {new Date(m.createdAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                          </td>
                          <td className="px-4 py-3">
                            {m.tool && (
                              <span className="inline-block px-2 py-0.5 text-[10px] font-bold rounded-full bg-indigo-50 text-indigo-600 uppercase tracking-wide">
                                {m.tool.replace('_', ' ')}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-gray-800">{m.content}</td>
                          <td className="px-4 py-3 text-right">
                            <button
                              onClick={() => deleteMemory(m.id)}
                              className="text-xs text-red-500 hover:text-red-700 font-medium"
                            >
                              Delete
                            </button>
                          </td>
                        </tr>
                      ))}
                      {memories.length === 0 && (
                        <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">No memories yet — tool use will populate this</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="flex justify-center gap-2 mt-4">
                  <button
                    onClick={() => setMemoryPage((p) => Math.max(1, p - 1))}
                    disabled={memoryPage <= 1}
                    className="px-3 py-1.5 text-sm text-gray-600 bg-gray-100 rounded-lg disabled:opacity-50"
                  >Prev</button>
                  <span className="px-3 py-1.5 text-sm text-gray-500">Page {memoryPage}</span>
                  <button
                    onClick={() => { if (memories.length === 20) setMemoryPage((p) => p + 1); }}
                    disabled={memories.length < 20}
                    className="px-3 py-1.5 text-sm text-gray-600 bg-gray-100 rounded-lg disabled:opacity-50"
                  >Next</button>
                </div>
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}
