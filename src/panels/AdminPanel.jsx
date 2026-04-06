import { useState, useEffect, useCallback } from 'react';

const API_BASE = '';

export default function AdminPanel({ authToken }) {
  const [tab, setTab] = useState('orgs');
  const [orgs, setOrgs] = useState([]);
  const [users, setUsers] = useState([]);
  const [auditLog, setAuditLog] = useState([]);
  const [auditPage, setAuditPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Modal state
  const [showCreateOrg, setShowCreateOrg] = useState(false);
  const [newOrg, setNewOrg] = useState({ name: '', type: 'household', adminEmail: '' });

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

  useEffect(() => {
    if (tab === 'orgs') fetchOrgs();
    else if (tab === 'users') fetchUsers();
    else if (tab === 'audit') fetchAuditLog(auditPage);
  }, [tab, auditPage]);

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
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-4">Users</h2>
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="bg-gray-50 text-gray-500 text-xs uppercase">
                <th className="px-4 py-3 text-left">Name</th>
                <th className="px-4 py-3 text-left">Email</th>
                <th className="px-4 py-3 text-left">Role</th>
                <th className="px-4 py-3 text-left">Org</th>
                <th className="px-4 py-3 text-center">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr></thead>
              <tbody>
                {users.map((u) => (
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
                    <td className="px-4 py-3 text-right space-x-2">
                      <button onClick={() => impersonateUser(u.id)} className="text-xs text-[#4f4dcf] hover:text-[#3f3dbf] font-medium">Impersonate</button>
                      {u.active && (
                        <button onClick={() => suspendUser(u.id)} className="text-xs text-red-600 hover:text-red-700 font-medium">Suspend</button>
                      )}
                    </td>
                  </tr>
                ))}
                {users.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">No users</td></tr>}
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
    </div>
  );
}
