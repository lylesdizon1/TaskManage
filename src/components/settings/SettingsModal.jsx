import { useState, useEffect, useMemo } from 'react';
import { useToast } from '../../contexts/ToastContext';
import { GearIcon, XIcon } from '../icons/Icons.jsx';
import { getRuleScope, conditionDescription, uid } from '../../utils/helpers.js';
import { CONDITION_META, EMPTY_NEW_RULE, runAlertRules, buildPlainTextAlert } from '../alerts/alertUtils.js';
import { isValidOAuthUrl } from '../../utils/oauthRedirect.js';
import PersonaSettings from './PersonaSettings';

function RuleRow({ rule, defaultRecipient, onToggle, onDelete, onRecipientChange, onChannelChange, onConditionChange, onIntervalChange }) {
  const [expanded, setExpanded] = useState(false);
  const scope = getRuleScope(rule.condition.type);
  const scopeLabel = { 'per-task': 'per task', daily: 'daily', session: 'once/session' }[scope];
  const channels = rule.channels || { whatsapp: true, slack: true, sms: false, email: true };
  const condType = rule.condition.type;

  return (
    <div className={`rounded-xl border transition-all ${rule.enabled ? 'border-gray-200 bg-white' : 'border-gray-100 bg-gray-50/50'}`}>
      <div className="flex items-center gap-3 px-4 py-3">
        <button onClick={onToggle} className={`relative flex-shrink-0 w-9 h-5 rounded-full transition-colors ${rule.enabled ? 'bg-indigo-600' : 'bg-gray-200'}`} title={rule.enabled ? 'Disable' : 'Enable'}>
          <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${rule.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`text-sm font-medium ${rule.enabled ? 'text-gray-900' : 'text-gray-400'}`}>{rule.name}</span>
            <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded font-medium">{scopeLabel}</span>
            {rule.isCustom && <span className="text-[10px] bg-indigo-100 text-indigo-600 px-1.5 py-0.5 rounded font-medium">custom</span>}
          </div>
          <p className="text-xs text-gray-400 mt-0.5 truncate">{rule.description}</p>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button onClick={() => setExpanded((v) => !v)} className="text-gray-300 hover:text-gray-500 transition-colors p-1" title="Configure channels & options">
            <svg className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {onDelete && <button onClick={onDelete} className="text-gray-300 hover:text-red-400 transition-colors p-1" title="Delete rule"><XIcon className="w-3.5 h-3.5" /></button>}
        </div>
      </div>
      {expanded && (
        <div className="px-4 pb-3 border-t border-gray-100 space-y-3">
          <div className="mt-2.5">
            <label className="block text-xs font-medium text-gray-500 mb-1.5">Channels</label>
            <div className="flex flex-wrap gap-1.5">
              {[
                { key: 'whatsapp', label: 'WhatsApp', color: 'bg-green-500' },
                { key: 'slack',    label: 'Slack',    color: 'bg-purple-500' },
                { key: 'sms',      label: 'SMS',      color: 'bg-blue-500' },
                { key: 'email',    label: 'Email',    color: 'bg-orange-500' },
              ].map(({ key, label, color }) => {
                const on = channels[key];
                const disabled = key === 'sms';
                return (
                  <button key={key} disabled={disabled} title={disabled ? 'Coming soon' : `Toggle ${label}`}
                    onClick={() => onChannelChange && onChannelChange(key, !on)}
                    className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${disabled ? 'bg-gray-100 text-gray-300 cursor-not-allowed' : on ? `${color} text-white` : 'bg-gray-100 text-gray-400 hover:bg-gray-200'}`}
                  >{label}</button>
                );
              })}
            </div>
          </div>
          {['overdue','due-in-hours','high-priority','tag-overdue','tag-match'].includes(rule.condition.type) && (
            <div className="mt-3">
              <label className="text-xs font-medium text-gray-500">Remind again after</label>
              <div className="flex gap-2 mt-1.5 flex-wrap">
                {[1, 4, 12, 24, 48].map((h) => (
                  <button key={h} onClick={() => onIntervalChange && onIntervalChange(h)}
                    className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${rule.remindIntervalHours === h ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
                  >{h < 24 ? `${h}h` : `${h / 24}d`}</button>
                ))}
              </div>
            </div>
          )}
          {channels.email && (
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1.5">
                Recipient override <span className="font-normal text-gray-400">(blank = default: {defaultRecipient || 'not set'})</span>
              </label>
              <input type="email" value={rule.recipientOverride} onChange={(e) => onRecipientChange(e.target.value)}
                placeholder={defaultRecipient || 'override@example.com'}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
          )}
          {condType === 'morning-brief' && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-500 w-16 flex-shrink-0">Time:</label>
              <input type="time" value={rule.condition.time || '08:00'}
                onChange={(e) => onConditionChange && onConditionChange({ ...rule.condition, time: e.target.value })}
                className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
          )}
          {condType === 'event-reminder' && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-500 w-16 flex-shrink-0">Before:</label>
              <select value={rule.condition.minutesBefore || 15}
                onChange={(e) => onConditionChange && onConditionChange({ ...rule.condition, minutesBefore: Number(e.target.value) })}
                className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                {[5, 10, 15, 30, 60].map((m) => <option key={m} value={m}>{m} min</option>)}
              </select>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── MembersSection ─────────────────────────────────────────────────────
// Per-entity member management (Phase 3). Owner-only — parent gates
// rendering on isOwner. Lazy-fetches members on mount; invite + remove
// hit the new /api/entities/:id/members routes.
const ROLE_BADGE = {
  owner:  { background: '#eeedfe', color: '#534ab7' },
  editor: { background: '#eaf3de', color: '#3b6d11' },
  viewer: { background: '#f1efe8', color: '#5f5e5a' },
};

function initialsFor(name) {
  const s = String(name || '').trim();
  if (!s) return '?';
  const parts = s.split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() || '').join('') || '?';
}

function MembersSection({ entityId, currentUserId, apiFetch, authToken }) {
  const [members, setMembers] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [inviteIdentifier, setInviteIdentifier] = useState('');
  const [inviteRole, setInviteRole] = useState('editor');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const reload = async () => {
    try {
      const r = await apiFetch(`/api/entities/${entityId}/members`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const data = await r.json();
      setMembers(Array.isArray(data?.members) ? data.members : []);
      setLoaded(true);
    } catch {
      setLoaded(true);
    }
  };

  useEffect(() => { reload(); }, [entityId]); // eslint-disable-line react-hooks/exhaustive-deps

  const invite = async () => {
    const id = inviteIdentifier.trim();
    if (!id || busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await apiFetch(`/api/entities/${entityId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ identifier: id, role: inviteRole }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        setError(data.error || `HTTP ${r.status}`);
        return;
      }
      setInviteIdentifier('');
      await reload();
    } catch (e) {
      setError(e.message || 'Network error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (userId) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await apiFetch(`/api/entities/${entityId}/members/${encodeURIComponent(userId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        setError(data.error || `HTTP ${r.status}`);
        return;
      }
      await reload();
    } catch (e) {
      setError(e.message || 'Network error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pt-2 mt-1 border-t border-gray-200 space-y-2">
      <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Members</div>
      {!loaded ? (
        <div className="text-xs text-gray-400">Loading…</div>
      ) : members.length === 0 ? (
        <div className="text-xs text-gray-400 italic">No members yet</div>
      ) : (
        <div className="space-y-1">
          {members.map((m) => {
            const badge = ROLE_BADGE[m.role] || ROLE_BADGE.editor;
            const isSelf = m.userId === currentUserId;
            const label = m.displayName || m.username || m.email || m.userId;
            return (
              <div key={m.userId} className="flex items-center gap-2 text-xs">
                <span className="w-6 h-6 rounded-full bg-gray-200 text-gray-600 flex items-center justify-center text-[10px] font-semibold flex-shrink-0">
                  {initialsFor(label)}
                </span>
                <span className="flex-1 truncate text-gray-800">{label}{isSelf ? ' (you)' : ''}</span>
                <span style={{ ...badge, fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 6 }}>{m.role}</span>
                {!isSelf && (
                  <button
                    onClick={() => remove(m.userId)}
                    disabled={busy}
                    className="text-[10px] text-red-500 hover:text-red-700 font-medium disabled:opacity-40"
                  >
                    Remove
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="flex gap-1.5 pt-1">
        <input
          type="text"
          value={inviteIdentifier}
          onChange={(e) => setInviteIdentifier(e.target.value)}
          placeholder="Username or email"
          disabled={busy}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); invite(); } }}
          className="flex-1 px-2 py-1 text-xs bg-white border border-gray-200 rounded text-gray-700 focus:outline-none focus:ring-1 focus:ring-indigo-400"
        />
        <select
          value={inviteRole}
          onChange={(e) => setInviteRole(e.target.value)}
          disabled={busy}
          className="px-2 py-1 text-xs bg-white border border-gray-200 rounded text-gray-700 focus:outline-none focus:ring-1 focus:ring-indigo-400"
        >
          <option value="editor">Editor</option>
          <option value="viewer">Viewer</option>
        </select>
        <button
          onClick={invite}
          disabled={busy || !inviteIdentifier.trim()}
          className="px-2.5 py-1 text-xs font-semibold text-white bg-indigo-600 rounded hover:bg-indigo-700 disabled:opacity-40"
        >
          {busy ? '…' : 'Invite'}
        </button>
      </div>
      {error && <div className="text-[11px] text-red-500">{error}</div>}
    </div>
  );
}

function AlertsTabContent({ rules, onUpdateRules, emailSettings, tasks, firedAlertsRef, addToast, entities, envStatus, apiFetch, authToken, currentUser, EntitySelectOptions }) {
  const [showAdd, setShowAdd]       = useState(false);
  const [newRule, setNewRule]       = useState(EMPTY_NEW_RULE);
  const [evaluating, setEvaluating] = useState(false);
  const [sending, setSending]       = useState(false);
  const [testPicker, setTestPicker] = useState(null);

  const emailConfigured = emailSettings.resendConfigured && emailSettings.recipientEmail;
  const env = envStatus || { slack: false, whatsapp: false, sms: false, email: false };

  function toggleRule(id) { onUpdateRules((prev) => prev.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r))); }
  function deleteRule(id) { onUpdateRules((prev) => prev.filter((r) => r.id !== id)); }
  function updateRecipient(id, value) { onUpdateRules((prev) => prev.map((r) => (r.id === id ? { ...r, recipientOverride: value } : r))); }
  function updateChannel(id, channel, value) { onUpdateRules((prev) => prev.map((r) => r.id === id ? { ...r, channels: { ...(r.channels || {}), [channel]: value } } : r)); }
  function updateInterval(id, hours) { onUpdateRules((prev) => prev.map((r) => r.id === id ? { ...r, remindIntervalHours: hours } : r)); }
  function updateCondition(id, condition) { onUpdateRules((prev) => prev.map((r) => r.id === id ? { ...r, condition, description: conditionDescription(condition) } : r)); }

  function handleAddRule() {
    if (!newRule.name.trim()) return;
    onUpdateRules((prev) => [
      ...prev,
      { id: uid(), name: newRule.name.trim(), description: conditionDescription(newRule.condition), enabled: true, condition: { ...newRule.condition }, channels: { ...newRule.channels }, recipientOverride: newRule.recipientOverride.trim(), isCustom: true },
    ]);
    setNewRule(EMPTY_NEW_RULE);
    setShowAdd(false);
  }

  async function handleEvaluateNow() {
    setEvaluating(true);
    try {
      await runAlertRules(tasks, rules, emailSettings, firedAlertsRef, addToast, apiFetch, authToken, currentUser);
    } catch (err) {
      console.error('runAlertRules failed:', err);
    } finally {
      setEvaluating(false);
    }
  }

  async function handleSendTest(channel) {
    setSending(true);
    try {
      const sampleTasks = tasks.filter((t) => !t.completed).slice(0, 3);
      const message = buildPlainTextAlert('Test Alert', sampleTasks.length ? sampleTasks : tasks.slice(0, 2));
      const ch = { whatsapp: channel === 'whatsapp', slack: channel === 'slack', sms: false, email: channel === 'email' };
      const res = await apiFetch('/api/alerts/fire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ message, channels: ch, recipientEmail: emailSettings.recipientEmail }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.sent?.length) addToast({ type: 'success', message: `Test sent via ${data.sent.join(', ')}` });
      else addToast({ type: 'error', message: `Test failed: ${data.failed?.join(', ') || 'no channels'}` });
    } catch (err) {
      addToast({ type: 'error', message: `Test failed: ${err.message}` });
    } finally {
      setSending(false);
      setTestPicker(null);
    }
  }

  const selectedMeta = CONDITION_META[newRule.condition.type] || {};

  return (
    <div className="space-y-3">
      {/* Evaluate + Test buttons */}
      <div className="flex gap-2">
        <button onClick={handleEvaluateNow} disabled={evaluating}
          className="flex-1 px-3 py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-lg text-xs font-medium transition-colors disabled:opacity-50">
          {evaluating ? 'Running\u2026' : '\u25B6 Evaluate Now'}
        </button>
        {testPicker ? (
          <div className="flex items-center gap-1.5">
            {[
              { key: 'whatsapp', label: 'WA', ok: env.whatsapp },
              { key: 'slack',    label: 'Slack', ok: env.slack },
              { key: 'email',    label: 'Email', ok: env.email },
            ].map(({ key, label, ok }) => (
              <button key={key} disabled={!ok || sending} onClick={() => handleSendTest(key)}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${ok ? 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100' : 'bg-gray-50 text-gray-300 cursor-not-allowed'}`}
              >{label}</button>
            ))}
            <button onClick={() => setTestPicker(null)} className="text-xs text-gray-400 hover:text-gray-600 px-1">Cancel</button>
          </div>
        ) : (
          <button onClick={() => setTestPicker(true)} disabled={sending}
            className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50 text-xs font-medium transition-colors disabled:opacity-50">
            {sending ? 'Sending\u2026' : 'Send Test \u2192'}
          </button>
        )}
      </div>

      {/* Rules list */}
      <div className="space-y-2">
        {rules.map((rule) => (
          <RuleRow
            key={rule.id}
            rule={rule}
            defaultRecipient={emailSettings.recipientEmail}
            onToggle={() => toggleRule(rule.id)}
            onDelete={rule.isCustom ? () => deleteRule(rule.id) : null}
            onRecipientChange={(v) => updateRecipient(rule.id, v)}
            onChannelChange={(ch, val) => updateChannel(rule.id, ch, val)}
            onConditionChange={(cond) => updateCondition(rule.id, cond)}
            onIntervalChange={(h) => updateInterval(rule.id, h)}
          />
        ))}

        {/* Add custom rule */}
        {showAdd ? (
          <div className="border border-indigo-200 rounded-xl p-4 bg-indigo-50/30 mt-2">
            <h4 className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-3">New Custom Rule</h4>
            <div className="space-y-2.5">
              <input type="text" placeholder="Rule name *" value={newRule.name}
                onChange={(e) => setNewRule((r) => ({ ...r, name: e.target.value }))}
                className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              <select value={newRule.condition.type}
                onChange={(e) => setNewRule((r) => ({ ...r, condition: { ...r.condition, type: e.target.value } }))}
                className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                {Object.entries(CONDITION_META).map(([type, meta]) => <option key={type} value={type}>{meta.label}</option>)}
              </select>
              {selectedMeta.hasHours && (
                <div className="flex items-center gap-2">
                  <label className="text-xs text-gray-500 w-16 flex-shrink-0">Hours:</label>
                  <select value={newRule.condition.hours || 24}
                    onChange={(e) => setNewRule((r) => ({ ...r, condition: { ...r.condition, hours: Number(e.target.value) } }))}
                    className="flex-1 px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                    {[2, 4, 8, 24, 48, 72].map((h) => <option key={h} value={h}>{h} h</option>)}
                  </select>
                </div>
              )}
              {selectedMeta.hasTag && (
                <div className="flex items-center gap-2">
                  <label className="text-xs text-gray-500 w-16 flex-shrink-0">Tag:</label>
                  <select value={newRule.condition.tag || (entities[0]?.name || '')}
                    onChange={(e) => setNewRule((r) => ({ ...r, condition: { ...r.condition, tag: e.target.value } }))}
                    className="flex-1 px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                    {EntitySelectOptions && <EntitySelectOptions entities={entities || []} />}
                  </select>
                </div>
              )}
              <input type="email" placeholder="Recipient override (optional)" value={newRule.recipientOverride}
                onChange={(e) => setNewRule((r) => ({ ...r, recipientOverride: e.target.value }))}
                className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              <div className="flex gap-2">
                <button onClick={() => { setShowAdd(false); setNewRule(EMPTY_NEW_RULE); }}
                  className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 text-sm font-medium transition-colors">Cancel</button>
                <button onClick={handleAddRule} disabled={!newRule.name.trim()}
                  className="flex-1 px-3 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium transition-colors disabled:opacity-40">Add Rule</button>
              </div>
            </div>
          </div>
        ) : (
          <button onClick={() => setShowAdd(true)}
            className="w-full flex items-center gap-2 px-4 py-3 border-2 border-dashed border-gray-200 rounded-xl text-gray-400 hover:border-indigo-300 hover:text-indigo-500 hover:bg-indigo-50/20 transition-all text-sm font-medium mt-1">
            <span className="text-base leading-none">+</span> Add custom rule
          </button>
        )}
      </div>
    </div>
  );
}

// ── Email Classification section (Integrations tab) ───────────────────────
const CATEGORIES = ['invoice','receipt','purchase','contract','alert','newsletter','personal','meeting','financial','general'];
const IMPORTANCES = ['critical','high','normal','low'];
const IMPORTANCE_PILL = {
  critical: 'bg-red-50 text-red-700 border-red-200',
  high:     'bg-amber-50 text-amber-700 border-amber-200',
  normal:   'bg-gray-50 text-gray-600 border-gray-200',
  low:      'bg-gray-50 text-gray-400 border-gray-200',
};

const EMPTY_RULE = () => ({
  ruleName: '',
  conditions: { from_domains: [], from_emails: [], subject_contains: [], body_contains: [], any_of: false },
  entityId: null, category: 'general', importance: 'normal', extractAmount: false,
});

function EmailClassificationSection({ apiFetch, authToken, entities }) {
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);       // full rule form state or null
  const [editId, setEditId] = useState(null);         // id if editing, null if adding
  const [confirmDel, setConfirmDel] = useState(null);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestions, setSuggestions] = useState(null);

  const entityById = useMemo(() => {
    const m = new Map();
    for (const e of (entities || [])) m.set(e.id, e);
    return m;
  }, [entities]);

  async function loadRules() {
    setLoading(true);
    try {
      const r = await apiFetch('/api/classification/rules', { headers: { Authorization: `Bearer ${authToken}` } });
      const data = await r.json();
      setRules(Array.isArray(data?.rules) ? data.rules : []);
    } catch { setRules([]); }
    finally { setLoading(false); }
  }
  useEffect(() => { loadRules(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function saveRule() {
    if (!editing) return;
    const body = {
      ruleName: editing.ruleName,
      conditions: editing.conditions,
      entityId: editing.entityId || null,
      category: editing.category, importance: editing.importance,
      extractAmount: !!editing.extractAmount,
    };
    try {
      if (editId) {
        await apiFetch(`/api/classification/rules/${editId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify(body),
        });
      } else {
        await apiFetch('/api/classification/rules', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify(body),
        });
      }
      setEditing(null); setEditId(null);
      loadRules();
    } catch {}
  }

  async function removeRule(id) {
    try {
      await apiFetch(`/api/classification/rules/${id}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` },
      });
      setRules(prev => prev.filter(r => r.id !== id));
    } finally { setConfirmDel(null); }
  }

  async function requestSuggestions() {
    setSuggestLoading(true);
    setSuggestions(null);
    try {
      const r = await apiFetch('/api/classification/suggest', {
        method: 'POST', headers: { Authorization: `Bearer ${authToken}` },
      });
      const data = await r.json();
      setSuggestions(Array.isArray(data?.suggestions) ? data.suggestions : []);
    } catch { setSuggestions([]); }
    finally { setSuggestLoading(false); }
  }

  async function acceptSuggestion(s) {
    try {
      await apiFetch('/api/classification/rules', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          ruleName: s.rule_name,
          conditions: s.conditions || {},
          entityId: s.entity_id || null,
          category: s.category, importance: s.importance,
          extractAmount: !!s.extract_amount,
          source: 'ai_suggested', confirmed: true,
        }),
      });
      setSuggestions(prev => (prev || []).filter(x => x !== s));
      loadRules();
    } catch {}
  }

  return (
    <div className="pt-5 mt-2 border-t border-gray-100">
      <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Email Classification</h3>

      {/* Rules list */}
      {loading ? (
        <div className="space-y-2">{[0,1].map(i => <div key={i} className="h-14 bg-gray-50 rounded-xl animate-pulse" />)}</div>
      ) : rules.length === 0 ? (
        <div className="bg-gray-50 border border-gray-100 rounded-xl px-4 py-5 text-center">
          <p className="text-sm text-gray-600">No rules yet. Add one or get AI suggestions.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {rules.map(r => (
            <div key={r.id} className="bg-white border border-gray-100 rounded-xl shadow-sm px-3 py-2.5">
              <div className="flex items-center gap-2">
                {r.entityId && entityById.get(r.entityId)?.color && (
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: entityById.get(r.entityId).color || '#9ca3af' }} />
                )}
                <span className="text-sm font-semibold text-gray-900 truncate flex-1" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{r.ruleName}</span>
                {r.source === 'ai_suggested' && (
                  <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-2 py-0.5 rounded-full border" style={{ color: '#4f4dcf', borderColor: '#4f4dcf' }}>✨ AI</span>
                )}
                {r.source === 'ai_learned' && (
                  <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-2 py-0.5 rounded-full text-white" style={{ backgroundColor: '#4f4dcf' }}>✨ AI</span>
                )}
                <button onClick={() => { setEditing({ ruleName: r.ruleName, conditions: { from_domains: [], from_emails: [], subject_contains: [], body_contains: [], any_of: false, ...(r.conditions || {}) }, entityId: r.entityId, category: r.category, importance: r.importance, extractAmount: !!r.extractAmount }); setEditId(r.id); }} className="text-[11px] text-gray-500 hover:text-gray-700 font-semibold">Edit</button>
                {confirmDel === r.id ? (
                  <>
                    <span className="text-[11px] text-gray-500">Delete?</span>
                    <button onClick={() => removeRule(r.id)} className="text-[11px] font-semibold text-red-600 hover:text-red-700">Yes</button>
                    <button onClick={() => setConfirmDel(null)} className="text-[11px] text-gray-400 hover:text-gray-600">Cancel</button>
                  </>
                ) : (
                  <button onClick={() => setConfirmDel(r.id)} className="text-[11px] text-red-500 hover:text-red-700 font-semibold">Delete</button>
                )}
              </div>
              <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                <span className="inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-gray-50 text-gray-600 border border-gray-200 capitalize">{r.category}</span>
                <span className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded-full border capitalize ${IMPORTANCE_PILL[r.importance] || IMPORTANCE_PILL.normal}`}>{r.importance}</span>
                <span className="text-[11px] text-gray-400 truncate">{summarizeConditions(r.conditions)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add / edit form */}
      {editing ? (
        <div className="mt-3 bg-white border border-indigo-200 rounded-xl px-3 py-3">
          <RuleForm
            value={editing}
            entities={entities || []}
            onChange={(patch) => setEditing(e => ({ ...e, ...patch }))}
            onCancel={() => { setEditing(null); setEditId(null); }}
            onSave={saveRule}
          />
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={() => { setEditing(EMPTY_RULE()); setEditId(null); }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg"
            style={{ backgroundColor: '#4f4dcf', color: '#fff' }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>add</span>
            Add rule
          </button>
          <button
            onClick={requestSuggestions}
            disabled={suggestLoading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg disabled:opacity-50"
            style={{ backgroundColor: 'transparent', color: '#4f4dcf', border: '1px solid rgba(79,77,207,0.3)' }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>auto_awesome</span>
            {suggestLoading ? 'Aria is analyzing your recent emails…' : 'Get AI Suggestions'}
          </button>
        </div>
      )}

      {/* Suggestions list */}
      {suggestions && suggestions.length > 0 && (
        <div className="mt-3 space-y-2">
          {suggestions.map((s, i) => (
            <div key={i} className="bg-white border border-gray-100 rounded-xl shadow-sm px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined" style={{ color: '#4f4dcf', fontSize: '16px' }}>auto_awesome</span>
                <span className="text-sm font-semibold text-gray-900 flex-1" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{s.rule_name}</span>
                <button onClick={() => acceptSuggestion(s)} className="text-[11px] font-semibold" style={{ color: '#4f4dcf' }}>✓ Add Rule</button>
                <button onClick={() => setSuggestions(prev => (prev || []).filter(x => x !== s))} className="text-[11px] text-gray-400 hover:text-gray-600">✗ Skip</button>
              </div>
              <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                {s.entity_name && <span className="inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-gray-50 text-gray-600 border border-gray-200">{s.entity_name}</span>}
                <span className="inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-gray-50 text-gray-600 border border-gray-200 capitalize">{s.category}</span>
                <span className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded-full border capitalize ${IMPORTANCE_PILL[s.importance] || IMPORTANCE_PILL.normal}`}>{s.importance}</span>
              </div>
              {s.reasoning && <p className="mt-1 text-[11px] text-gray-500">{s.reasoning}</p>}
            </div>
          ))}
        </div>
      )}
      {suggestions && suggestions.length === 0 && (
        <p className="mt-2 text-[11px] text-gray-400">No suggestions right now.</p>
      )}
    </div>
  );
}

function summarizeConditions(c) {
  if (!c) return '';
  const parts = [];
  if (c.from_domains?.length) parts.push(`From: ${c.from_domains.join(', ')}`);
  if (c.from_emails?.length)  parts.push(`Sender: ${c.from_emails.join(', ')}`);
  if (c.subject_contains?.length) parts.push(`Subject: ${c.subject_contains.join(', ')}`);
  if (c.body_contains?.length)    parts.push(`Body: ${c.body_contains.join(', ')}`);
  return parts.join(' • ');
}

function ChipInput({ label, values, onChange, placeholder }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    onChange([...(values || []), v]);
    setDraft('');
  };
  return (
    <div>
      <label className="block text-[11px] font-medium text-gray-600 mb-1">{label}</label>
      <div className="flex flex-wrap gap-1 items-center bg-gray-50 border border-gray-200 rounded-lg px-2 py-1">
        {(values || []).map((v, i) => (
          <span key={i} className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200">
            {v}
            <button onClick={() => onChange(values.filter((_, j) => j !== i))} className="text-indigo-400 hover:text-indigo-600">&times;</button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          onBlur={add}
          placeholder={placeholder}
          className="flex-1 min-w-[80px] bg-transparent text-[12px] focus:outline-none py-1"
        />
      </div>
    </div>
  );
}

function RuleForm({ value, entities, onChange, onCancel, onSave }) {
  const c = value.conditions || {};
  const setCond = (patch) => onChange({ conditions: { ...c, ...patch } });
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-[11px] font-medium text-gray-600 mb-1">Rule name</label>
        <input
          type="text"
          value={value.ruleName}
          onChange={(e) => onChange({ ruleName: e.target.value })}
          placeholder="e.g. Chase statements"
          className="w-full px-2 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </div>

      <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-gray-400" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>Conditions</div>
      <ChipInput label="From domain"      values={c.from_domains}     onChange={(v) => setCond({ from_domains: v })}     placeholder="@chase.com" />
      <ChipInput label="From email"       values={c.from_emails}      onChange={(v) => setCond({ from_emails: v })}      placeholder="person@domain.com" />
      <ChipInput label="Subject contains" values={c.subject_contains} onChange={(v) => setCond({ subject_contains: v })} placeholder="invoice" />
      <ChipInput label="Body contains"    values={c.body_contains}    onChange={(v) => setCond({ body_contains: v })}    placeholder="amount due" />
      <div className="flex items-center gap-4 text-[12px]">
        <label className="inline-flex items-center gap-1.5 cursor-pointer">
          <input type="radio" checked={!!c.any_of} onChange={() => setCond({ any_of: true })} className="accent-indigo-600" />
          <span className="text-gray-700">Match ANY</span>
        </label>
        <label className="inline-flex items-center gap-1.5 cursor-pointer">
          <input type="radio" checked={!c.any_of} onChange={() => setCond({ any_of: false })} className="accent-indigo-600" />
          <span className="text-gray-700">Match ALL</span>
        </label>
      </div>

      <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-gray-400" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>Classification</div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-[11px] font-medium text-gray-600 mb-1">Entity</label>
          <select
            value={value.entityId || ''}
            onChange={(e) => onChange({ entityId: e.target.value || null })}
            className="w-full px-2 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-sm"
          >
            <option value="">None</option>
            {entities.map(en => <option key={en.id} value={en.id}>{en.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[11px] font-medium text-gray-600 mb-1">Category</label>
          <select
            value={value.category}
            onChange={(e) => onChange({ category: e.target.value })}
            className="w-full px-2 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-sm capitalize"
          >
            {CATEGORIES.map(cc => <option key={cc} value={cc}>{cc}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[11px] font-medium text-gray-600 mb-1">Importance</label>
          <select
            value={value.importance}
            onChange={(e) => onChange({ importance: e.target.value })}
            className="w-full px-2 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-sm capitalize"
          >
            {IMPORTANCES.map(im => <option key={im} value={im}>{im}</option>)}
          </select>
        </div>
        <label className="inline-flex items-end gap-2 cursor-pointer pb-1">
          <input type="checkbox" checked={!!value.extractAmount} onChange={(e) => onChange({ extractAmount: e.target.checked })} className="accent-indigo-600" />
          <span className="text-[12px] text-gray-700">Extract amount</span>
        </label>
      </div>

      <div className="flex items-center justify-end gap-2 pt-1">
        <button onClick={onCancel} className="px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50 rounded-lg">Cancel</button>
        <button
          onClick={onSave}
          disabled={!value.ruleName?.trim()}
          className="px-3 py-1.5 text-xs font-semibold rounded-lg disabled:opacity-40"
          style={{ backgroundColor: '#4f4dcf', color: '#fff' }}
        >
          Save Rule
        </button>
      </div>
    </div>
  );
}

// ── Email Auto-Clean section (Integrations tab) ──────────────────────────
const AGE_OPTIONS  = [1, 6, 24, 48, 72];
const THRESHOLDS   = [5, 10, 20, 50, 100];

function EmailAutoCleanSection({ apiFetch, authToken }) {
  const toast = useToast();
  const [policy, setPolicy] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState(null);       // { would_archive, breakdown, accounts }
  const [archiving, setArchiving] = useState(false);

  async function loadPolicy() {
    setLoading(true);
    try {
      const r = await apiFetch('/api/email-clean-policy', { headers: { Authorization: `Bearer ${authToken}` } });
      const data = await r.json();
      setPolicy(data?.policy || null);
    } catch { setPolicy(null); }
    finally { setLoading(false); }
  }
  useEffect(() => { loadPolicy(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function savePolicy() {
    if (!policy) return;
    setSaving(true);
    try {
      const r = await apiFetch('/api/email-clean-policy', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify(policy),
      });
      const data = await r.json();
      if (data?.policy) setPolicy(data.policy);
      try { toast.success('Settings saved', 2500); } catch {}
    } catch {
      try { toast.error('Failed to save settings', 4000); } catch {}
    } finally { setSaving(false); }
  }

  async function runClean() {
    setScan(null);
    setScanning(true);
    try {
      const r = await apiFetch('/api/email-clean-policy/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ confirmed: false }),
      });
      const data = await r.json();
      if (!data || data.would_archive === 0) {
        try { toast.info('Nothing to clean right now.', 3000); } catch {}
        setScan(null);
      } else {
        setScan(data);
      }
    } catch {
      try { toast.error('Scan failed', 4000); } catch {}
    } finally { setScanning(false); }
  }

  async function confirmArchive() {
    setArchiving(true);
    try {
      const r = await apiFetch('/api/email-clean-policy/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ confirmed: true }),
      });
      const data = await r.json();
      const n = data?.archived ?? 0;
      try { toast.success(`Archived ${n} emails from your inbox.`, 3500); } catch {}
      setScan(null);
    } catch {
      try { toast.error('Archive failed', 4000); } catch {}
    } finally { setArchiving(false); }
  }

  if (loading) {
    return (
      <div className="pt-5 mt-2 border-t border-gray-100">
        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Email Auto-Clean</h3>
        <div className="space-y-2">{[0,1,2].map(i => <div key={i} className="h-12 bg-gray-50 rounded-xl animate-pulse" />)}</div>
      </div>
    );
  }
  if (!policy) return null;

  const threshold = policy.confirmationThreshold || 20;
  const showWarn = scan && scan.would_archive >= threshold;

  return (
    <div className="pt-5 mt-2 border-t border-gray-100">
      <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Email Auto-Clean</h3>

      <CleanToggleRow
        label="Archive promotions"
        enabled={!!policy.archivePromos}
        onToggle={(v) => setPolicy({ ...policy, archivePromos: v })}
        age={policy.promosOlderThanH || 24}
        onAgeChange={(v) => setPolicy({ ...policy, promosOlderThanH: v })}
      />
      <CleanToggleRow
        label="Archive newsletters"
        enabled={!!policy.archiveNewsletters}
        onToggle={(v) => setPolicy({ ...policy, archiveNewsletters: v })}
        age={policy.newslettersOlderThanH || 48}
        onAgeChange={(v) => setPolicy({ ...policy, newslettersOlderThanH: v })}
      />
      <CleanToggleRow
        label="Archive social notifications"
        enabled={!!policy.archiveSocial}
        onToggle={(v) => setPolicy({ ...policy, archiveSocial: v })}
        age={policy.socialOlderThanH || 24}
        onAgeChange={(v) => setPolicy({ ...policy, socialOlderThanH: v })}
      />

      <div className="flex items-center gap-2 mt-3">
        <span className="text-[12px] text-gray-600">Show confirmation when archiving more than</span>
        <select
          value={threshold}
          onChange={(e) => setPolicy({ ...policy, confirmationThreshold: parseInt(e.target.value, 10) || 20 })}
          className="px-2 py-1 bg-gray-50 border border-gray-200 rounded-lg text-[12px]"
        >
          {THRESHOLDS.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        <span className="text-[12px] text-gray-600">emails</span>
      </div>
      <p className="text-[11px] text-gray-400 mt-1">Affects messaging only, not execution.</p>

      <div className="flex items-center gap-2 mt-3">
        <button
          onClick={savePolicy}
          disabled={saving}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg disabled:opacity-50"
          style={{ backgroundColor: '#4f4dcf', color: '#fff' }}
        >
          {saving ? 'Saving…' : 'Save Auto-Clean Settings'}
        </button>
        <button
          onClick={runClean}
          disabled={scanning}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg disabled:opacity-50"
          style={{ backgroundColor: 'transparent', color: '#4f4dcf', border: '1px solid rgba(79,77,207,0.3)' }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>play_arrow</span>
          {scanning ? 'Scanning…' : 'Run Clean Now'}
        </button>
      </div>

      {scan && scan.would_archive > 0 && (
        <div className="mt-3 bg-white border border-gray-200 rounded-xl shadow-sm p-3">
          <div className="flex items-center gap-2">
            {showWarn ? (
              <>
                <span className="material-symbols-outlined" style={{ color: '#d97706', fontSize: '18px' }}>warning</span>
                <p className="text-[13px] font-semibold text-gray-900" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                  About to archive {scan.would_archive} emails — this is a lot. Review the breakdown before confirming.
                </p>
              </>
            ) : (
              <>
                <span className="material-symbols-outlined" style={{ color: '#22c55e', fontSize: '18px' }}>check_circle</span>
                <p className="text-[13px] font-semibold text-gray-900" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                  Ready to archive {scan.would_archive} emails:
                </p>
              </>
            )}
          </div>
          <ul className="mt-1.5 ml-6 space-y-0.5 text-[12px] text-gray-600">
            <li>• {scan.breakdown?.promos || 0} promotions</li>
            <li>• {scan.breakdown?.newsletters || 0} newsletters</li>
            <li>• {scan.breakdown?.social || 0} social notifications</li>
          </ul>
          <div className="flex items-center justify-end gap-2 mt-2">
            <button onClick={() => setScan(null)} className="px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50 rounded-lg">Cancel</button>
            <button
              onClick={confirmArchive}
              disabled={archiving}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg disabled:opacity-50"
              style={{ backgroundColor: '#4f4dcf', color: '#fff' }}
            >
              {archiving ? 'Archiving…' : 'Archive Now'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CleanToggleRow({ label, enabled, onToggle, age, onAgeChange }) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <label className="inline-flex items-center gap-2 cursor-pointer flex-1">
        <div
          className={`relative w-9 h-5 rounded-full transition-colors ${enabled ? 'bg-indigo-600' : 'bg-gray-300'}`}
          onClick={() => onToggle(!enabled)}
        >
          <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${enabled ? 'translate-x-4' : ''}`} />
        </div>
        <span className="text-sm text-gray-800" style={{ fontFamily: 'Manrope, sans-serif' }}>{label}</span>
      </label>
      <div className="flex items-center gap-1 text-[12px] text-gray-500">
        <span>older than</span>
        <select
          value={age}
          onChange={(e) => onAgeChange(parseInt(e.target.value, 10))}
          disabled={!enabled}
          className="px-2 py-1 bg-gray-50 border border-gray-200 rounded-lg text-[12px] disabled:opacity-50"
        >
          {AGE_OPTIONS.map(h => <option key={h} value={h}>{h}h</option>)}
        </select>
      </div>
    </div>
  );
}

function EnvBadge() {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold bg-green-100 text-green-700 border border-green-200 px-2 py-0.5 rounded-full ml-2">
      <span className="w-1.5 h-1.5 bg-green-500 rounded-full" />
      Configured via environment
    </span>
  );
}

const PRIORITY_META = {
  high:     { label: 'High Priority',   color: 'bg-red-500',    lightBg: 'bg-red-50',    border: 'border-red-200',    text: 'text-red-700' },
  medium:   { label: 'Medium Priority',  color: 'bg-amber-500',  lightBg: 'bg-amber-50',  border: 'border-amber-200',  text: 'text-amber-700' },
  low:      { label: 'Low Priority',     color: 'bg-green-500',  lightBg: 'bg-green-50',  border: 'border-green-200',  text: 'text-green-700' },
  floating: { label: 'Floating (No Due)', color: 'bg-gray-400',  lightBg: 'bg-gray-50',   border: 'border-gray-200',   text: 'text-gray-600' },
};

const CHANNEL_OPTIONS = [
  { key: 'whatsapp', label: 'WhatsApp', color: 'bg-green-500' },
  { key: 'email',    label: 'Email',    color: 'bg-orange-500' },
  { key: 'slack',    label: 'Slack',    color: 'bg-purple-500' },
];

function AlertCadenceTab({ apiFetch, authToken }) {
  const [configs, setConfigs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [addingOffset, setAddingOffset] = useState(null); // priority key or null
  const [newMinutes, setNewMinutes] = useState('60');
  const [newLabel, setNewLabel] = useState('');
  const [dndStart, setDndStart] = useState('22:00');
  const [dndEnd, setDndEnd] = useState('07:00');
  const toast = useToast();

  useEffect(() => {
    apiFetch('/api/alerts/cadence', {
      headers: { Authorization: `Bearer ${authToken}` },
    })
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setConfigs(data); })
      .catch(() => {})
      .finally(() => setLoading(false));
    // Load DND from user preferences
    apiFetch('/api/preferences', { headers: { Authorization: `Bearer ${authToken}` } })
      .then((r) => r.json())
      .then((prefs) => {
        if (prefs?.dndStart) setDndStart(prefs.dndStart);
        if (prefs?.dndEnd) setDndEnd(prefs.dndEnd);
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function saveConfig(priority, updates) {
    const cfg = configs.find((c) => c.priority === priority);
    if (!cfg) return;
    const body = { offsets: cfg.offsets, channels: cfg.channels, enabled: cfg.enabled, ...updates };
    try {
      const res = await apiFetch(`/api/alerts/cadence/${priority}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const updated = await res.json();
        if (Array.isArray(updated)) setConfigs(updated);
      }
    } catch {
      toast.error('Failed to save cadence config');
    }
  }

  async function saveDnd(start, end) {
    try {
      await apiFetch('/api/preferences/dnd', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ dndStart: start, dndEnd: end }),
      });
    } catch {
      toast.error('Failed to save quiet hours');
    }
  }

  function toggleEnabled(priority) {
    const cfg = configs.find((c) => c.priority === priority);
    if (!cfg) return;
    const next = !cfg.enabled;
    setConfigs((prev) => prev.map((c) => c.priority === priority ? { ...c, enabled: next } : c));
    saveConfig(priority, { enabled: next });
  }

  function toggleChannel(priority, channel) {
    const cfg = configs.find((c) => c.priority === priority);
    if (!cfg) return;
    const channels = cfg.channels.includes(channel)
      ? cfg.channels.filter((c) => c !== channel)
      : [...cfg.channels, channel];
    setConfigs((prev) => prev.map((c) => c.priority === priority ? { ...c, channels } : c));
    saveConfig(priority, { channels });
  }

  function removeOffset(priority, idx) {
    const cfg = configs.find((c) => c.priority === priority);
    if (!cfg) return;
    const offsets = cfg.offsets.filter((_, i) => i !== idx);
    setConfigs((prev) => prev.map((c) => c.priority === priority ? { ...c, offsets } : c));
    saveConfig(priority, { offsets });
  }

  function addOffset(priority) {
    const cfg = configs.find((c) => c.priority === priority);
    if (!cfg) return;
    const mins = parseInt(newMinutes, 10);
    if (isNaN(mins) || mins < 0) return;
    const label = newLabel.trim() || (mins === 0 ? 'At due time' : mins < 60 ? `${mins} min before` : mins < 1440 ? `${mins / 60}h before` : `${mins / 1440}d before`);
    const offsets = [...cfg.offsets, { minutes_before: mins, label }];
    setConfigs((prev) => prev.map((c) => c.priority === priority ? { ...c, offsets } : c));
    saveConfig(priority, { offsets });
    setAddingOffset(null);
    setNewMinutes('60');
    setNewLabel('');
  }

  if (loading) {
    return <div className="flex items-center justify-center py-12 text-gray-400 text-sm">Loading cadence config...</div>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-700">Alert Cadence</h3>
        <p className="text-xs text-gray-400 mt-0.5">Configure when Aria sends reminders based on task priority. Alerts fire automatically via the server-side scheduler.</p>
      </div>

      {/* Quiet Hours / DND */}
      <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
        <div className="flex items-center gap-2 mb-2">
          <span className="material-symbols-outlined text-base text-gray-400">do_not_disturb_on</span>
          <span className="text-sm font-medium text-gray-900">Quiet Hours</span>
        </div>
        <p className="text-xs text-gray-400 mb-2.5">No alerts will fire during this window. Applies to all priorities.</p>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-gray-500">From</span>
          <input
            type="time"
            value={dndStart}
            onChange={(e) => { setDndStart(e.target.value); saveDnd(e.target.value, dndEnd); }}
            className="px-2 py-1 border border-gray-200 rounded-lg text-sm focus:border-indigo-300 focus:ring-1 focus:ring-indigo-200 outline-none"
          />
          <span className="text-gray-500">to</span>
          <input
            type="time"
            value={dndEnd}
            onChange={(e) => { setDndEnd(e.target.value); saveDnd(dndStart, e.target.value); }}
            className="px-2 py-1 border border-gray-200 rounded-lg text-sm focus:border-indigo-300 focus:ring-1 focus:ring-indigo-200 outline-none"
          />
        </div>
      </div>

      {['high', 'medium', 'low', 'floating'].map((priority) => {
        const cfg = configs.find((c) => c.priority === priority);
        if (!cfg) return null;
        const meta = PRIORITY_META[priority];

        return (
          <div key={priority} className={`rounded-xl border transition-all ${cfg.enabled ? 'border-gray-200 bg-white' : 'border-gray-100 bg-gray-50/50'}`}>
            <div className="flex items-center gap-3 px-4 py-3">
              <button onClick={() => toggleEnabled(priority)} className={`relative flex-shrink-0 w-9 h-5 rounded-full transition-colors ${cfg.enabled ? 'bg-indigo-600' : 'bg-gray-200'}`}>
                <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${cfg.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
              </button>
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <span className={`w-2 h-2 rounded-full ${meta.color}`} />
                <span className={`text-sm font-medium ${cfg.enabled ? 'text-gray-900' : 'text-gray-400'}`}>{meta.label}</span>
              </div>
            </div>

            {cfg.enabled && (
              <div className="px-4 pb-4 border-t border-gray-100 space-y-3">
                {/* Channels */}
                <div className="mt-2.5">
                  <label className="block text-xs font-medium text-gray-500 mb-1.5">Channels</label>
                  <div className="flex flex-wrap gap-1.5">
                    {CHANNEL_OPTIONS.map(({ key, label, color }) => {
                      const on = cfg.channels.includes(key);
                      return (
                        <button key={key} onClick={() => toggleChannel(priority, key)}
                          className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${on ? `${color} text-white` : 'bg-gray-100 text-gray-400 hover:bg-gray-200'}`}
                        >{label}</button>
                      );
                    })}
                  </div>
                </div>

                {/* Offset chips */}
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1.5">Reminder Timing</label>
                  <div className="flex flex-wrap gap-1.5">
                    {cfg.offsets.map((o, i) => (
                      <span key={i} className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full ${meta.lightBg} ${meta.text} border ${meta.border}`}>
                        {o.label || (o.minutes_before !== undefined ? `${o.minutes_before}min before` : `Day ${o.day_of_week} @ ${o.hour}:00`)}
                        <button onClick={() => removeOffset(priority, i)} className="opacity-50 hover:opacity-100 ml-0.5">&times;</button>
                      </span>
                    ))}
                    {addingOffset === priority ? (
                      <div className="flex items-center gap-1.5">
                        <input
                          type="number"
                          min="0"
                          value={newMinutes}
                          onChange={(e) => setNewMinutes(e.target.value)}
                          placeholder="Minutes"
                          className="w-20 px-2 py-1 text-xs border border-gray-200 rounded-lg focus:border-indigo-300 focus:ring-1 focus:ring-indigo-200 outline-none"
                        />
                        <input
                          type="text"
                          value={newLabel}
                          onChange={(e) => setNewLabel(e.target.value)}
                          placeholder="Label (optional)"
                          onKeyDown={(e) => { if (e.key === 'Enter') addOffset(priority); }}
                          className="w-32 px-2 py-1 text-xs border border-gray-200 rounded-lg focus:border-indigo-300 focus:ring-1 focus:ring-indigo-200 outline-none"
                        />
                        <button onClick={() => addOffset(priority)} className="px-2 py-1 text-xs font-medium text-indigo-600 border border-indigo-200 rounded-lg hover:bg-indigo-50">Add</button>
                        <button onClick={() => setAddingOffset(null)} className="px-2 py-1 text-xs text-gray-400 hover:text-gray-600">&times;</button>
                      </div>
                    ) : (
                      <button onClick={() => setAddingOffset(priority)} className="px-2.5 py-1 rounded-full text-[11px] font-medium bg-gray-100 text-gray-400 hover:bg-gray-200 hover:text-gray-600 transition-colors">
                        + Add timing
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function SettingsModal({ apiKeys, onSave, emailSettings, onSaveEmail, onClose, envConfigured = {}, authToken, currentUser, entities, onEntitiesChanged, onUserUpdated, apiFetch, alertRules, onUpdateAlertRules, tasks, firedAlertsRef, envStatus, addToast: addToastProp, EntitySelectOptions, initialTab }) {
  const [tab, setTab]               = useState(initialTab || 'keys');
  const [draftKeys, setDraftKeys]   = useState({ ...apiKeys });
  const [draftEmail, setDraftEmail] = useState({ ...emailSettings });
  const [testing, setTesting]       = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [pwForm, setPwForm]         = useState({ current: '', newPw: '', confirm: '' });
  const [pwStatus, setPwStatus]     = useState(null);
  const [pwSaving, setPwSaving]     = useState(false);

  // Entity state
  const [newEntityName, setNewEntityName] = useState('');
  const [entityLoading, setEntityLoading] = useState(false);
  const [gcalCalendars, setGcalCalendars] = useState([]);

  // Fetch GCal calendars when entities tab is active
  useEffect(() => {
    if (tab !== 'entities') return;
    apiFetch('/api/gcal/calendars', { headers: { Authorization: `Bearer ${authToken}` } })
      .then(r => r.ok ? r.json() : [])
      .then(setGcalCalendars)
      .catch(() => {});
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const addToast = addToastProp || (() => {});

  async function handleCreateEntity() {
    if (!newEntityName.trim()) return;
    setEntityLoading(true);
    try {
      const res = await apiFetch('/api/entities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ name: newEntityName.trim(), type: 'business' }),
      });
      const data = await res.json();
      if (!res.ok) {
        addToast({ type: 'error', message: data.error || 'Failed to create entity' });
        return;
      }
      setNewEntityName('');
      addToast({ type: 'success', message: `Created "${data.name}"` });
      // Small delay before reload so DB write is fully committed
      setTimeout(() => onEntitiesChanged(), 300);
    } catch (err) {
      addToast({ type: 'error', message: err.message || 'Failed to create entity' });
    } finally {
      setEntityLoading(false);
    }
  }

  async function handleDeleteEntity(id) {
    if (!window.confirm('Delete this entity? Tasks and notes tagged with it will lose this tag.')) return;
    try {
      const res = await apiFetch(`/api/entities/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        addToast({ type: 'error', message: data.error || 'Failed to delete entity' });
        return;
      }
      onEntitiesChanged();
    } catch (err) {
      addToast({ type: 'error', message: `Delete failed: ${err.message}` });
    }
  }

  async function handleLinkCalendar(entityId, calendarId) {
    const cal = gcalCalendars.find(c => c.calendarId === calendarId);
    const body = { calendarId: calendarId || null };
    if (cal?.backgroundColor) {
      body.color = cal.backgroundColor;
      body.colorSource = 'gcal';
    } else if (!calendarId) {
      body.colorSource = 'system';
    }
    await apiFetch(`/api/entities/${entityId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify(body),
    });
    onEntitiesChanged();
  }

  async function handleEntityColorChange(entityId, color) {
    await apiFetch(`/api/entities/${entityId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ color, colorSource: 'user' }),
    });
    onEntitiesChanged();
  }

  // Persona state
  const [personaName, setPersonaName] = useState(currentUser?.assistantName || 'Aria');
  const [personaType, setPersonaType] = useState(currentUser?.persona || 'executive_assistant');
  const [personaSaving, setPersonaSaving] = useState(false);

  // Aria Learnings (Profile tab — bottom section)
  const [learnings, setLearnings] = useState([]);
  const [learningsLoading, setLearningsLoading] = useState(false);
  const [showAllLearnings, setShowAllLearnings] = useState(false);
  const [confirmDeleteLearning, setConfirmDeleteLearning] = useState(null);
  async function loadLearnings() {
    setLearningsLoading(true);
    try {
      const res = await apiFetch('/api/learnings', { headers: { Authorization: `Bearer ${authToken}` } });
      const data = await res.json();
      setLearnings(Array.isArray(data?.learnings) ? data.learnings : []);
    } catch {
      setLearnings([]);
    } finally {
      setLearningsLoading(false);
    }
  }
  async function deleteLearning(id) {
    try {
      await apiFetch(`/api/learnings/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` } });
      setLearnings((prev) => prev.filter((l) => l.id !== id));
    } finally {
      setConfirmDeleteLearning(null);
    }
  }
  useEffect(() => { if (tab === 'assistant') loadLearnings(); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps
  const [personaStatus, setPersonaStatus] = useState(null);

  // WhatsApp phone verification state — phone CHANGES route through the
  // OTP flow; the read-only display sources from currentUser directly so
  // it reacts to onUserUpdated callbacks after confirm/clear.
  const [waMode, setWaMode] = useState('idle'); // 'idle' | 'editing' | 'awaiting'
  const [waPhoneInput, setWaPhoneInput] = useState('');
  const [waCodeInput, setWaCodeInput] = useState('');
  const [waPendingPhone, setWaPendingPhone] = useState(''); // phone we sent the code to
  const [waBusy, setWaBusy] = useState(false);
  const [waStatus, setWaStatus] = useState(null); // { ok: bool, msg: string }

  function waErrorText(reason) {
    switch (reason) {
      case 'invalid_phone':       return 'Phone must be 7–15 digits.';
      case 'send_failed':         return "Couldn't send the code. Try again in a moment.";
      case 'invalid_code':        return 'Code must be 4–8 digits.';
      case 'no_pending':          return 'No verification in progress. Start over.';
      case 'expired':             return 'Code expired. Request a new one.';
      case 'too_many_attempts':   return 'Too many wrong codes. Start over.';
      case 'bad_code':            return 'Wrong code. Try again.';
      case 'already_claimed':     return 'That number is already in use on another account.';
      default:                    return reason || 'Something went wrong.';
    }
  }

  async function waStartVerify() {
    const phone = waPhoneInput.trim();
    if (!phone) return;
    setWaBusy(true); setWaStatus(null);
    try {
      const res = await apiFetch('/api/users/whatsapp-phone/start-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ phone }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setWaPendingPhone(phone);
        setWaCodeInput('');
        setWaMode('awaiting');
        setWaStatus({ ok: true, msg: `Code sent to ${phone}. Check your WhatsApp.` });
      } else {
        setWaStatus({ ok: false, msg: waErrorText(data.error) });
      }
    } catch (err) {
      setWaStatus({ ok: false, msg: err.message });
    } finally { setWaBusy(false); }
  }

  async function waConfirm() {
    const code = waCodeInput.trim();
    if (!code) return;
    setWaBusy(true); setWaStatus(null);
    try {
      const res = await apiFetch('/api/users/whatsapp-phone/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ code }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        // Re-fetch the user via the settings PUT (no-op body) just to grab
        // the updated whatsappPhone + verifiedAt — simpler than adding a
        // dedicated /me endpoint right now.
        const refreshed = await apiFetch('/api/users/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({}),
        });
        const refreshedData = await refreshed.json().catch(() => null);
        if (refreshed.ok && refreshedData && onUserUpdated) onUserUpdated(refreshedData);
        setWaMode('idle');
        setWaPhoneInput(''); setWaCodeInput(''); setWaPendingPhone('');
        setWaStatus({ ok: true, msg: 'WhatsApp number verified.' });
      } else {
        setWaStatus({ ok: false, msg: waErrorText(data.error) });
      }
    } catch (err) {
      setWaStatus({ ok: false, msg: err.message });
    } finally { setWaBusy(false); }
  }

  async function waRemove() {
    if (!window.confirm('Remove your WhatsApp number? Aria will stop messaging you there.')) return;
    setWaBusy(true); setWaStatus(null);
    try {
      const res = await apiFetch('/api/users/whatsapp-phone', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        const refreshed = await apiFetch('/api/users/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({}),
        });
        const refreshedData = await refreshed.json().catch(() => null);
        if (refreshed.ok && refreshedData && onUserUpdated) onUserUpdated(refreshedData);
        setWaMode('idle');
        setWaStatus({ ok: true, msg: 'Number removed.' });
      } else {
        setWaStatus({ ok: false, msg: 'Failed to remove number.' });
      }
    } catch (err) {
      setWaStatus({ ok: false, msg: err.message });
    } finally { setWaBusy(false); }
  }

  function waCancel() {
    setWaMode('idle');
    setWaPhoneInput(''); setWaCodeInput(''); setWaPendingPhone('');
    setWaStatus(null);
  }

  // Profile fields
  const [profileName, setProfileName] = useState(currentUser?.profileName || '');
  const [profileBusinesses, setProfileBusinesses] = useState(currentUser?.profileBusinesses || '');
  const [profileHousehold, setProfileHousehold] = useState(currentUser?.profileHousehold || '');
  const [profileLocation, setProfileLocation] = useState(currentUser?.profileLocation || '');
  const [profileNotes, setProfileNotes] = useState(currentUser?.profileNotes || '');

  // ── Gmail / Email Intelligence state ──
  const [gmailAccounts, setGmailAccounts] = useState([]);
  const [gmailConfig, setGmailConfig] = useState({
    vipSenders: [], triggerKeywords: [], commitmentDetection: true,
    excludedSenders: [], autoExcludeNoreply: true,
    scanFrequency: '1h', scanWindow: '24h',
  });
  const [gmailLoading, setGmailLoading] = useState(false);
  const [outlookAccounts, setOutlookAccounts] = useState([]);
  const [outlookLoading, setOutlookLoading] = useState(false);
  const [newVip, setNewVip] = useState('');
  const [newKeyword, setNewKeyword] = useState('');
  const [newExclusion, setNewExclusion] = useState('');
  const [configSaving, setConfigSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const settingsToast = useToast();


  useEffect(() => {
    if (tab === 'gmail') { loadGmailData(); loadOutlookAccounts(); }
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadOutlookAccounts() {
    try {
      const res = await apiFetch('/api/outlook/accounts', { headers: { Authorization: `Bearer ${authToken}` } });
      const data = await res.json();
      setOutlookAccounts(Array.isArray(data) ? data : []);
    } catch {
      setOutlookAccounts([]);
    }
  }

  async function handleOutlookConnect() {
    setOutlookLoading(true);
    try {
      const res = await apiFetch('/api/outlook/auth-url', { headers: { Authorization: `Bearer ${authToken}` } });
      const { url, error } = await res.json();
      if (url) {
        if (!isValidOAuthUrl(url)) {
          settingsToast.error('Invalid OAuth redirect rejected');
          return;
        }
        window.location.href = url;
        return;
      }
      settingsToast.error(error || 'Outlook OAuth not configured');
    } catch {
      settingsToast.error('Outlook OAuth not configured');
    } finally {
      setOutlookLoading(false);
    }
  }

  async function handleOutlookDisconnect(id) {
    setOutlookLoading(true);
    try {
      await apiFetch(`/api/outlook/accounts/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` } });
      await loadOutlookAccounts();
    } catch {} finally {
      setOutlookLoading(false);
    }
  }

  async function loadGmailAccounts() {
    try {
      const res = await apiFetch('/api/gmail/accounts', { headers: { Authorization: `Bearer ${authToken}` } });
      const data = await res.json();
      setGmailAccounts(Array.isArray(data) ? data : []);
    } catch {
      setGmailAccounts([]);
    }
  }

  async function loadGmailData() {
    try {
      const [accountsRes, configRes] = await Promise.all([
        apiFetch('/api/gmail/accounts', { headers: { Authorization: `Bearer ${authToken}` } }),
        apiFetch('/api/gmail/config', { headers: { Authorization: `Bearer ${authToken}` } }),
      ]);
      const accountsData = await accountsRes.json();
      const configData = await configRes.json();
      setGmailAccounts(Array.isArray(accountsData) ? accountsData : []);
      setGmailConfig({
        vipSenders: [], triggerKeywords: [], commitmentDetection: true,
        excludedSenders: [], autoExcludeNoreply: true,
        scanFrequency: '1h', scanWindow: '24h',
        ...(configData || {}),
      });
    } catch {}
  }

  async function handleGmailConnect() {
    setGmailLoading(true);
    try {
      const res = await apiFetch('/api/gmail/auth-url', { headers: { Authorization: `Bearer ${authToken}` } });
      const { url } = await res.json();
      if (!isValidOAuthUrl(url)) {
        settingsToast.error('Invalid OAuth redirect rejected');
        setGmailLoading(false);
        return;
      }
      window.location.href = url;
    } catch {
      setGmailLoading(false);
    }
  }

  async function handleDisconnectAccount(id) {
    setGmailLoading(true);
    try {
      await apiFetch(`/api/gmail/accounts/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` } });
      await loadGmailAccounts();
    } catch {} finally {
      setGmailLoading(false);
    }
  }

  async function handleSaveGmailConfig() {
    setConfigSaving(true);
    try {
      await apiFetch('/api/gmail/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ config: gmailConfig }),
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
        <div className="flex flex-nowrap border-b border-gray-100 mx-6 overflow-x-auto">
          {[
            { key: 'keys',  label: 'Models' },
            { key: 'alerts', label: 'Alerts' },
            { key: 'integrations', label: 'Integrations' },
            { key: 'assistant', label: 'Profile' },
            { key: 'entities', label: 'Entities' },
            { key: 'password', label: 'Password' },
            { key: 'cadence', label: 'Alert Cadence' },
            { key: 'gmail', label: 'Email Intelligence' },
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

        <div className="px-6 py-5 flex-1 min-h-0 overflow-y-auto">
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

          {/* Alerts tab */}
          {tab === 'alerts' && <AlertsTabContent
            rules={alertRules}
            onUpdateRules={onUpdateAlertRules}
            emailSettings={emailSettings}
            tasks={tasks}
            firedAlertsRef={firedAlertsRef}
            addToast={addToastProp || settingsToast.success}
            entities={entities}
            envStatus={envStatus}
            apiFetch={apiFetch}
            authToken={authToken}
            currentUser={currentUser}
            EntitySelectOptions={EntitySelectOptions}
          />}

          {/* Integrations tab */}
          {tab === 'integrations' && (
            <div className="space-y-6">
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Email</h3>

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

              <div className="pt-4 border-t border-gray-100">
                <div className="px-3 py-3 rounded-xl bg-gray-50 border border-gray-200 text-sm text-gray-400 select-none">
                  WhatsApp &middot; Slack &middot; Google Calendar &middot; Gmail &mdash; coming soon
                </div>
              </div>

              <EmailClassificationSection apiFetch={apiFetch} authToken={authToken} entities={entities} />
              <EmailAutoCleanSection apiFetch={apiFetch} authToken={authToken} />
            </div>
          )}

          {/* Profile tab */}
          {tab === 'assistant' && (
            <div className="space-y-6">
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Assistant</h3>

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
              </div>

              <div className="border-t border-gray-100 pt-4 mt-2">
                <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Your Profile</h3>

                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Your Name</label>
                    <input
                      type="text"
                      value={profileName}
                      onChange={(e) => setProfileName(e.target.value)}
                      placeholder="Your name"
                      className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Businesses</label>
                    <input
                      type="text"
                      value={profileBusinesses}
                      onChange={(e) => setProfileBusinesses(e.target.value)}
                      placeholder="Comma-separated list of businesses"
                      className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Family / Household</label>
                    <input
                      type="text"
                      value={profileHousehold}
                      onChange={(e) => setProfileHousehold(e.target.value)}
                      placeholder="e.g. partner, kids, co-operator"
                      className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition"
                    />
                    <p className="text-xs text-gray-400 mt-1">For Aria&rsquo;s context only — not a system connection</p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Location</label>
                    <input
                      type="text"
                      value={profileLocation}
                      onChange={(e) => setProfileLocation(e.target.value)}
                      placeholder="Alamo/Danville, CA"
                      className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Additional Context</label>
                    <textarea
                      value={profileNotes}
                      onChange={(e) => setProfileNotes(e.target.value)}
                      placeholder="Anything else Aria should know about you"
                      rows={3}
                      className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition resize-none"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">WhatsApp Phone Number</label>
                    {waMode === 'idle' && currentUser?.whatsappPhone && (
                      <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl">
                        <span className="text-sm text-gray-900 flex-1">{currentUser.whatsappPhone}</span>
                        {currentUser.whatsappVerifiedAt ? (
                          <span className="text-[10px] uppercase tracking-wide font-semibold text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded-full">Verified</span>
                        ) : (
                          <span className="text-[10px] uppercase tracking-wide font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full" title="Set before verification was required — re-verify to confirm">Legacy</span>
                        )}
                        <button type="button" onClick={() => { setWaPhoneInput(''); setWaMode('editing'); setWaStatus(null); }} disabled={waBusy} className="text-xs text-indigo-600 hover:text-indigo-700 font-medium disabled:opacity-50">Change</button>
                        <button type="button" onClick={waRemove} disabled={waBusy} className="text-xs text-red-600 hover:text-red-700 font-medium disabled:opacity-50">Remove</button>
                      </div>
                    )}
                    {waMode === 'idle' && !currentUser?.whatsappPhone && (
                      <button type="button" onClick={() => { setWaPhoneInput(''); setWaMode('editing'); setWaStatus(null); }} className="w-full px-3 py-2 bg-indigo-50 border border-indigo-200 rounded-xl text-sm text-indigo-700 hover:bg-indigo-100 font-medium">+ Add WhatsApp number</button>
                    )}
                    {waMode === 'editing' && (
                      <div className="space-y-2">
                        <input
                          type="tel"
                          value={waPhoneInput}
                          onChange={(e) => setWaPhoneInput(e.target.value)}
                          placeholder="+1 555 123 4567"
                          autoFocus
                          className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition"
                        />
                        <div className="flex items-center gap-2">
                          <button type="button" onClick={waStartVerify} disabled={waBusy || !waPhoneInput.trim()} className="flex-1 px-3 py-2 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 font-medium text-sm transition-colors disabled:opacity-50">{waBusy ? 'Sending\u2026' : 'Send code via WhatsApp'}</button>
                          <button type="button" onClick={waCancel} disabled={waBusy} className="px-3 py-2 text-sm text-gray-600 hover:text-gray-800 font-medium disabled:opacity-50">Cancel</button>
                        </div>
                      </div>
                    )}
                    {waMode === 'awaiting' && (
                      <div className="space-y-2">
                        <p className="text-xs text-gray-600">Code sent to <span className="font-semibold text-gray-900">{waPendingPhone}</span> via WhatsApp. Enter it below (valid 10 minutes).</p>
                        <input
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          maxLength={6}
                          value={waCodeInput}
                          onChange={(e) => setWaCodeInput(e.target.value.replace(/[^0-9]/g, ''))}
                          placeholder="123456"
                          autoFocus
                          className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition tracking-widest font-mono text-center"
                        />
                        <div className="flex items-center gap-2">
                          <button type="button" onClick={waConfirm} disabled={waBusy || waCodeInput.length < 4} className="flex-1 px-3 py-2 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 font-medium text-sm transition-colors disabled:opacity-50">{waBusy ? 'Verifying\u2026' : 'Verify'}</button>
                          <button type="button" onClick={() => { setWaPhoneInput(waPendingPhone); setWaMode('editing'); setWaStatus(null); }} disabled={waBusy} className="px-3 py-2 text-sm text-gray-600 hover:text-gray-800 font-medium disabled:opacity-50">Resend / change</button>
                        </div>
                      </div>
                    )}
                    {waStatus && (
                      <p className={`text-xs mt-2 ${waStatus.ok ? 'text-green-700' : 'text-red-600'}`}>{waStatus.msg}</p>
                    )}
                    <p className="text-xs text-gray-400 mt-2">Two-way messaging with Aria. Verification is sent via WhatsApp to prove you own the number.</p>
                  </div>
                </div>
              </div>

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
                      body: JSON.stringify({
                        persona: personaType,
                        assistantName: personaName.trim() || 'Aria',
                        // whatsappPhone intentionally omitted — changes route
                        // through the verification flow (start-verify + confirm).
                        profileName: profileName.trim() || null,
                        profileBusinesses: profileBusinesses.trim() || null,
                        profileHousehold: profileHousehold.trim() || null,
                        profileLocation: profileLocation.trim() || null,
                        profileNotes: profileNotes.trim() || null,
                      }),
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

              <div className="border-t border-gray-100 pt-4 mt-6">
                <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Aria Learnings</h3>
                {learningsLoading ? (
                  <div className="space-y-2">
                    {[0,1,2].map(i => <div key={i} className="h-9 bg-gray-50 rounded-lg animate-pulse" />)}
                  </div>
                ) : learnings.length === 0 ? (
                  <div className="bg-gray-50 border border-gray-100 rounded-xl px-4 py-5 text-center">
                    <p className="text-sm text-gray-600">Aria hasn&rsquo;t learned any preferences yet.</p>
                    <p className="text-xs text-gray-400 mt-1">Correct her or give her an instruction and she&rsquo;ll remember it here.</p>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-gray-500">{learnings.filter(l => showAllLearnings || l.confidence !== 'one-off').length} shown</span>
                      <label className="inline-flex items-center gap-2 cursor-pointer text-xs text-gray-600">
                        <input type="checkbox" checked={showAllLearnings} onChange={(e) => setShowAllLearnings(e.target.checked)} className="w-3.5 h-3.5 accent-indigo-600" />
                        Show all
                      </label>
                    </div>
                    <div className="space-y-1.5">
                      {learnings.filter(l => showAllLearnings || l.confidence !== 'one-off').map((l) => {
                        const badgeCls = l.confidence === 'rule'
                          ? 'text-white'
                          : l.confidence === 'pattern'
                            ? 'text-indigo-700 border border-indigo-300'
                            : 'text-gray-500 border border-gray-200';
                        const badgeStyle = l.confidence === 'rule' ? { backgroundColor: '#4f4dcf' } : {};
                        return (
                          <div key={l.id} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-100 bg-white">
                            <span className={`inline-block text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full ${badgeCls}`} style={badgeStyle}>
                              {l.confidence}
                            </span>
                            <span className="flex-1 text-sm text-gray-800 truncate">{l.ruleText}</span>
                            {l.scope && l.scope !== 'global' && (
                              <span className="text-[10px] text-gray-400 truncate">{l.scope}{l.scopeValue ? `: ${l.scopeValue}` : ''}</span>
                            )}
                            {confirmDeleteLearning === l.id ? (
                              <>
                                <span className="text-[11px] text-gray-500">Remove?</span>
                                <button onClick={() => deleteLearning(l.id)} className="text-[11px] font-semibold text-red-600 hover:text-red-700 px-1">Yes</button>
                                <button onClick={() => setConfirmDeleteLearning(null)} className="text-[11px] text-gray-400 hover:text-gray-600 px-1">Cancel</button>
                              </>
                            ) : (
                              <button onClick={() => setConfirmDeleteLearning(l.id)} className="text-gray-300 hover:text-red-500 transition-colors" title="Remove">
                                <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>close</span>
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Entities tab */}
          {tab === 'entities' && (
            <div className="space-y-5">
              <div>
                <h3 className="text-sm font-semibold text-gray-800 mb-1">Your Entities</h3>
                <p className="text-xs text-gray-500">Entities are labels for your businesses, projects, and personal areas. Use them to tag tasks and notes.</p>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newEntityName}
                  onChange={(e) => setNewEntityName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreateEntity()}
                  placeholder="Entity name (e.g. Rose Motorcars)"
                  className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <button
                  onClick={handleCreateEntity}
                  disabled={entityLoading || !newEntityName.trim()}
                  className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg disabled:opacity-50 hover:bg-indigo-700 transition"
                >
                  Add
                </button>
              </div>
              <div className="space-y-2">
                {entities.map((e, idx) => {
                  const ENTITY_COLORS = ['#4f4dcf','#0ea5e9','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#14b8a6'];
                  const swatchColor = (e.color && e.color.startsWith('#')) ? e.color : ENTITY_COLORS[idx % ENTITY_COLORS.length];
                  return (
                  <div key={e.id} className="px-3 py-2.5 bg-gray-50 rounded-lg border border-gray-100 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <label className="relative w-5 h-5 flex-shrink-0 cursor-pointer" title="Change color">
                          <span className="block w-5 h-5 rounded-full border border-gray-200" style={{ backgroundColor: swatchColor }} />
                          <input type="color" value={swatchColor} onChange={(ev) => handleEntityColorChange(e.id, ev.target.value)}
                            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
                        </label>
                        <span className="text-sm font-medium text-gray-800">{e.name}</span>
                        {e.shared && <span className="ml-2 text-[10px] font-bold text-indigo-500 uppercase">Shared</span>}
                      </div>
                      {e.isOwner && (
                        <button
                          onClick={() => handleDeleteEntity(e.id)}
                          className="text-xs text-red-500 hover:text-red-700 font-medium transition"
                        >
                          Delete
                        </button>
                      )}
                    </div>
                    {e.isOwner && gcalCalendars.length > 0 && (
                      <select
                        value={e.calendarId || ''}
                        onChange={(ev) => handleLinkCalendar(e.id, ev.target.value)}
                        className="w-full px-2 py-1.5 text-xs bg-white border border-gray-200 rounded-lg text-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      >
                        <option value="">Link a calendar…</option>
                        {gcalCalendars.map(cal => {
                          const label = cal.summary === cal.account ? `Primary (${cal.account})` : `${cal.summary} (${cal.account})`;
                          return (
                            <option key={`${cal.account}::${cal.calendarId}`} value={cal.calendarId}>
                              {label}
                            </option>
                          );
                        })}
                      </select>
                    )}
                    {e.isOwner && (
                      <MembersSection
                        entityId={e.id}
                        currentUserId={currentUser?.id}
                        apiFetch={apiFetch}
                        authToken={authToken}
                      />
                    )}
                  </div>
                  );
                })}
                {entities.length === 0 && (
                  <p className="text-sm text-gray-400 text-center py-4">No entities yet. Add one above.</p>
                )}
              </div>
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

          {/* Alert Cadence tab */}
          {tab === 'cadence' && (
            <AlertCadenceTab apiFetch={apiFetch} authToken={authToken} />
          )}

          {/* Email Intelligence tab */}
          {tab === 'gmail' && (
            <div className="space-y-6">
              {/* Gmail Accounts */}
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Gmail Accounts</h3>
                <div className="space-y-2">
                  {gmailAccounts.length === 0 && (
                    <div className="text-xs text-gray-400 italic px-3 py-2">No accounts connected yet.</div>
                  )}
                  {/* 2026-05-08: surface auth-revocation per account.
                      red dot + "Reconnect needed" badge + Reconnect
                      button. The pre-fix UI showed a green dot for the
                      ~14 days a token was actually dead. */}
                  {gmailAccounts.map((a) => {
                    const broken = a.auth_status === 'needs_reauth';
                    return (
                      <div key={a.id} className="flex items-center justify-between p-3 rounded-lg border border-gray-100 bg-gray-50/50">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${broken ? 'bg-red-500' : 'bg-green-500'}`} />
                          <span className={`text-sm truncate ${broken ? 'text-red-700' : 'text-gray-700'}`}>
                            {a.account_email || '(unknown email — reconnect to refresh)'}
                          </span>
                          {broken && (
                            <span
                              className="px-1.5 py-0.5 bg-red-100 text-red-700 rounded text-[10px] font-medium flex-shrink-0"
                              title={a.last_sync_error || 'invalid_grant'}
                            >
                              Reconnect needed
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {broken && (
                            <button
                              onClick={handleGmailConnect}
                              disabled={gmailLoading}
                              className="px-3 py-1.5 text-xs font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50"
                            >Reconnect</button>
                          )}
                          <button
                            onClick={() => handleDisconnectAccount(a.id)}
                            disabled={gmailLoading}
                            className="px-3 py-1.5 text-xs font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50"
                          >Disconnect</button>
                        </div>
                      </div>
                    );
                  })}
                  <button
                    onClick={handleGmailConnect}
                    disabled={gmailLoading}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 border-2 border-dashed border-gray-200 rounded-xl text-gray-500 hover:border-indigo-300 hover:text-indigo-600 hover:bg-indigo-50/20 transition-all text-sm font-medium disabled:opacity-50"
                  >
                    <span className="text-base leading-none">+</span>
                    {gmailLoading ? 'Connecting\u2026' : 'Add Account'}
                  </button>
                </div>
              </div>

              {/* Outlook Accounts */}
              <div className="space-y-3 pt-4 border-t border-gray-100">
                <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Outlook Accounts</h3>
                <div className="space-y-2">
                  {outlookAccounts.length === 0 && (
                    <div className="text-xs text-gray-400 italic px-3 py-2">No accounts connected yet.</div>
                  )}
                  {outlookAccounts.map((a) => {
                    const broken = a.auth_status === 'needs_reauth';
                    return (
                      <div key={a.id} className="flex items-center justify-between p-3 rounded-lg border border-gray-100 bg-gray-50/50">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${broken ? 'bg-red-500' : 'bg-green-500'}`} />
                          <span className={`text-sm truncate ${broken ? 'text-red-700' : 'text-gray-700'}`}>
                            {a.account_email || '(unknown email — reconnect to refresh)'}
                          </span>
                          {broken && (
                            <span
                              className="px-1.5 py-0.5 bg-red-100 text-red-700 rounded text-[10px] font-medium flex-shrink-0"
                              title={a.last_sync_error || 'invalid_grant'}
                            >
                              Reconnect needed
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {broken && (
                            <button
                              onClick={handleOutlookConnect}
                              disabled={outlookLoading}
                              className="px-3 py-1.5 text-xs font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50"
                            >Reconnect</button>
                          )}
                          <button
                            onClick={() => handleOutlookDisconnect(a.id)}
                            disabled={outlookLoading}
                            className="px-3 py-1.5 text-xs font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50"
                          >Disconnect</button>
                        </div>
                      </div>
                    );
                  })}
                  <button
                    onClick={handleOutlookConnect}
                    disabled={outlookLoading}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 border-2 border-dashed border-gray-200 rounded-xl text-gray-500 hover:border-indigo-300 hover:text-indigo-600 hover:bg-indigo-50/20 transition-all text-sm font-medium disabled:opacity-50"
                  >
                    <span className="text-base leading-none">+</span>
                    {outlookLoading ? 'Connecting\u2026' : 'Add Account'}
                  </button>
                </div>
              </div>

              {/* Scan Settings */}
              <div className="space-y-3 pt-4 border-t border-gray-100">
                <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Scan Settings</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1.5">Scan Frequency</label>
                    <select
                      value={gmailConfig.scanFrequency || '1h'}
                      onChange={(e) => setGmailConfig((c) => ({ ...c, scanFrequency: e.target.value }))}
                      className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition"
                    >
                      <option value="15m">Every 15 min</option>
                      <option value="30m">Every 30 min</option>
                      <option value="1h">Every hour</option>
                      <option value="4h">Every 4 hours</option>
                      <option value="manual">Manual only</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1.5">Scan Window</label>
                    <select
                      value={gmailConfig.scanWindow || '24h'}
                      onChange={(e) => setGmailConfig((c) => ({ ...c, scanWindow: e.target.value }))}
                      className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition"
                    >
                      <option value="6h">Last 6 hours</option>
                      <option value="24h">Last 24 hours</option>
                      <option value="48h">Last 48 hours</option>
                    </select>
                  </div>
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
                  {(gmailConfig.vipSenders ?? []).map((s, i) => (
                    <span key={i} className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200">
                      {s}
                      <button
                        onClick={() => setGmailConfig((c) => ({ ...c, vipSenders: (c.vipSenders ?? []).filter((_, j) => j !== i) }))}
                        className="text-indigo-400 hover:text-indigo-600 ml-0.5"
                      >&times;</button>
                    </span>
                  ))}
                  {(gmailConfig.vipSenders ?? []).length === 0 && <span className="text-xs text-gray-300 italic">None added yet</span>}
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
                  {(gmailConfig.triggerKeywords ?? []).map((k, i) => (
                    <span key={i} className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                      {k}
                      <button
                        onClick={() => setGmailConfig((c) => ({ ...c, triggerKeywords: (c.triggerKeywords ?? []).filter((_, j) => j !== i) }))}
                        className="text-amber-400 hover:text-amber-600 ml-0.5"
                      >&times;</button>
                    </span>
                  ))}
                  {(gmailConfig.triggerKeywords ?? []).length === 0 && <span className="text-xs text-gray-300 italic">None added yet</span>}
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
                  disabled={gmailAccounts.length === 0 || scanning}
                  className="w-full py-2 text-sm font-medium text-indigo-600 border border-indigo-200 rounded-lg hover:bg-indigo-50 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {scanning ? (
                    <>
                      <span className="w-4 h-4 border-2 border-indigo-300 border-t-indigo-600 rounded-full animate-spin" />
                      Scanning...
                    </>
                  ) : 'Scan Now'}
                </button>
                {gmailAccounts.length === 0 && (
                  <p className="text-xs text-gray-400 text-center">Connect a Gmail account above to enable scanning</p>
                )}
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
