import { useState } from 'react';
import { getRuleScope, conditionDescription, uid } from '../../utils/helpers.js';
import { CONDITION_META, EMPTY_NEW_RULE, buildPlainTextAlert } from './alertUtils.js';
import { XIcon, BellIcon } from '../icons/Icons.jsx';

function RuleRow({ rule, defaultRecipient, onToggle, onDelete, onRecipientChange, onChannelChange, onConditionChange, onIntervalChange }) {
  const [expanded, setExpanded] = useState(false);
  const scope = getRuleScope(rule.condition.type);
  const scopeLabel = { 'per-task': 'per task', daily: 'daily', session: 'once/session' }[scope];
  const channels = rule.channels || { whatsapp: true, slack: true, sms: false, email: true };
  const condType = rule.condition.type;

  return (
    <div
      className={`rounded-xl border transition-all ${
        rule.enabled ? 'border-outline-variant bg-surface-container-lowest' : 'border-outline-variant bg-surface-container-low/50'
      }`}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Toggle */}
        <button
          onClick={onToggle}
          className={`relative flex-shrink-0 w-9 h-5 rounded-full transition-colors ${
            rule.enabled ? 'bg-primary' : 'bg-surface-container-high'
          }`}
          title={rule.enabled ? 'Disable' : 'Enable'}
        >
          <span
            className={`absolute top-0.5 w-4 h-4 bg-surface-container-lowest rounded-full shadow transition-transform ${
              rule.enabled ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`text-sm font-medium ${rule.enabled ? 'text-on-surface' : 'text-text-faint'}`}>
              {rule.name}
            </span>
            <span className="text-[10px] bg-surface-container text-on-surface-variant px-1.5 py-0.5 rounded font-medium">
              {scopeLabel}
            </span>
            {rule.isCustom && (
              <span className="text-[10px] bg-accent-surface text-primary px-1.5 py-0.5 rounded font-medium">
                custom
              </span>
            )}
            {rule.condition?.type === 'critical-mail' && (
              <span className="text-[10px] bg-accent-surface text-primary px-1.5 py-0.5 rounded font-medium">
                flagged inbox
              </span>
            )}
          </div>
          <p className="text-xs text-text-faint mt-0.5 truncate">{rule.description}</p>
        </div>

        {/* Expand / delete */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-text-faint hover:text-on-surface-variant transition-colors p-1"
            title="Configure channels & options"
          >
            <svg
              className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {onDelete && (
            <button
              onClick={onDelete}
              className="text-text-faint hover:text-danger transition-colors p-1"
              title="Delete rule"
            >
              <XIcon className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Expanded panel */}
      {expanded && (
        <div className="px-4 pb-3 border-t border-outline-variant space-y-3">
          {/* Section A — Channel toggles */}
          <div className="mt-2.5">
            <label className="block text-xs font-medium text-on-surface-variant mb-1.5">Channels</label>
            <div className="flex flex-wrap gap-1.5">
              {[
                { key: 'whatsapp', label: 'WhatsApp', color: 'bg-success' },
                { key: 'slack',    label: 'Slack',    color: 'bg-primary' },
                { key: 'sms',      label: 'SMS',      color: 'bg-primary' },
                { key: 'email',    label: 'Email',    color: 'bg-warning' },
              ].map(({ key, label, color }) => {
                const on = channels[key];
                const disabled = key === 'sms';
                return (
                  <button
                    key={key}
                    disabled={disabled}
                    title={disabled ? 'Coming soon' : `Toggle ${label}`}
                    onClick={() => onChannelChange && onChannelChange(key, !on)}
                    className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${
                      disabled
                        ? 'bg-surface-container text-text-faint cursor-not-allowed'
                        : on
                          ? `${color} text-on-primary`
                          : 'bg-surface-container text-text-faint hover:bg-surface-container-high'
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Re-notify interval */}
          {['overdue','due-in-hours','high-priority','tag-overdue','tag-match'].includes(rule.condition.type) && (
            <div className="mt-3">
              <label className="text-xs font-medium text-on-surface-variant">Remind again after</label>
              <div className="flex gap-2 mt-1.5 flex-wrap">
                {[1, 4, 12, 24, 48].map((h) => (
                  <button
                    key={h}
                    onClick={() => onIntervalChange && onIntervalChange(h)}
                    className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                      rule.remindIntervalHours === h
                        ? 'bg-primary text-on-primary'
                        : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
                    }`}
                  >
                    {h < 24 ? `${h}h` : `${h / 24}d`}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Email recipient override */}
          {channels.email && (
            <div>
              <label className="block text-xs font-medium text-on-surface-variant mb-1.5">
                Recipient override{' '}
                <span className="font-normal text-text-faint">
                  (blank = default: {defaultRecipient || 'not set'})
                </span>
              </label>
              <input
                type="email"
                value={rule.recipientOverride}
                onChange={(e) => onRecipientChange(e.target.value)}
                placeholder={defaultRecipient || 'override@example.com'}
                className="w-full px-3 py-2 bg-surface-container-low border border-outline-variant rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
          )}

          {/* Section B — Condition config */}
          {condType === 'morning-brief' && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-on-surface-variant w-16 flex-shrink-0">Time:</label>
              <input
                type="time"
                value={rule.condition.time || '08:00'}
                onChange={(e) => onConditionChange && onConditionChange({ ...rule.condition, time: e.target.value })}
                className="flex-1 px-3 py-2 bg-surface-container-low border border-outline-variant rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
          )}
          {condType === 'event-reminder' && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-on-surface-variant w-16 flex-shrink-0">Before:</label>
              <select
                value={rule.condition.minutesBefore || 15}
                onChange={(e) => onConditionChange && onConditionChange({ ...rule.condition, minutesBefore: Number(e.target.value) })}
                className="flex-1 px-3 py-2 bg-surface-container-low border border-outline-variant rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              >
                {[5, 10, 15, 30, 60].map((m) => (
                  <option key={m} value={m}>{m} min</option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function AlertsModal({ rules, onUpdateRules, emailSettings, tasks, addToast, onClose, entities, envStatus, apiFetch, authToken, currentUser, EntitySelectOptions }) {
  const [showAdd, setShowAdd]       = useState(false);
  const [newRule, setNewRule]       = useState(EMPTY_NEW_RULE);
  const [sending, setSending]       = useState(false);
  const [testPicker, setTestPicker] = useState(null);

  const emailConfigured =
    emailSettings.resendConfigured && emailSettings.recipientEmail;
  const env = envStatus || { slack: false, whatsapp: false, sms: false, email: false };

  function toggleRule(id) {
    onUpdateRules((prev) => prev.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)));
  }

  function deleteRule(id) {
    onUpdateRules((prev) => prev.filter((r) => r.id !== id));
  }

  function updateRecipient(id, value) {
    onUpdateRules((prev) =>
      prev.map((r) => (r.id === id ? { ...r, recipientOverride: value } : r)),
    );
  }

  function updateChannel(id, channel, value) {
    onUpdateRules((prev) =>
      prev.map((r) =>
        r.id === id
          ? { ...r, channels: { ...(r.channels || {}), [channel]: value } }
          : r
      )
    );
  }

  function updateInterval(id, hours) {
    onUpdateRules((prev) =>
      prev.map((r) => r.id === id ? { ...r, remindIntervalHours: hours } : r)
    );
  }

  function updateCondition(id, condition) {
    onUpdateRules((prev) =>
      prev.map((r) =>
        r.id === id ? { ...r, condition, description: conditionDescription(condition) } : r
      )
    );
  }

  function handleAddRule() {
    if (!newRule.name.trim()) return;
    onUpdateRules((prev) => [
      ...prev,
      {
        id: uid(),
        name: newRule.name.trim(),
        description: conditionDescription(newRule.condition),
        enabled: true,
        condition: { ...newRule.condition },
        channels: { ...newRule.channels },
        recipientOverride: newRule.recipientOverride.trim(),
        isCustom: true,
      },
    ]);
    setNewRule(EMPTY_NEW_RULE);
    setShowAdd(false);
  }

  async function handleSendTest(channel) {
    setSending(true);
    try {
      const sampleTasks = tasks.filter((t) => !t.completed).slice(0, 3);
      const message = buildPlainTextAlert('Test Alert', sampleTasks.length ? sampleTasks : tasks.slice(0, 2));
      const channels = { whatsapp: channel === 'whatsapp', slack: channel === 'slack', sms: false, email: channel === 'email' };
      const res = await apiFetch('/api/alerts/fire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ message, channels, recipientEmail: emailSettings.recipientEmail }),
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
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-lg mx-4 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 flex-shrink-0 border-b border-outline-variant">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-accent-surface rounded-lg flex items-center justify-center">
              <BellIcon className="w-4 h-4 text-primary" />
            </div>
            <h2 className="text-lg font-bold text-on-surface">Alert Rules</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="text-text-faint hover:text-on-surface-variant hover:bg-surface-container rounded-lg p-1 transition-colors"
            >
              <XIcon className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Channel status */}
        <div className="px-6 py-2.5 text-xs flex items-center gap-2 flex-shrink-0 bg-surface-container-low border-b border-outline-variant text-on-surface-variant flex-wrap">
          {[
            { key: 'whatsapp', label: 'WhatsApp' },
            { key: 'slack',    label: 'Slack' },
            { key: 'sms',      label: 'SMS' },
            { key: 'email',    label: 'Email' },
          ].map(({ key, label }) => (
            <span key={key} className="flex items-center gap-1">
              <span className={`inline-block w-2 h-2 rounded-full ${env[key] ? 'bg-success' : 'bg-surface-container-highest'}`} />
              {label}
            </span>
          ))}
          <span className="text-text-faint ml-auto">Rules fire every 60s</span>
        </div>

        {/* Scrollable rules list */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-2">
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

          {/* Add custom rule inline form */}
          {showAdd ? (
            <div className="border border-primary rounded-xl p-4 bg-accent-surface/30 mt-2">
              <h4 className="text-xs font-semibold text-on-surface-variant uppercase tracking-wide mb-3">
                New Custom Rule
              </h4>
              <div className="space-y-2.5">
                <input
                  type="text"
                  placeholder="Rule name *"
                  value={newRule.name}
                  onChange={(e) => setNewRule((r) => ({ ...r, name: e.target.value }))}
                  className="w-full px-3 py-2 bg-surface-container-lowest border border-outline-variant rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />

                <select
                  value={newRule.condition.type}
                  onChange={(e) =>
                    setNewRule((r) => ({
                      ...r,
                      condition: { ...r.condition, type: e.target.value },
                    }))
                  }
                  className="w-full px-3 py-2 bg-surface-container-lowest border border-outline-variant rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  {Object.entries(CONDITION_META).map(([type, meta]) => (
                    <option key={type} value={type}>{meta.label}</option>
                  ))}
                </select>

                {selectedMeta.hasHours && (
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-on-surface-variant w-16 flex-shrink-0">Hours:</label>
                    <select
                      value={newRule.condition.hours || 24}
                      onChange={(e) =>
                        setNewRule((r) => ({
                          ...r,
                          condition: { ...r.condition, hours: Number(e.target.value) },
                        }))
                      }
                      className="flex-1 px-3 py-2 bg-surface-container-lowest border border-outline-variant rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    >
                      {[2, 4, 8, 24, 48, 72].map((h) => (
                        <option key={h} value={h}>{h} h</option>
                      ))}
                    </select>
                  </div>
                )}

                {selectedMeta.hasTag && (
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-on-surface-variant w-16 flex-shrink-0">Tag:</label>
                    <select
                      value={newRule.condition.tag || (entities[0]?.name || '')}
                      onChange={(e) =>
                        setNewRule((r) => ({
                          ...r,
                          condition: { ...r.condition, tag: e.target.value },
                        }))
                      }
                      className="flex-1 px-3 py-2 bg-surface-container-lowest border border-outline-variant rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    >
                      {EntitySelectOptions && <EntitySelectOptions entities={entities || []} />}
                    </select>
                  </div>
                )}

                <input
                  type="email"
                  placeholder="Recipient override (optional)"
                  value={newRule.recipientOverride}
                  onChange={(e) => setNewRule((r) => ({ ...r, recipientOverride: e.target.value }))}
                  className="w-full px-3 py-2 bg-surface-container-lowest border border-outline-variant rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />

                <div className="flex gap-2">
                  <button
                    onClick={() => { setShowAdd(false); setNewRule(EMPTY_NEW_RULE); }}
                    className="flex-1 px-3 py-2 border border-outline-variant rounded-lg text-on-surface-variant hover:bg-surface-container-low text-sm font-medium transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleAddRule}
                    disabled={!newRule.name.trim()}
                    className="flex-1 px-3 py-2 bg-primary text-on-primary rounded-lg hover:bg-primary text-sm font-medium transition-colors disabled:opacity-40"
                  >
                    Add Rule
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowAdd(true)}
              className="w-full flex items-center gap-2 px-4 py-3 border-2 border-dashed border-outline-variant rounded-xl text-text-faint hover:border-primary hover:text-primary hover:bg-accent-surface/20 transition-all text-sm font-medium mt-1"
            >
              <span className="text-base leading-none">+</span> Add custom rule
            </button>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-outline-variant flex-shrink-0 space-y-2">
          {testPicker ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-on-surface-variant">Send test via:</span>
              {[
                { key: 'whatsapp', label: 'WhatsApp', ok: env.whatsapp },
                { key: 'slack',    label: 'Slack',    ok: env.slack },
                { key: 'email',    label: 'Email',    ok: env.email },
              ].map(({ key, label, ok }) => (
                <button
                  key={key}
                  disabled={!ok || sending}
                  onClick={() => handleSendTest(key)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    ok
                      ? 'bg-accent-surface text-primary hover:bg-accent-surface'
                      : 'bg-surface-container-low text-text-faint cursor-not-allowed'
                  }`}
                >
                  {label}
                </button>
              ))}
              <button
                disabled={sending}
                className="px-2 py-1.5 rounded-lg text-xs font-medium bg-surface-container-low text-text-faint cursor-not-allowed"
                title="Coming soon"
              >
                SMS
              </button>
              <button
                onClick={() => setTestPicker(null)}
                className="ml-auto text-xs text-text-faint hover:text-on-surface-variant"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={() => setTestPicker(true)}
                disabled={sending}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 border border-outline-variant rounded-xl text-on-surface hover:bg-surface-container-low text-sm font-medium transition-colors disabled:opacity-50"
              >
                {sending ? 'Sending…' : 'Send Test →'}
              </button>
              <button
                onClick={onClose}
                className="flex-1 px-4 py-2.5 bg-primary text-on-primary rounded-xl hover:bg-primary text-sm font-medium transition-colors shadow-sm"
              >
                Done
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
