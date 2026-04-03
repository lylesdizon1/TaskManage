import { useState, useEffect } from 'react';
import { useToast } from '../../contexts/ToastContext';
import { GearIcon, XIcon } from '../icons/Icons.jsx';
import { getEntityStyle, getTagStyle, AVAILABLE_COLORS } from '../../constants/colors.js';
import PersonaSettings from './PersonaSettings';

function EnvBadge() {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold bg-green-100 text-green-700 border border-green-200 px-2 py-0.5 rounded-full ml-2">
      <span className="w-1.5 h-1.5 bg-green-500 rounded-full" />
      Configured via environment
    </span>
  );
}

export default function SettingsModal({ apiKeys, onSave, emailSettings, onSaveEmail, onClose, envConfigured = {}, authToken, currentUser, entities, onEntitiesChanged, onUserUpdated, apiFetch }) {
  const isAdmin = currentUser?.role === 'admin';
  const [tab, setTab]               = useState('keys');
  const [draftKeys, setDraftKeys]   = useState({ ...apiKeys });
  const [draftEmail, setDraftEmail] = useState({ ...emailSettings });
  const [testing, setTesting]       = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [pwForm, setPwForm]         = useState({ current: '', newPw: '', confirm: '' });
  const [pwStatus, setPwStatus]     = useState(null);
  const [pwSaving, setPwSaving]     = useState(false);

  // Persona state
  const [personaName, setPersonaName] = useState(currentUser?.assistantName || 'Aria');
  const [personaType, setPersonaType] = useState(currentUser?.persona || 'executive_assistant');
  const [personaSaving, setPersonaSaving] = useState(false);
  const [personaStatus, setPersonaStatus] = useState(null);

  // ── Gmail / Email Intelligence state ──
  const [gmailStatus, setGmailStatus] = useState({ connected: false, email: '' });
  const [gmailConfig, setGmailConfig] = useState({ vipSenders: [], triggerKeywords: [], commitmentDetection: true });
  const [gmailLoading, setGmailLoading] = useState(false);
  const [newVip, setNewVip] = useState('');
  const [newKeyword, setNewKeyword] = useState('');
  const [newExclusion, setNewExclusion] = useState('');
  const [configSaving, setConfigSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const settingsToast = useToast();

  // ── Entity management state ──
  const [entityList, setEntityList] = useState([]);
  const [newEntityName, setNewEntityName] = useState('');
  const [newEntityColor, setNewEntityColor] = useState('indigo');
  const [newEntityType, setNewEntityType] = useState('business');
  const [newEntityParent, setNewEntityParent] = useState('');
  const [newEntityShared, setNewEntityShared] = useState(false);
  const [editingEntity, setEditingEntity] = useState(null);

  // ── User management state ──
  const [userList, setUserList] = useState([]);
  const [showAddUser, setShowAddUser] = useState(false);
  const [newUser, setNewUser] = useState({ username: '', displayName: '', email: '', password: '', role: 'member', entityIds: [] });
  const [editingUser, setEditingUser] = useState(null);

  useEffect(() => {
    if (tab === 'gmail') loadGmailData();
    if (isAdmin && (tab === 'entities' || tab === 'users')) {
      if (tab === 'entities') loadEntities();
      if (tab === 'users') loadUsers();
    }
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadGmailData() {
    try {
      const [statusRes, configRes] = await Promise.all([
        apiFetch(`/api/gmail/status?userId=${currentUser.id}`),
        apiFetch(`/api/gmail/config?userId=${currentUser.id}`),
      ]);
      const statusData = await statusRes.json();
      const configData = await configRes.json();
      setGmailStatus(statusData);
      setGmailConfig({ excludedSenders: [], autoExcludeNoreply: true, ...configData });
    } catch {}
  }

  async function handleGmailConnect() {
    setGmailLoading(true);
    try {
      const res = await apiFetch(`/api/gmail/auth-url?userId=${currentUser.id}`);
      const { url } = await res.json();
      window.location.href = url;
    } catch {
      setGmailLoading(false);
    }
  }

  async function handleGmailDisconnect() {
    setGmailLoading(true);
    try {
      await apiFetch(`/api/gmail/disconnect?userId=${currentUser.id}`, { method: 'DELETE' });
      setGmailStatus({ connected: false, email: '' });
    } catch {} finally {
      setGmailLoading(false);
    }
  }

  async function handleSaveGmailConfig() {
    setConfigSaving(true);
    try {
      await apiFetch('/api/gmail/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUser.id, config: gmailConfig }),
      });
    } catch {} finally {
      setConfigSaving(false);
    }
  }

  async function handleGmailScan() {
    setScanning(true);
    try {
      const res = await apiFetch('/api/gmail/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      });
      const data = await res.json();
      if (res.ok) {
        if (data.newItems > 0) {
          settingsToast.success(`Found ${data.newItems} new item${data.newItems !== 1 ? 's' : ''} in your Inbox`);
        } else {
          settingsToast.info('Inbox is up to date');
        }
      } else {
        settingsToast.error(data.error || 'Scan failed');
      }
    } catch {
      settingsToast.error('Scan failed');
    } finally {
      setScanning(false);
    }
  }

  async function loadEntities() {
    try {
      const res = await apiFetch('/api/entities', { headers: { Authorization: `Bearer ${authToken}` } });
      const data = await res.json();
      if (Array.isArray(data)) setEntityList(data);
    } catch {}
  }

  async function loadUsers() {
    try {
      const res = await apiFetch('/api/users', { headers: { Authorization: `Bearer ${authToken}` } });
      const data = await res.json();
      if (Array.isArray(data)) setUserList(data);
    } catch {}
  }

  async function handleCreateEntity() {
    if (!newEntityName.trim()) return;
    try {
      const res = await apiFetch('/api/entities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          name: newEntityName.trim(),
          color: newEntityColor,
          type: newEntityType,
          parentId: newEntityType === 'project' ? newEntityParent || null : null,
          shared: newEntityShared,
        }),
      });
      if (res.ok) {
        setNewEntityName('');
        setNewEntityColor('indigo');
        setNewEntityType('business');
        setNewEntityParent('');
        setNewEntityShared(false);
        loadEntities();
        onEntitiesChanged?.();
      }
    } catch {}
  }

  async function handleUpdateEntity(id, fields) {
    try {
      await apiFetch(`/api/entities/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify(fields),
      });
      setEditingEntity(null);
      loadEntities();
      onEntitiesChanged?.();
    } catch {}
  }

  async function handleDeleteEntity(id) {
    try {
      await apiFetch(`/api/entities/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      loadEntities();
      onEntitiesChanged?.();
    } catch {}
  }

  async function handleCreateUser() {
    if (!newUser.username.trim() || !newUser.password) return;
    try {
      const res = await apiFetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify(newUser),
      });
      if (res.ok) {
        setNewUser({ username: '', displayName: '', email: '', password: '', role: 'member', entityIds: [] });
        setShowAddUser(false);
        loadUsers();
      }
    } catch {}
  }

  async function handleUpdateUser(id, fields) {
    try {
      await apiFetch(`/api/users/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify(fields),
      });
      setEditingUser(null);
      loadUsers();
    } catch {}
  }

  async function handleDeleteUser(id) {
    try {
      await apiFetch(`/api/users/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      loadUsers();
    } catch {}
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') onClose();
  }

  async function handleTestConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await apiFetch('/api/email/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: draftEmail.recipientEmail }),
      });
      const data = await res.json();
      setTestResult(
        res.ok ? { ok: true, msg: 'Test email sent via Resend!' } : { ok: false, msg: data.error || 'Failed' },
      );
    } catch (err) {
      setTestResult({ ok: false, msg: err.message });
    } finally {
      setTesting(false);
    }
  }

  const inputCls =
    'w-full px-3 py-2 bg-gray-100 border border-gray-200 rounded-lg text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition';
  const disabledCls =
    'w-full px-3 py-2 bg-green-50 border border-green-200 rounded-lg text-sm text-gray-500 cursor-not-allowed';

  const hasAnyEnv = Object.values(envConfigured).some(Boolean);

  return (
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50"
      onKeyDown={handleKeyDown}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 flex-shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-gray-100 rounded-lg flex items-center justify-center">
              <GearIcon className="w-4 h-4 text-gray-600" />
            </div>
            <h2 className="text-lg font-bold text-gray-900">Settings</h2>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg p-1 transition-colors"
          >
            <XIcon className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-100 mx-6 overflow-x-auto">
          {[
            { key: 'keys',  label: 'API Keys' },
            { key: 'email', label: 'Alerts' },
            { key: 'assistant', label: 'AI Assistant' },
            { key: 'password', label: 'Password' },
            { key: 'gmail', label: 'Email Intelligence' },
            ...(isAdmin ? [
              { key: 'entities', label: 'Entities' },
              { key: 'users', label: 'Users' },
            ] : []),
          ].map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-3 py-2.5 text-sm font-medium border-b-2 transition-all -mb-px whitespace-nowrap ${
                tab === key
                  ? 'border-indigo-600 text-indigo-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="px-6 py-5 flex-1 overflow-y-auto">
          {/* API Keys tab */}
          {tab === 'keys' && (
            <div className="space-y-4">
              {hasAnyEnv ? (
                <p className="text-xs text-gray-500 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                  Fields marked with a green badge are configured via Railway environment variables and survive redeploys.
                </p>
              ) : (
                <p className="text-xs text-gray-500 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                  Keys are stored in memory only and never persisted beyond this session.
                </p>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Claude API Key
                  {envConfigured.claudeKey && <EnvBadge />}
                </label>
                <input
                  type="password"
                  value={draftKeys.claude}
                  onChange={(e) => setDraftKeys((k) => ({ ...k, claude: e.target.value }))}
                  placeholder="sk-ant-api03-..."
                  autoComplete="off"
                  disabled={envConfigured.claudeKey}
                  className={envConfigured.claudeKey ? disabledCls : inputCls}
                />
                <p className="text-xs text-gray-400 mt-1">AI tag suggestions + Claude chat</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  OpenAI API Key
                  {envConfigured.openaiKey && <EnvBadge />}
                </label>
                <input
                  type="password"
                  value={draftKeys.openai}
                  onChange={(e) => setDraftKeys((k) => ({ ...k, openai: e.target.value }))}
                  placeholder="sk-..."
                  autoComplete="off"
                  disabled={envConfigured.openaiKey}
                  className={envConfigured.openaiKey ? disabledCls : inputCls}
                />
                <p className="text-xs text-gray-400 mt-1">ChatGPT chat</p>
              </div>

              <button
                onClick={() => { onSave(draftKeys); onClose(); }}
                className="w-full px-4 py-2.5 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 font-medium text-sm transition-colors shadow-sm"
              >
                Save API Keys
              </button>
            </div>
          )}

          {/* Email tab */}
          {tab === 'email' && (
            <div className="space-y-4">
              {/* Resend status */}
              <div className={`text-xs px-3 py-2.5 rounded-lg font-medium flex items-center gap-2 ${
                envConfigured.resendApiKey
                  ? 'bg-green-50 text-green-700 border border-green-200'
                  : 'bg-amber-50 text-amber-700 border border-amber-100'
              }`}>
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${envConfigured.resendApiKey ? 'bg-green-500' : 'bg-amber-400'}`} />
                {envConfigured.resendApiKey
                  ? 'Resend API key configured via environment variable'
                  : 'Set RESEND_API_KEY in Railway environment variables to enable email'}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Default Alert Recipient
                  {envConfigured.recipientEmail && <EnvBadge />}
                </label>
                <input
                  type="email"
                  value={draftEmail.recipientEmail}
                  onChange={(e) => setDraftEmail((s) => ({ ...s, recipientEmail: e.target.value }))}
                  placeholder="alerts@example.com"
                  autoComplete="off"
                  disabled={envConfigured.recipientEmail}
                  className={envConfigured.recipientEmail ? disabledCls : inputCls}
                />
                <p className="text-xs text-gray-400 mt-1">Alerts are sent to this address by default</p>
              </div>

              {testResult && (
                <div
                  className={`text-xs px-3 py-2 rounded-lg font-medium ${
                    testResult.ok
                      ? 'bg-green-50 text-green-700 border border-green-200'
                      : 'bg-red-50 text-red-700 border border-red-200'
                  }`}
                >
                  {testResult.ok ? '\u2713 ' : '\u2717 '}{testResult.msg}
                </div>
              )}

              <div className="flex gap-2">
                <button
                  onClick={handleTestConnection}
                  disabled={testing || !envConfigured.resendApiKey}
                  className="flex-1 px-4 py-2.5 border border-gray-200 rounded-xl text-gray-700 hover:bg-gray-50 font-medium text-sm transition-colors disabled:opacity-50"
                >
                  {testing ? 'Sending\u2026' : 'Send Test Email'}
                </button>
                <button
                  onClick={() => { onSaveEmail(draftEmail); onClose(); }}
                  className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 font-medium text-sm transition-colors shadow-sm"
                >
                  Save Email Settings
                </button>
              </div>
            </div>
          )}

          {/* AI Assistant tab */}
          {tab === 'assistant' && (
            <div className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Assistant Name</label>
                <input
                  type="text"
                  value={personaName}
                  onChange={(e) => setPersonaName(e.target.value)}
                  placeholder="Aria"
                  maxLength={30}
                  className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition"
                />
                <p className="text-xs text-gray-400 mt-1">Your AI assistant&rsquo;s name — used in briefs and greetings.</p>
              </div>
              <PersonaSettings />

              {personaStatus && (
                <div className={`text-xs px-3 py-2 rounded-lg font-medium ${
                  personaStatus.ok ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'
                }`}>
                  {personaStatus.ok ? '\u2713 ' : '\u2717 '}{personaStatus.msg}
                </div>
              )}

              <button
                disabled={personaSaving}
                onClick={async () => {
                  setPersonaSaving(true);
                  setPersonaStatus(null);
                  try {
                    const res = await apiFetch('/api/users/settings', {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
                      body: JSON.stringify({ persona: personaType, assistantName: personaName.trim() || 'Aria' }),
                    });
                    const data = await res.json();
                    if (res.ok) {
                      setPersonaStatus({ ok: true, msg: 'Saved!' });
                      if (onUserUpdated) onUserUpdated(data);
                    } else {
                      setPersonaStatus({ ok: false, msg: data.error || 'Failed to save' });
                    }
                  } catch (err) {
                    setPersonaStatus({ ok: false, msg: err.message });
                  } finally {
                    setPersonaSaving(false);
                  }
                }}
                className="w-full px-4 py-2.5 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 font-medium text-sm transition-colors shadow-sm disabled:opacity-50"
              >
                {personaSaving ? 'Saving\u2026' : 'Save Assistant Settings'}
              </button>
            </div>
          )}

          {/* Password tab */}
          {tab === 'password' && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Current Password</label>
                <input
                  type="password"
                  value={pwForm.current}
                  onChange={(e) => setPwForm((f) => ({ ...f, current: e.target.value }))}
                  placeholder="Enter current password"
                  autoComplete="current-password"
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">New Password</label>
                <input
                  type="password"
                  value={pwForm.newPw}
                  onChange={(e) => setPwForm((f) => ({ ...f, newPw: e.target.value }))}
                  placeholder="Enter new password"
                  autoComplete="new-password"
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Confirm New Password</label>
                <input
                  type="password"
                  value={pwForm.confirm}
                  onChange={(e) => setPwForm((f) => ({ ...f, confirm: e.target.value }))}
                  placeholder="Confirm new password"
                  autoComplete="new-password"
                  className={inputCls}
                />
              </div>

              {pwStatus && (
                <div className={`text-xs px-3 py-2 rounded-lg font-medium ${
                  pwStatus.ok
                    ? 'bg-green-50 text-green-700 border border-green-200'
                    : 'bg-red-50 text-red-700 border border-red-200'
                }`}>
                  {pwStatus.ok ? '\u2713 ' : '\u2717 '}{pwStatus.msg}
                </div>
              )}

              <button
                disabled={pwSaving}
                onClick={async () => {
                  setPwStatus(null);
                  if (!pwForm.current || !pwForm.newPw || !pwForm.confirm) {
                    setPwStatus({ ok: false, msg: 'All fields are required' });
                    return;
                  }
                  if (pwForm.newPw !== pwForm.confirm) {
                    setPwStatus({ ok: false, msg: 'New passwords do not match' });
                    return;
                  }
                  if (pwForm.newPw.length < 4) {
                    setPwStatus({ ok: false, msg: 'New password must be at least 4 characters' });
                    return;
                  }
                  setPwSaving(true);
                  try {
                    const res = await apiFetch('/api/auth/change-password', {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${authToken}`,
                      },
                      body: JSON.stringify({ currentPassword: pwForm.current, newPassword: pwForm.newPw }),
                    });
                    const data = await res.json();
                    if (res.ok) {
                      setPwStatus({ ok: true, msg: 'Password changed successfully' });
                      setPwForm({ current: '', newPw: '', confirm: '' });
                    } else {
                      setPwStatus({ ok: false, msg: data.error || 'Failed to change password' });
                    }
                  } catch (err) {
                    setPwStatus({ ok: false, msg: err.message });
                  } finally {
                    setPwSaving(false);
                  }
                }}
                className="w-full px-4 py-2.5 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 font-medium text-sm transition-colors shadow-sm disabled:opacity-50"
              >
                {pwSaving ? 'Changing\u2026' : 'Change Password'}
              </button>
            </div>
          )}

          {/* Email Intelligence tab */}
          {tab === 'gmail' && (
            <div className="space-y-5">
              {/* Connection status */}
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-2">Gmail Connection</h3>
                <div className="flex items-center justify-between p-3 rounded-lg border border-gray-100 bg-gray-50/50">
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${gmailStatus.connected ? 'bg-green-500' : 'bg-gray-300'}`} />
                    <span className="text-sm text-gray-600">
                      {gmailStatus.connected ? `Connected to ${gmailStatus.email}` : 'Not connected'}
                    </span>
                  </div>
                  {gmailStatus.connected ? (
                    <button
                      onClick={handleGmailDisconnect}
                      disabled={gmailLoading}
                      className="px-3 py-1.5 text-xs font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50"
                    >
                      {gmailLoading ? 'Disconnecting...' : 'Disconnect'}
                    </button>
                  ) : (
                    <button
                      onClick={handleGmailConnect}
                      disabled={gmailLoading}
                      className="px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                    >
                      {gmailLoading ? 'Connecting...' : 'Connect Gmail'}
                    </button>
                  )}
                </div>
              </div>

              {/* VIP Senders */}
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-1">VIP Senders</h3>
                <p className="text-xs text-gray-400 mb-2">Emails or domains (e.g. boss@company.com, @important.com)</p>
                <div className="flex gap-2 mb-2">
                  <input
                    type="text"
                    value={newVip}
                    onChange={(e) => setNewVip(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newVip.trim()) {
                        setGmailConfig((c) => ({ ...c, vipSenders: [...c.vipSenders, newVip.trim()] }));
                        setNewVip('');
                      }
                    }}
                    placeholder="Add email or @domain"
                    className="flex-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:border-indigo-300 focus:ring-1 focus:ring-indigo-200 outline-none"
                  />
                  <button
                    onClick={() => {
                      if (newVip.trim()) {
                        setGmailConfig((c) => ({ ...c, vipSenders: [...c.vipSenders, newVip.trim()] }));
                        setNewVip('');
                      }
                    }}
                    className="px-3 py-1.5 text-xs font-medium text-indigo-600 border border-indigo-200 rounded-lg hover:bg-indigo-50"
                  >Add</button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {gmailConfig.vipSenders.map((s, i) => (
                    <span key={i} className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200">
                      {s}
                      <button
                        onClick={() => setGmailConfig((c) => ({ ...c, vipSenders: c.vipSenders.filter((_, j) => j !== i) }))}
                        className="text-indigo-400 hover:text-indigo-600 ml-0.5"
                      >&times;</button>
                    </span>
                  ))}
                  {gmailConfig.vipSenders.length === 0 && <span className="text-xs text-gray-300 italic">None added yet</span>}
                </div>
              </div>

              {/* Trigger Keywords */}
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-1">Trigger Keywords</h3>
                <p className="text-xs text-gray-400 mb-2">Flag emails containing these words (e.g. urgent, deadline, invoice)</p>
                <div className="flex gap-2 mb-2">
                  <input
                    type="text"
                    value={newKeyword}
                    onChange={(e) => setNewKeyword(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newKeyword.trim()) {
                        setGmailConfig((c) => ({ ...c, triggerKeywords: [...c.triggerKeywords, newKeyword.trim()] }));
                        setNewKeyword('');
                      }
                    }}
                    placeholder="Add keyword"
                    className="flex-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:border-indigo-300 focus:ring-1 focus:ring-indigo-200 outline-none"
                  />
                  <button
                    onClick={() => {
                      if (newKeyword.trim()) {
                        setGmailConfig((c) => ({ ...c, triggerKeywords: [...c.triggerKeywords, newKeyword.trim()] }));
                        setNewKeyword('');
                      }
                    }}
                    className="px-3 py-1.5 text-xs font-medium text-indigo-600 border border-indigo-200 rounded-lg hover:bg-indigo-50"
                  >Add</button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {gmailConfig.triggerKeywords.map((k, i) => (
                    <span key={i} className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                      {k}
                      <button
                        onClick={() => setGmailConfig((c) => ({ ...c, triggerKeywords: c.triggerKeywords.filter((_, j) => j !== i) }))}
                        className="text-amber-400 hover:text-amber-600 ml-0.5"
                      >&times;</button>
                    </span>
                  ))}
                  {gmailConfig.triggerKeywords.length === 0 && <span className="text-xs text-gray-300 italic">None added yet</span>}
                </div>
              </div>

              {/* Excluded Senders */}
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-1">Excluded Senders</h3>
                <p className="text-xs text-gray-400 mb-2">Skip emails from these senders during scan</p>
                <label className="inline-flex items-center gap-2 cursor-pointer mb-3">
                  <div
                    className={`relative w-9 h-5 rounded-full transition-colors ${gmailConfig.autoExcludeNoreply ? 'bg-indigo-600' : 'bg-gray-300'}`}
                    onClick={() => setGmailConfig((c) => ({ ...c, autoExcludeNoreply: !c.autoExcludeNoreply }))}
                  >
                    <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${gmailConfig.autoExcludeNoreply ? 'translate-x-4' : ''}`} />
                  </div>
                  <span className="text-sm text-gray-600">Auto-exclude no-reply senders</span>
                </label>
                <div className="flex gap-2 mb-2">
                  <input
                    type="text"
                    value={newExclusion}
                    onChange={(e) => setNewExclusion(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newExclusion.trim()) {
                        setGmailConfig((c) => ({ ...c, excludedSenders: [...(c.excludedSenders || []), newExclusion.trim()] }));
                        setNewExclusion('');
                      }
                    }}
                    placeholder="Add email or @domain to exclude"
                    className="flex-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:border-indigo-300 focus:ring-1 focus:ring-indigo-200 outline-none"
                  />
                  <button
                    onClick={() => {
                      if (newExclusion.trim()) {
                        setGmailConfig((c) => ({ ...c, excludedSenders: [...(c.excludedSenders || []), newExclusion.trim()] }));
                        setNewExclusion('');
                      }
                    }}
                    className="px-3 py-1.5 text-xs font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
                  >Add</button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(gmailConfig.excludedSenders || []).map((s, i) => (
                    <span key={i} className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-gray-100 text-gray-600 border border-gray-200">
                      {s}
                      <button
                        onClick={() => setGmailConfig((c) => ({ ...c, excludedSenders: (c.excludedSenders || []).filter((_, j) => j !== i) }))}
                        className="text-gray-400 hover:text-gray-600 ml-0.5"
                      >&times;</button>
                    </span>
                  ))}
                  {(gmailConfig.excludedSenders || []).length === 0 && <span className="text-xs text-gray-300 italic">None added yet</span>}
                </div>
              </div>

              {/* Commitment Detection */}
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-1">Commitment Detection</h3>
                <p className="text-xs text-gray-400 mb-2">AI detects promises and commitments in your emails</p>
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <div
                    className={`relative w-9 h-5 rounded-full transition-colors ${gmailConfig.commitmentDetection ? 'bg-indigo-600' : 'bg-gray-300'}`}
                    onClick={() => setGmailConfig((c) => ({ ...c, commitmentDetection: !c.commitmentDetection }))}
                  >
                    <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${gmailConfig.commitmentDetection ? 'translate-x-4' : ''}`} />
                  </div>
                  <span className="text-sm text-gray-600">{gmailConfig.commitmentDetection ? 'On' : 'Off'}</span>
                </label>
              </div>

              {/* Save + Scan */}
              <div className="space-y-2">
                <button
                  onClick={handleSaveGmailConfig}
                  disabled={configSaving}
                  className="w-full py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                >
                  {configSaving ? 'Saving...' : 'Save Configuration'}
                </button>
                <button
                  onClick={handleGmailScan}
                  disabled={!gmailStatus.connected || scanning}
                  className="w-full py-2 text-sm font-medium text-indigo-600 border border-indigo-200 rounded-lg hover:bg-indigo-50 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {scanning ? (
                    <>
                      <span className="w-4 h-4 border-2 border-indigo-300 border-t-indigo-600 rounded-full animate-spin" />
                      Scanning...
                    </>
                  ) : 'Scan Now'}
                </button>
                {!gmailStatus.connected && (
                  <p className="text-xs text-gray-400 text-center">Connect Gmail above to enable scanning</p>
                )}
              </div>
            </div>
          )}

          {/* Entities tab (admin only) */}
          {tab === 'entities' && isAdmin && (
            <div className="space-y-3">
              <p className="text-xs text-gray-500">Manage entities, projects, and household sharing.</p>

              {/* Existing entities — hierarchical */}
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {(() => {
                  // Build hierarchy: businesses first, then their child projects, then personal
                  const businesses = entityList.filter((e) => e.type === 'business' || (!e.type && e.type !== 'personal' && e.type !== 'project'));
                  const projects = entityList.filter((e) => e.type === 'project');
                  const personals = entityList.filter((e) => e.type === 'personal');
                  const ordered = [];
                  businesses.forEach((b) => {
                    ordered.push({ ...b, _indent: 0 });
                    projects.filter((p) => p.parentId === b.id).forEach((p) => ordered.push({ ...p, _indent: 1 }));
                  });
                  // Orphan projects (no parent or parent not found)
                  projects.filter((p) => !p.parentId || !businesses.find((b) => b.id === p.parentId)).forEach((p) => ordered.push({ ...p, _indent: 0 }));
                  personals.forEach((p) => ordered.push({ ...p, _indent: 0 }));
                  return ordered;
                })().map((ent) => {
                  const style = getEntityStyle(ent.color);
                  const typeIcon = ent.type === 'personal' ? '\u{1F464}' : ent.type === 'project' ? '\u{1F4CB}' : '\u{1F3E2}';
                  const typeLabel = ent.type === 'personal' ? 'Personal' : ent.type === 'project' ? 'Project' : 'Business';
                  const isOwner = ent.isOwner !== false;

                  if (editingEntity === ent.id) {
                    return (
                      <div key={ent.id} className="flex flex-col gap-2 p-3 bg-gray-50 rounded-lg">
                        <div className="flex items-center gap-2">
                          <input type="text" defaultValue={ent.name} id={`ent-name-${ent.id}`} className="flex-1 px-2 py-1 text-sm border border-gray-200 rounded" />
                          <select defaultValue={ent.color} id={`ent-color-${ent.id}`} className="px-2 py-1 text-sm border border-gray-200 rounded">
                            {AVAILABLE_COLORS.map((c) => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </div>
                        <div className="flex items-center gap-2">
                          <select defaultValue={ent.type || 'business'} id={`ent-type-${ent.id}`} className="px-2 py-1 text-xs border border-gray-200 rounded">
                            <option value="business">Business</option>
                            <option value="project">Project</option>
                            <option value="personal">Personal</option>
                          </select>
                          <select defaultValue={ent.parentId || ''} id={`ent-parent-${ent.id}`} className="px-2 py-1 text-xs border border-gray-200 rounded">
                            <option value="">No parent</option>
                            {entityList.filter((e) => (e.type === 'business' || !e.type) && e.id !== ent.id).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                          </select>
                          <label className="flex items-center gap-1 text-xs text-gray-600">
                            <input type="checkbox" defaultChecked={ent.shared || false} id={`ent-shared-${ent.id}`} className="rounded" />
                            Shared
                          </label>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => {
                              const name = document.getElementById(`ent-name-${ent.id}`).value;
                              const color = document.getElementById(`ent-color-${ent.id}`).value;
                              const type = document.getElementById(`ent-type-${ent.id}`).value;
                              const parentId = document.getElementById(`ent-parent-${ent.id}`).value;
                              const shared = document.getElementById(`ent-shared-${ent.id}`).checked;
                              handleUpdateEntity(ent.id, { name, color, type, parentId: type === 'project' ? parentId : null, shared });
                            }}
                            className="px-2 py-1 text-xs bg-indigo-600 text-white rounded"
                          >Save</button>
                          <button onClick={() => setEditingEntity(null)} className="px-2 py-1 text-xs text-gray-500">Cancel</button>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div key={ent.id} className="flex items-center justify-between px-3 py-2 rounded-lg border border-gray-100" style={{ marginLeft: ent._indent ? 20 : 0 }}>
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        {ent._indent > 0 && <span className="text-gray-300 text-xs">&lsaquo;&mdash;</span>}
                        <span className={`w-3 h-3 rounded-full flex-shrink-0 ${style.dot}`} />
                        <span className="text-sm font-medium text-gray-800 truncate">{ent.name}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">{typeIcon} {typeLabel}</span>
                        {ent.shared && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600">{'\u{1F517}'} Shared</span>}
                        {!isOwner && <span className="text-[10px] text-gray-400">(read-only)</span>}
                      </div>
                      {isOwner && (
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <button onClick={() => setEditingEntity(ent.id)} className="text-xs text-indigo-500 hover:text-indigo-700 px-1">Edit</button>
                          <button onClick={() => handleDeleteEntity(ent.id)} className="text-xs text-red-400 hover:text-red-600 px-1">Delete</button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Add new entity */}
              <div className="space-y-2 p-3 bg-gray-50 rounded-lg">
                <div className="flex gap-2">
                  <input type="text" value={newEntityName} onChange={(e) => setNewEntityName(e.target.value)} placeholder="New entity name" className={inputCls + ' flex-1'} />
                  <select value={newEntityColor} onChange={(e) => setNewEntityColor(e.target.value)} className="px-2 py-2 bg-white border border-gray-200 rounded-lg text-sm">
                    {AVAILABLE_COLORS.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>

                {/* Type selector pills */}
                <div className="flex gap-2">
                  {[
                    { key: 'business', icon: '\u{1F3E2}', label: 'Business' },
                    { key: 'project', icon: '\u{1F4CB}', label: 'Project' },
                    { key: 'personal', icon: '\u{1F464}', label: 'Personal' },
                  ].map(({ key, icon, label }) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setNewEntityType(key)}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                        newEntityType === key
                          ? 'bg-indigo-100 text-indigo-700 border border-indigo-200'
                          : 'bg-white text-gray-500 border border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      {icon} {label}
                    </button>
                  ))}
                </div>

                {/* Parent selector (only for projects) */}
                {newEntityType === 'project' && (
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Belongs to</label>
                    <select value={newEntityParent} onChange={(e) => setNewEntityParent(e.target.value)} className="w-full px-2 py-2 bg-white border border-gray-200 rounded-lg text-sm">
                      <option value="">-- Select parent business --</option>
                      {entityList.filter((e) => e.type === 'business' || (!e.type && e.type !== 'personal')).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                    </select>
                  </div>
                )}

                {/* Shared toggle */}
                <label className="flex items-center gap-2 cursor-pointer">
                  <div className="relative">
                    <input type="checkbox" checked={newEntityShared} onChange={(e) => setNewEntityShared(e.target.checked)} className="sr-only" />
                    <div className={`w-9 h-5 rounded-full transition-colors ${newEntityShared ? 'bg-indigo-600' : 'bg-gray-300'}`} onClick={() => setNewEntityShared(!newEntityShared)}>
                      <div className={`w-4 h-4 bg-white rounded-full shadow transform transition-transform mt-0.5 ${newEntityShared ? 'translate-x-4 ml-0.5' : 'translate-x-0.5'}`} />
                    </div>
                  </div>
                  <div>
                    <span className="text-xs font-medium text-gray-700">Share with household</span>
                    <p className="text-[10px] text-gray-400">Shared entities are visible to all users</p>
                  </div>
                </label>

                <button
                  onClick={handleCreateEntity}
                  disabled={!newEntityName.trim()}
                  className="w-full px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-indigo-700 transition-colors"
                >Add Entity</button>
              </div>
            </div>
          )}

          {/* Users tab (admin only) */}
          {tab === 'users' && isAdmin && (
            <div className="space-y-3">
              <p className="text-xs text-gray-500">Manage user accounts, roles, and entity assignments.</p>

              {/* Existing users */}
              <div className="space-y-2 max-h-56 overflow-y-auto">
                {userList.map((u) => {
                  if (editingUser === u.id) {
                    return (
                      <div key={u.id} className="p-3 bg-gray-50 rounded-lg space-y-2">
                        <div className="flex gap-2">
                          <input defaultValue={u.displayName} id={`u-dn-${u.id}`} placeholder="Display name" className="flex-1 px-2 py-1 text-sm border border-gray-200 rounded" />
                          <input defaultValue={u.email} id={`u-em-${u.id}`} placeholder="Email" className="flex-1 px-2 py-1 text-sm border border-gray-200 rounded" />
                        </div>
                        <div className="flex gap-2">
                          <select defaultValue={u.role} id={`u-role-${u.id}`} className="px-2 py-1 text-sm border border-gray-200 rounded">
                            <option value="admin">Admin</option>
                            <option value="member">Member</option>
                          </select>
                          <input id={`u-pw-${u.id}`} placeholder="New password (optional)" type="password" className="flex-1 px-2 py-1 text-sm border border-gray-200 rounded" />
                        </div>
                        {/* Entity checkboxes */}
                        <div className="flex flex-wrap gap-1.5">
                          {entityList.map((ent) => {
                            const style = getEntityStyle(ent.color);
                            const checked = (u.entityIds || []).includes(ent.name);
                            return (
                              <label key={ent.id} className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full border cursor-pointer ${checked ? `${style.bg} ${style.text} ${style.border}` : 'bg-gray-50 text-gray-400 border-gray-200'}`}>
                                <input type="checkbox" defaultChecked={checked} data-entity-name={ent.name} data-user-id={u.id} className="hidden" />
                                {ent.name}
                              </label>
                            );
                          })}
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => {
                              const displayName = document.getElementById(`u-dn-${u.id}`).value;
                              const email = document.getElementById(`u-em-${u.id}`).value;
                              const role = document.getElementById(`u-role-${u.id}`).value;
                              const pw = document.getElementById(`u-pw-${u.id}`).value;
                              const checkboxes = document.querySelectorAll(`[data-user-id="${u.id}"]`);
                              const entityIds = [];
                              checkboxes.forEach((cb) => { if (cb.checked) entityIds.push(cb.dataset.entityName); });
                              const fields = { displayName, email, role, entityIds };
                              if (pw) fields.password = pw;
                              handleUpdateUser(u.id, fields);
                            }}
                            className="px-3 py-1 text-xs bg-indigo-600 text-white rounded"
                          >Save</button>
                          <button onClick={() => setEditingUser(null)} className="px-3 py-1 text-xs text-gray-500">Cancel</button>
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div key={u.id} className="flex items-center justify-between px-3 py-2 rounded-lg border border-gray-100">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-gray-800">{u.displayName || u.username}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${u.role === 'admin' ? 'bg-indigo-100 text-indigo-600' : 'bg-gray-100 text-gray-500'}`}>
                            {u.role}
                          </span>
                          {u.active === false && <span className="text-[10px] bg-red-100 text-red-600 px-1.5 py-0.5 rounded font-medium">inactive</span>}
                        </div>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {(u.entityIds || []).map((name) => {
                            const style = getTagStyle(name, entityList);
                            return <span key={name} className={`text-[10px] px-1.5 py-0.5 rounded-full ${style.bg} ${style.text}`}>{name}</span>;
                          })}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button onClick={() => { loadEntities(); setEditingUser(u.id); }} className="text-xs text-indigo-500 hover:text-indigo-700 px-1">Edit</button>
                        {u.id !== currentUser.id && (
                          <button onClick={() => handleDeleteUser(u.id)} className="text-xs text-red-400 hover:text-red-600 px-1">Delete</button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Add new user */}
              {showAddUser ? (
                <div className="p-3 bg-indigo-50/30 rounded-lg border border-indigo-200 space-y-2">
                  <h4 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">New User</h4>
                  <div className="flex gap-2">
                    <input value={newUser.username} onChange={(e) => setNewUser((u) => ({ ...u, username: e.target.value }))} placeholder="Username *" className="flex-1 px-2 py-1.5 text-sm border border-gray-200 rounded" />
                    <input value={newUser.displayName} onChange={(e) => setNewUser((u) => ({ ...u, displayName: e.target.value }))} placeholder="Display name" className="flex-1 px-2 py-1.5 text-sm border border-gray-200 rounded" />
                  </div>
                  <div className="flex gap-2">
                    <input value={newUser.email} onChange={(e) => setNewUser((u) => ({ ...u, email: e.target.value }))} placeholder="Email" type="email" className="flex-1 px-2 py-1.5 text-sm border border-gray-200 rounded" />
                    <input value={newUser.password} onChange={(e) => setNewUser((u) => ({ ...u, password: e.target.value }))} placeholder="Password *" type="password" className="flex-1 px-2 py-1.5 text-sm border border-gray-200 rounded" />
                  </div>
                  <div className="flex gap-2 items-center">
                    <select value={newUser.role} onChange={(e) => setNewUser((u) => ({ ...u, role: e.target.value }))} className="px-2 py-1.5 text-sm border border-gray-200 rounded">
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                    </select>
                    <span className="text-xs text-gray-400">Entities:</span>
                    {entityList.map((ent) => {
                      const style = getEntityStyle(ent.color);
                      const selected = newUser.entityIds.includes(ent.name);
                      return (
                        <button
                          key={ent.id}
                          type="button"
                          onClick={() => setNewUser((u) => ({
                            ...u,
                            entityIds: selected ? u.entityIds.filter((n) => n !== ent.name) : [...u.entityIds, ent.name],
                          }))}
                          className={`text-[10px] px-2 py-1 rounded-full border ${selected ? `${style.bg} ${style.text} ${style.border}` : 'bg-gray-50 text-gray-400 border-gray-200'}`}
                        >{ent.name}</button>
                      );
                    })}
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => setShowAddUser(false)} className="flex-1 px-3 py-1.5 border border-gray-200 rounded text-sm text-gray-600">Cancel</button>
                    <button onClick={handleCreateUser} disabled={!newUser.username.trim() || !newUser.password} className="flex-1 px-3 py-1.5 bg-indigo-600 text-white rounded text-sm font-medium disabled:opacity-50">Create User</button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => { loadEntities(); setShowAddUser(true); }}
                  className="w-full flex items-center gap-2 px-4 py-2.5 border-2 border-dashed border-gray-200 rounded-xl text-gray-400 hover:border-indigo-300 hover:text-indigo-500 text-sm font-medium"
                >
                  <span className="text-base">+</span> Add user
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
