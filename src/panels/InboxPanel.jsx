import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '../contexts/ToastContext';

// Minimal HTML detection — good enough to pick a render mode.
function isHtmlBody(body) {
  if (!body || typeof body !== 'string') return false;
  return /<\/?[a-z][\s\S]*?>/i.test(body);
}

// Strip dangerous tags + their contents before we hand HTML to the DOM.
// Keeps formatting/layout tags. Also strips inline event handlers and
// javascript: URLs as a cheap second layer.
function sanitizeHtml(raw) {
  if (!raw) return '';
  let out = String(raw);
  out = out.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  out = out.replace(/<style\b[\s\S]*?<\/style>/gi, '');
  out = out.replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '');
  out = out.replace(/<object\b[\s\S]*?<\/object>/gi, '');
  out = out.replace(/<embed\b[\s\S]*?\/?>/gi, '');
  out = out.replace(/<link\b[^>]*>/gi, '');
  out = out.replace(/<meta\b[^>]*>/gi, '');
  // Strip on* event handlers (onclick, onload, …).
  out = out.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '');
  // Neutralize javascript: in href/src.
  out = out.replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');
  return out;
}

// Deterministic color per account_email so each account gets a stable
// badge tint across loads. Kept muted so it never competes with #4f4dcf.
const ACCOUNT_TINTS = [
  { bg: 'rgba(79,77,207,0.08)',  fg: '#4f4dcf' },
  { bg: 'rgba(5,150,105,0.08)',  fg: '#059669' },
  { bg: 'rgba(217,119,6,0.08)',  fg: '#b45309' },
  { bg: 'rgba(219,39,119,0.08)', fg: '#be185d' },
  { bg: 'rgba(14,165,233,0.08)', fg: '#0369a1' },
  { bg: 'rgba(100,116,139,0.10)', fg: '#475569' },
];
function tintForAccount(email) {
  if (!email) return ACCOUNT_TINTS[0];
  let h = 0; for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) | 0;
  return ACCOUNT_TINTS[Math.abs(h) % ACCOUNT_TINTS.length];
}
function shortAccount(email) {
  if (!email) return '';
  const at = email.indexOf('@');
  return at > 0 ? email.slice(0, at) : email;
}
function senderName(raw) {
  if (!raw) return '';
  const m = raw.match(/^\s*"?([^"<]+?)"?\s*<.+>/);
  return m ? m[1].trim() : raw.replace(/<[^>]+>/g, '').trim();
}
function senderEmail(raw) {
  if (!raw) return '';
  const m = raw.match(/<([^>]+)>/);
  return m ? m[1].trim() : raw.trim();
}
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
}
function relTime(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function absTime(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function InboxPanel({ authToken, apiFetch, onNavigate, onUnreadCountChange }) {
  const toast = useToast();
  const [accounts, setAccounts] = useState([]);
  const [accountFilter, setAccountFilter] = useState('');  // '' = all
  const [threads, setThreads] = useState([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [threadsError, setThreadsError] = useState(null);
  const [activeThreadId, setActiveThreadId] = useState(null);
  const [activeAccount, setActiveAccount] = useState(null);
  const [thread, setThread] = useState(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState(null);
  const [expanded, setExpanded] = useState(new Set());
  const [compose, setCompose] = useState(null);
  const [mobileShowThread, setMobileShowThread] = useState(false);

  const loadAccounts = useCallback(async () => {
    try {
      const r = await apiFetch('/api/inbox/accounts', { headers: { Authorization: `Bearer ${authToken}` } });
      const data = await r.json();
      setAccounts(Array.isArray(data) ? data : []);
    } catch {
      setAccounts([]);
    }
  }, [apiFetch, authToken]);

  const loadThreads = useCallback(async () => {
    setThreadsLoading(true);
    setThreadsError(null);
    try {
      const qs = new URLSearchParams();
      if (accountFilter) qs.set('account_email', accountFilter);
      qs.set('max_results', '20');
      const r = await apiFetch(`/api/inbox/threads?${qs.toString()}`, { headers: { Authorization: `Bearer ${authToken}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const list = Array.isArray(data?.threads) ? data.threads : [];
      setThreads(list);
      onUnreadCountChange?.(list.filter(t => !t.isRead).length);
    } catch (err) {
      setThreadsError(err.message || 'Failed');
      setThreads([]);
    } finally {
      setThreadsLoading(false);
    }
  }, [accountFilter, apiFetch, authToken, onUnreadCountChange]);

  const loadThread = useCallback(async (threadId, accountEmail) => {
    setThreadLoading(true);
    setThreadError(null);
    setThread(null);
    try {
      const r = await apiFetch(`/api/inbox/threads/${encodeURIComponent(threadId)}?account_email=${encodeURIComponent(accountEmail)}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const t = data?.thread || null;
      setThread(t);
      if (t?.messages?.length) {
        setExpanded(new Set([t.messages[t.messages.length - 1].id]));
      } else {
        setExpanded(new Set());
      }
      setThreads((prev) => prev.map(x => x.id === threadId ? { ...x, isRead: true } : x));
    } catch (err) {
      setThreadError(err.message || 'Failed');
    } finally {
      setThreadLoading(false);
    }
  }, [apiFetch, authToken]);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);
  useEffect(() => { loadThreads(); }, [loadThreads]);

  const unreadCount = useMemo(() => threads.filter(t => !t.isRead).length, [threads]);
  useEffect(() => { onUnreadCountChange?.(unreadCount); }, [unreadCount, onUnreadCountChange]);

  function openThread(t) {
    setActiveThreadId(t.id);
    setActiveAccount(t.accountEmail);
    setMobileShowThread(true);
    loadThread(t.id, t.accountEmail);
  }

  async function archiveCurrent() {
    if (!thread || !thread.messages?.length) return;
    const lastMsg = thread.messages[thread.messages.length - 1];
    try {
      await apiFetch('/api/inbox/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ account_email: activeAccount, message_id: lastMsg.id }),
      });
      setThreads((prev) => prev.filter(x => x.id !== thread.id));
      setThread(null);
      setActiveThreadId(null);
      setMobileShowThread(false);
    } catch {}
  }

  function openCompose(mode) {
    const latest = thread?.messages?.[thread.messages.length - 1];
    if (!latest && mode !== 'new') return;
    const origSubject = latest?.subject || '';
    const origFrom = senderEmail(latest?.from || '');
    const quoted = latest?.body
      ? `\n\n---\nOn ${absTime(latest.date)}, ${senderName(latest.from)} wrote:\n> ${latest.body.split('\n').join('\n> ')}`
      : '';
    if (mode === 'reply') {
      setCompose({ mode, from: activeAccount || '', to: origFrom,
        subject: origSubject.toLowerCase().startsWith('re:') ? origSubject : `Re: ${origSubject}`,
        body: quoted });
    } else if (mode === 'replyAll') {
      const toList = new Set([origFrom]);
      if (latest?.to) latest.to.split(',').map(s => senderEmail(s.trim())).filter(Boolean).forEach(e => toList.add(e));
      toList.delete(activeAccount);
      setCompose({ mode, from: activeAccount || '', to: Array.from(toList).filter(Boolean).join(', '),
        subject: origSubject.toLowerCase().startsWith('re:') ? origSubject : `Re: ${origSubject}`,
        body: quoted });
    } else if (mode === 'forward') {
      setCompose({ mode, from: activeAccount || '', to: '',
        subject: origSubject.toLowerCase().startsWith('fwd:') ? origSubject : `Fwd: ${origSubject}`,
        body: quoted });
    } else {
      setCompose({ mode: 'new', from: '', to: '', subject: '', body: '' });
    }
  }

  function sendCompose() {
    if (!compose) return;
    const { from, to, subject, body } = compose;
    if (!from || !to || !subject) return;
    const msg = `Send email from ${from} to ${to}\nsubject: ${subject}\nbody: ${body || ''}`;
    try { window.dispatchEvent(new CustomEvent('aria-autosend', { detail: { message: msg } })); } catch {}
    setCompose(null);
    // Stay in Inbox — the approval card lives in Aria's chat; user
    // will see it next time they open the Dashboard.
    try { toast.info('Email queued for sending — approve in Aria', 3000); } catch {}
  }

  // Inline drafter used from the compose drawer. Replaces the body text
  // above the quoted original with the model's output; leaves the
  // quoted section untouched so the reply keeps its "On … wrote:" tail.
  const [drafting, setDrafting] = useState(false);
  async function draftReplyInPlace() {
    if (!compose || drafting) return;
    const latest = thread?.messages?.[thread.messages.length - 1];
    const preview = (latest?.body || '').slice(0, 300).replace(/\s+/g, ' ').trim();
    const subject = compose.subject || latest?.subject || '(no subject)';
    const msg = `Draft a reply email from ${compose.from || '(me)'} to ${compose.to || senderEmail(latest?.from || '') || '(recipient)'} re: ${subject}. Context: ${preview}. Return ONLY the email body text, no subject line, no explanation.`;

    setDrafting(true);
    try {
      const res = await apiFetch('/api/chat/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          messages: [{ role: 'user', content: msg }],
        }),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = null;
      let draft = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const rawLine of lines) {
          const em = rawLine.match(/^event: (.+)/);
          const dm = rawLine.match(/^data: (.+)/);
          if (em) currentEvent = em[1].trim();
          if (dm && currentEvent === 'text') {
            try { draft = JSON.parse(dm[1])?.content || draft; } catch {}
          }
          if (dm && currentEvent === 'done') break;
          if (dm) currentEvent = null;
        }
      }
      const cleaned = (draft || '').trim();
      if (!cleaned) throw new Error('No draft returned');

      // Preserve the quoted original if present — replace only the
      // body above the "\n\n---\n" separator inserted by openCompose.
      setCompose((c) => {
        if (!c) return c;
        const sep = '\n\n---\n';
        const idx = (c.body || '').indexOf(sep);
        const trailing = idx >= 0 ? (c.body || '').slice(idx) : '';
        return { ...c, body: trailing ? `${cleaned}${trailing}` : cleaned };
      });
    } catch (err) {
      try { toast.error(`Couldn't draft: ${err.message || 'failed'}`, 4000); } catch {}
    } finally {
      setDrafting(false);
    }
  }

  return (
    <div className="flex-1 overflow-hidden flex" style={{ backgroundColor: '#fbf8fe', fontFamily: 'Manrope, sans-serif' }}>
      <style>{`
        .email-html-body img { max-width: 100%; height: auto; }
        .email-html-body a { color: #4f4dcf; text-decoration: underline; }
        .email-html-body table { max-width: 100%; }
        .email-html-body pre { white-space: pre-wrap; }
      `}</style>
      {/* Left — thread list */}
      <div
        className={`border-r border-gray-100 flex-col h-full ${mobileShowThread ? 'hidden md:flex' : 'flex'}`}
        style={{ width: 320, minWidth: 320, flexShrink: 0, backgroundColor: '#fbf8fe' }}
      >
        <div className="px-5 pt-5 pb-3">
          <h1 className="text-xl font-extrabold text-gray-900" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>Inbox</h1>
          <div className="mt-3">
            <select
              value={accountFilter}
              onChange={(e) => setAccountFilter(e.target.value)}
              className="w-full px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="">All accounts</option>
              {accounts.map(a => <option key={a.id} value={a.account_email}>{a.account_email}</option>)}
            </select>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-3">
          {threadsLoading ? (
            <ListSkeleton />
          ) : threadsError ? (
            <div className="bg-white border border-gray-100 rounded-xl shadow-sm p-4 mx-1 text-center">
              <p className="text-sm text-gray-600">Couldn&rsquo;t load inbox. Try again.</p>
              <button onClick={loadThreads} className="mt-2 text-xs font-semibold" style={{ color: '#4f4dcf' }}>Retry</button>
            </div>
          ) : threads.length === 0 ? (
            <div className="bg-white border border-gray-100 rounded-xl shadow-sm p-6 mx-1 text-center">
              <span className="material-symbols-outlined text-gray-400" style={{ fontSize: '28px' }}>inbox</span>
              <p className="text-sm text-gray-600 mt-1">Your inbox is empty</p>
            </div>
          ) : (
            threads.map((t) => {
              const tint = tintForAccount(t.accountEmail);
              const active = t.id === activeThreadId;
              return (
                <button
                  key={`${t.accountEmail}:${t.id}`}
                  onClick={() => openThread(t)}
                  className={`w-full text-left rounded-xl px-3 py-2.5 mb-1 transition-colors ${active ? 'bg-primary/5' : 'hover:bg-white'}`}
                  style={active ? { borderLeft: '3px solid #4f4dcf' } : { borderLeft: '3px solid transparent' }}
                >
                  <div className="flex items-start gap-2">
                    <span
                      className="flex-shrink-0 mt-1.5 w-2 h-2 rounded-full"
                      style={{ backgroundColor: t.isRead ? 'transparent' : '#4f4dcf', border: t.isRead ? '1px solid #d1d5db' : 'none' }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className={`text-sm truncate ${t.isRead ? 'text-gray-600' : 'text-gray-900 font-semibold'}`} style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                          {senderName(t.from) || shortAccount(t.accountEmail)}
                        </span>
                        <span className="text-[10px] text-gray-400 flex-shrink-0">{relTime(t.date)}</span>
                      </div>
                      <div className={`text-[13px] truncate mt-0.5 ${t.isRead ? 'text-gray-500' : 'text-gray-800 font-semibold'}`}>
                        {t.subject || '(no subject)'}
                      </div>
                      <div className="text-xs text-gray-400 truncate mt-0.5">{t.snippet}</div>
                      <div className="mt-1.5">
                        <span className="inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style={{ backgroundColor: tint.bg, color: tint.fg }}>
                          {shortAccount(t.accountEmail)}{t.messageCount > 1 ? ` · ${t.messageCount}` : ''}
                        </span>
                      </div>
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Right — thread view */}
      <div className={`flex-1 flex-col h-full ${mobileShowThread ? 'flex' : 'hidden md:flex'}`} style={{ backgroundColor: '#fbf8fe', position: 'relative' }}>
        {!activeThreadId ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <span className="material-symbols-outlined text-gray-300" style={{ fontSize: '48px' }}>mail</span>
              <p className="text-sm text-gray-500 mt-2">Select a thread to read</p>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-3 px-6 pt-5 pb-3 border-b border-gray-100">
              <div className="flex items-center gap-2 min-w-0">
                <button onClick={() => setMobileShowThread(false)} className="md:hidden text-gray-400" title="Back">
                  <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>arrow_back</span>
                </button>
                <h2 className="text-lg font-bold text-gray-900 truncate" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                  {thread?.messages?.[0]?.subject || '(no subject)'}
                </h2>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {activeAccount && (() => { const tint = tintForAccount(activeAccount); return (
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ backgroundColor: tint.bg, color: tint.fg }}>{shortAccount(activeAccount)}</span>
                ); })()}
                <button onClick={archiveCurrent} disabled={!thread} title="Archive"
                  className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-gray-100 disabled:opacity-30">
                  <span className="material-symbols-outlined text-gray-500" style={{ fontSize: '18px' }}>archive</span>
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
              {threadLoading ? (
                <MessageSkeleton />
              ) : threadError ? (
                <div className="bg-white border border-gray-100 rounded-xl shadow-sm p-4 text-center">
                  <p className="text-sm text-gray-600">Couldn&rsquo;t load this thread. Try again.</p>
                  <button onClick={() => loadThread(activeThreadId, activeAccount)} className="mt-2 text-xs font-semibold" style={{ color: '#4f4dcf' }}>Retry</button>
                </div>
              ) : thread?.messages?.length ? (
                thread.messages.map((m) => {
                  const open = expanded.has(m.id);
                  return (
                    <div key={m.id} className="bg-white border border-gray-100 rounded-xl shadow-sm">
                      <button
                        className="w-full flex items-start gap-3 px-4 py-3 text-left"
                        onClick={() => setExpanded((prev) => {
                          const next = new Set(prev);
                          if (next.has(m.id)) next.delete(m.id); else next.add(m.id);
                          return next;
                        })}
                      >
                        <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
                             style={{ backgroundColor: 'rgba(79,77,207,0.08)', color: '#4f4dcf', fontSize: '12px', fontWeight: 700, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                          {initials(senderName(m.from))}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-semibold text-gray-900 truncate" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                              {senderName(m.from) || '(unknown)'}
                            </span>
                            <span className="text-[11px] text-gray-400 flex-shrink-0">{absTime(m.date)}</span>
                          </div>
                          {open && m.to && <div className="text-[11px] text-gray-400 mt-0.5 truncate">to {m.to}</div>}
                          {!open && <div className="text-[12px] text-gray-500 truncate mt-0.5">{m.snippet}</div>}
                        </div>
                      </button>
                      {open && (
                        m.body
                          ? (isHtmlBody(m.body)
                              ? (
                                <div
                                  className="px-4 pb-4 pt-1 email-html-body"
                                  style={{ fontSize: '14px', lineHeight: '1.6', color: '#1f2937', wordBreak: 'break-word', overflowWrap: 'anywhere' }}
                                  dangerouslySetInnerHTML={{ __html: sanitizeHtml(m.body) }}
                                />
                              )
                              : (
                                <div
                                  className="px-4 pb-4 pt-1"
                                  style={{ fontSize: '14px', lineHeight: '1.6', color: '#1f2937', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                                >
                                  {m.body}
                                </div>
                              ))
                          : (
                            <div className="px-4 pb-4 pt-1" style={{ fontSize: '14px', color: '#9ca3af', fontStyle: 'italic' }}>(empty body)</div>
                          )
                      )}
                    </div>
                  );
                })
              ) : null}
            </div>

            {thread && (
              <div className="border-t border-gray-100 px-4 py-2.5 flex items-center gap-2 flex-wrap" style={{ backgroundColor: '#fbf8fe' }}>
                <ActionBtn icon="reply"     label="Reply"     onClick={() => openCompose('reply')} />
                <ActionBtn icon="reply_all" label="Reply All" onClick={() => openCompose('replyAll')} />
                <ActionBtn icon="forward"   label="Forward"   onClick={() => openCompose('forward')} />
              </div>
            )}

            {compose && (
              <ComposeDrawer
                compose={compose}
                accounts={accounts}
                drafting={drafting}
                onChange={(patch) => setCompose((c) => ({ ...c, ...patch }))}
                onCancel={() => setCompose(null)}
                onSend={sendCompose}
                onDraftWithAria={draftReplyInPlace}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ActionBtn({ icon, label, onClick, primary }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
      style={primary
        ? { backgroundColor: '#4f4dcf', color: '#fff' }
        : { backgroundColor: 'transparent', color: '#4f4dcf', border: '1px solid rgba(79,77,207,0.2)' }
      }
    >
      <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>{icon}</span>
      {label}
    </button>
  );
}

function ComposeDrawer({ compose, accounts, drafting, onChange, onCancel, onSend, onDraftWithAria }) {
  const canSend = !!(compose.from && compose.to && compose.subject);
  return (
    <div
      className="absolute inset-x-0 bottom-0 bg-white border-t border-gray-200 shadow-lg"
      style={{ maxHeight: '72%', display: 'flex', flexDirection: 'column', borderTopLeftRadius: 12, borderTopRightRadius: 12 }}
    >
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100">
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-gray-500" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
          {compose.mode === 'forward' ? 'Forward' : compose.mode === 'replyAll' ? 'Reply all' : compose.mode === 'new' ? 'New message' : 'Reply'}
        </span>
        <button onClick={onCancel} className="text-gray-400 hover:text-gray-600" aria-label="Close">
          <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>close</span>
        </button>
      </div>
      <div className="px-4 py-3 space-y-2 overflow-y-auto">
        <Row label="From">
          <select
            value={compose.from}
            onChange={(e) => onChange({ from: e.target.value })}
            className="w-full px-2 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="" disabled>Select account</option>
            {accounts.map(a => <option key={a.id} value={a.account_email}>{a.account_email}</option>)}
          </select>
        </Row>
        <Row label="To">
          <input
            type="text" value={compose.to}
            onChange={(e) => onChange({ to: e.target.value })}
            placeholder="name@example.com"
            className="w-full px-2 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </Row>
        <Row label="Subject">
          <input
            type="text" value={compose.subject}
            onChange={(e) => onChange({ subject: e.target.value })}
            className="w-full px-2 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </Row>
        <textarea
          value={compose.body}
          onChange={(e) => onChange({ body: e.target.value })}
          rows={10}
          placeholder="Write your message…"
          className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          style={{ fontFamily: 'Manrope, sans-serif', lineHeight: 1.55, resize: 'vertical', minHeight: 180 }}
        />
        <div>
          <button
            type="button"
            onClick={onDraftWithAria}
            disabled={drafting}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50"
            style={{ backgroundColor: 'transparent', color: '#4f4dcf', border: '1px solid rgba(79,77,207,0.3)' }}
          >
            {drafting ? (
              <>
                <span className="w-3 h-3 border-2 border-[#4f4dcf]/30 border-t-[#4f4dcf] rounded-full animate-spin" />
                Drafting…
              </>
            ) : (
              <>
                <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>auto_awesome</span>
                Draft with Aria
              </>
            )}
          </button>
        </div>
      </div>
      <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-end gap-2 flex-shrink-0">
        <button onClick={onCancel} className="px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50 rounded-lg">Cancel</button>
        <button
          onClick={onSend}
          disabled={!canSend}
          className="px-3 py-1.5 text-xs font-semibold rounded-lg disabled:opacity-40"
          style={{ backgroundColor: '#4f4dcf', color: '#fff' }}
        >
          Send
        </button>
      </div>
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex items-center gap-2">
      <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider w-16 flex-shrink-0" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{label}</div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="px-1">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="rounded-xl px-3 py-2.5 mb-1">
          <div className="flex items-start gap-2">
            <div className="w-2 h-2 rounded-full bg-gray-100 animate-pulse mt-1.5" />
            <div className="flex-1 space-y-1.5">
              <div className="h-3 w-32 bg-gray-100 rounded animate-pulse" />
              <div className="h-3 w-48 bg-gray-100 rounded animate-pulse" />
              <div className="h-3 w-56 bg-gray-100 rounded animate-pulse" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function MessageSkeleton() {
  return (
    <>
      {Array.from({ length: 2 }).map((_, i) => (
        <div key={i} className="bg-white border border-gray-100 rounded-xl shadow-sm p-4 flex gap-3">
          <div className="w-8 h-8 rounded-full bg-gray-100 animate-pulse flex-shrink-0" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-40 bg-gray-100 rounded animate-pulse" />
            <div className="h-3 w-64 bg-gray-100 rounded animate-pulse" />
            <div className="h-3 w-56 bg-gray-100 rounded animate-pulse" />
          </div>
        </div>
      ))}
    </>
  );
}
