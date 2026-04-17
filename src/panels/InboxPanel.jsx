import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { useToast } from '../contexts/ToastContext';

// Minimal HTML detection — good enough to pick a render mode.
function isHtmlBody(body) {
  if (!body || typeof body !== 'string') return false;
  return /<\/?[a-z][\s\S]*?>/i.test(body);
}

// Clean plain-text email bodies before rendering.
// Removes separator lines (=== / --- / ___), collapses 3+ blank lines to
// one, and trims excessive leading/trailing blank lines. Applies only to
// the plain-text render path; HTML bodies are left alone.
function cleanPlainText(body) {
  if (!body || typeof body !== 'string') return body || '';
  const lines = body.split(/\r?\n/);
  const kept = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const stripped = line.trim();
    if (/^={3,}$/.test(stripped)) continue;
    if (/^-{3,}$/.test(stripped)) continue;
    if (/^_{3,}$/.test(stripped)) continue;
    kept.push(line);
  }
  // Collapse 3+ consecutive blank lines into a single blank line.
  const collapsed = [];
  let blankRun = 0;
  for (const l of kept) {
    if (l.trim() === '') {
      blankRun++;
      if (blankRun <= 1) collapsed.push('');
    } else {
      blankRun = 0;
      collapsed.push(l);
    }
  }
  // Trim leading / trailing blank lines.
  while (collapsed.length && collapsed[0].trim() === '') collapsed.shift();
  while (collapsed.length && collapsed[collapsed.length - 1].trim() === '') collapsed.pop();
  return collapsed.join('\n');
}

// Strip dangerous tags + their contents before we hand HTML to the DOM.
// Keeps formatting/layout tags. Also strips inline event handlers and
// script-bearing URL schemes as a cheap second layer.
//
// This is regex sanitization — known to be bypassable by sufficiently
// motivated payloads (HTML entity tricks, mixed encoding). DOMPurify is
// the right long-term answer; tracking as a follow-up.
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
  // Strip <form> + <input> tags only (not content) — neutralizes
  // phishing forms without dropping legitimate text inside emails.
  out = out.replace(/<\/?form\b[^>]*>/gi, '');
  out = out.replace(/<input\b[^>]*\/?>/gi, '');
  // Strip on* event handlers (onclick, onload, …).
  out = out.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '');
  // Neutralize script-bearing URL schemes in href/src.
  out = out.replace(/(href|src)\s*=\s*(["'])\s*(?:javascript|data|vbscript):[^"']*\2/gi, '$1=$2#$2');
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
// Markdown renderer components for the compact inbox-header chat.
// Inline styles so typography/spacing stays in the bubble and doesn't
// leak global styles.
const INBOX_MD_COMPONENTS = {
  p:  ({ node, ...p }) => <p style={{ margin: '0 0 0.35em 0' }} {...p} />,
  ul: ({ node, ordered, ...p }) => <ul style={{ margin: '0.15em 0 0.35em 1.1em', padding: 0, listStyleType: 'disc' }} {...p} />,
  ol: ({ node, ordered, ...p }) => <ol style={{ margin: '0.15em 0 0.35em 1.25em', padding: 0, listStyleType: 'decimal' }} {...p} />,
  li: ({ node, ordered, ...p }) => <li style={{ margin: '0.1em 0' }} {...p} />,
  strong: ({ node, ...p }) => <strong style={{ fontWeight: 700 }} {...p} />,
  em: ({ node, ...p }) => <em style={{ fontStyle: 'italic' }} {...p} />,
  a: ({ node, ...p }) => <a style={{ color: '#4f4dcf', textDecoration: 'underline' }} target="_blank" rel="noreferrer" {...p} />,
  code: ({ node, inline, ...p }) =>
    inline
      ? <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', background: 'rgba(79,77,207,0.06)', padding: '0 3px', borderRadius: '3px' }} {...p} />
      : <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', whiteSpace: 'pre-wrap' }} {...p} />,
};

// Decode common HTML entities so Gmail subjects/snippets with things
// like &amp; or &#39; don't render as literal text in the list rows.
// Applied to row display only — full message bodies are left untouched.
function decodeHtmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
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

// ── Classification display helpers ────────────────────────────────────────
const CATEGORY_LABELS = {
  invoice: 'Invoice', receipt: 'Receipt', purchase: 'Purchase',
  contract: 'Contract', alert: 'Alert', newsletter: 'Newsletter',
  personal: 'Personal', meeting: 'Meeting', financial: 'Financial',
  general: 'General',
};
const IMPORTANCE_STYLES = {
  critical: { dot: '#dc2626', bg: 'rgba(220,38,38,0.08)', fg: '#b91c1c' },
  high:     { dot: '#d97706', bg: 'rgba(217,119,6,0.08)', fg: '#b45309' },
  normal:   { dot: '#4f4dcf', bg: 'rgba(79,77,207,0.08)', fg: '#4f4dcf' },
  low:      { dot: '#9ca3af', bg: 'rgba(156,163,175,0.10)', fg: '#6b7280' },
};
const SUPPRESS_PILL = new Set(['general', 'newsletter']);

export default function InboxPanel({ authToken, apiFetch, onNavigate, onUnreadCountChange }) {
  const toast = useToast();
  const [classifications, setClassifications] = useState({});
  // Zone placement state — all grow-only Sets so we never demote a
  // thread the user has already seen in a zone. Interaction also
  // freezes a thread's position for the current session.
  const [interactedIds, setInteractedIds] = useState(() => new Set());
  const [needsAttentionIds, setNeedsAttentionIds] = useState(() => new Set());
  const [lowPriorityIds, setLowPriorityIds] = useState(() => new Set());
  const [pillFilter, setPillFilter] = useState('all'); // 'all' | 'unread' | 'action'
  const [expandedZones, setExpandedZones] = useState({ attn: true, review: true, low: false, read: false });
  const [touchedZones, setTouchedZones] = useState(() => new Set());
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  // Header "Ask about your inbox..." chat — wired to /api/chat/execute
  // with context_hint:'inbox' so the server attaches full email context.
  const [inboxQuery, setInboxQuery] = useState('');
  const [inboxChatMessages, setInboxChatMessages] = useState([]);
  const [inboxChatLoading, setInboxChatLoading] = useState(false);
  const inboxChatScrollRef = useRef(null);
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

  // Reset the header chat whenever the inbox reloads or the account
  // filter changes — the email context the user is asking about has
  // effectively changed, so a stale thread would be misleading.
  useEffect(() => { setInboxChatMessages([]); }, [accountFilter]);

  // Autoscroll the header chat as new messages stream in.
  useEffect(() => {
    const el = inboxChatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [inboxChatMessages]);

  async function submitInboxQuery() {
    const text = inboxQuery.trim();
    if (!text || inboxChatLoading) return;
    // Thread mode: prefix the user's message with the thread context so
    // Aria knows what they're asking about. The user sees the original
    // question in the bubble; the API gets the enriched form.
    const inThreadMode = !!activeThreadId && !!thread;
    let apiContent = text;
    if (inThreadMode) {
      const latest = thread.messages?.[thread.messages.length - 1];
      const senderLabel = latest ? (senderName(latest.from) || senderEmail(latest.from) || 'the sender') : 'the sender';
      const subjectLabel = thread?.messages?.[0]?.subject || latest?.subject || '(no subject)';
      apiContent = `Regarding the email from ${senderLabel} re: ${subjectLabel}:\n${text}`;
    }
    setInboxQuery('');
    // UI shows the user's raw text; API payload carries the enriched form.
    const uiMsgs  = [...inboxChatMessages, { role: 'user', content: text }];
    const apiBase = [...inboxChatMessages, { role: 'user', content: apiContent }];
    setInboxChatMessages([...uiMsgs, { role: 'assistant', content: '' }]);
    setInboxChatLoading(true);
    try {
      const res = await apiFetch('/api/chat/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          messages: apiBase,
          context_hint: 'inbox',
          // NO systemPrompt — let server build full Aria prompt + inbox context.
        }),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = null;
      let fullText = '';
      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const raw of lines) {
          const em = raw.match(/^event: (.+)/);
          const dm = raw.match(/^data: (.+)/);
          if (em) currentEvent = em[1].trim();
          if (dm && currentEvent === 'text') {
            try { fullText = JSON.parse(dm[1])?.content || fullText; } catch {}
            setInboxChatMessages((prev) => {
              const u = [...prev];
              u[u.length - 1] = { ...u[u.length - 1], content: fullText };
              return u;
            });
          }
          if (dm && currentEvent === 'done') break outer;
          if (dm && currentEvent === 'error') {
            try {
              const p = JSON.parse(dm[1]);
              setInboxChatMessages((prev) => {
                const u = [...prev];
                u[u.length - 1] = { role: 'assistant', content: `Couldn't reach Aria — ${p?.message || 'error'}.` };
                return u;
              });
            } catch {}
            break outer;
          }
          if (dm) currentEvent = null;
        }
      }
      // If we exited with no text, drop the empty placeholder.
      if (!fullText) {
        setInboxChatMessages((prev) => {
          const u = [...prev];
          const last = u[u.length - 1];
          if (last && last.role === 'assistant' && !last.content) u.pop();
          return u;
        });
      }
    } catch (err) {
      setInboxChatMessages((prev) => {
        const u = [...prev];
        u[u.length - 1] = { role: 'assistant', content: `Couldn't reach Aria — ${err.message}.` };
        return u;
      });
    } finally {
      setInboxChatLoading(false);
      // Thread-mode: return to chat view so the user reads Aria's reply.
      if (inThreadMode) {
        setActiveThreadId(null);
        setActiveAccount(null);
        setThread(null);
        setMobileShowThread(false);
      }
    }
  }

  // Batch-lookup classifications once the thread list lands, then poll a
  // couple of times to catch classifications produced by the server's
  // fire-and-forget trigger after the threads response.
  useEffect(() => {
    if (!threads.length) { setClassifications({}); return; }
    const messageIds = threads
      .map(t => t.latestMessageId)
      .filter(Boolean)
      .slice(0, 50);
    if (!messageIds.length) { setClassifications({}); return; }
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const r = await apiFetch('/api/classification/batch-lookup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ message_ids: messageIds }),
        });
        if (!r.ok) return;
        const data = await r.json();
        if (!cancelled) setClassifications(data?.classifications || {});
      } catch {}
    };
    fetchOnce();
    const t1 = setTimeout(fetchOnce, 2500);
    const t2 = setTimeout(fetchOnce, 6000);
    return () => { cancelled = true; clearTimeout(t1); clearTimeout(t2); };
  }, [threads, apiFetch, authToken]);

  // Zone placement: grow-only Sets. A thread moves into Needs Attention
  // or Low Priority at most once; user-interacted threads are frozen.
  useEffect(() => {
    if (!threads.length || !Object.keys(classifications).length) return;
    const candAttn = new Set();
    const candLow = new Set();
    for (const t of threads) {
      if (t.isRead) continue;
      if (interactedIds.has(t.id)) continue;
      const mid = t.latestMessageId || t.id;
      const cls = classifications[mid];
      if (!cls) continue;
      if (cls.importanceRank >= 3 || cls.actionRequired) candAttn.add(t.id);
      else if (cls.importanceRank === 1 || cls.category === 'newsletter' || cls.category === 'general') candLow.add(t.id);
    }
    setNeedsAttentionIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of candAttn) if (!next.has(id)) { next.add(id); changed = true; }
      return changed ? next : prev;
    });
    setLowPriorityIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of candLow) {
        if (candAttn.has(id)) continue;           // promotion beats demotion
        if (!next.has(id)) { next.add(id); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [classifications, threads, interactedIds]);

  // Auto-collapse For Your Review when Needs Attention has items, unless
  // the user has manually toggled the Review zone already.
  useEffect(() => {
    if (touchedZones.has('review')) return;
    setExpandedZones((prev) => {
      const shouldExpand = needsAttentionIds.size === 0;
      return prev.review === shouldExpand ? prev : { ...prev, review: shouldExpand };
    });
  }, [needsAttentionIds.size, touchedZones]);

  const unreadCount = useMemo(() => threads.filter(t => !t.isRead).length, [threads]);
  useEffect(() => { onUnreadCountChange?.(unreadCount); }, [unreadCount, onUnreadCountChange]);

  function markInteracted(threadId) {
    setInteractedIds((prev) => prev.has(threadId) ? prev : new Set([...prev, threadId]));
  }

  function removeThreadFromZones(threadId) {
    setNeedsAttentionIds((prev) => { if (!prev.has(threadId)) return prev; const n = new Set(prev); n.delete(threadId); return n; });
    setLowPriorityIds((prev)  => { if (!prev.has(threadId)) return prev; const n = new Set(prev); n.delete(threadId); return n; });
  }

  function openThread(t) {
    setActiveThreadId(t.id);
    setActiveAccount(t.accountEmail);
    setMobileShowThread(true);
    markInteracted(t.id);
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
      removeThreadFromZones(thread.id);
      setThreads((prev) => prev.filter(x => x.id !== thread.id));
      setThread(null);
      setActiveThreadId(null);
      setMobileShowThread(false);
    } catch {}
  }

  async function archiveSingle(t) {
    const messageId = t.latestMessageId || t.id;
    if (!messageId) return;
    markInteracted(t.id);
    try {
      await apiFetch('/api/inbox/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ account_email: t.accountEmail, message_id: messageId }),
      });
      removeThreadFromZones(t.id);
      setThreads((prev) => prev.filter(x => x.id !== t.id));
      if (activeThreadId === t.id) {
        setActiveThreadId(null); setActiveAccount(null); setThread(null); setMobileShowThread(false);
      }
    } catch {}
  }

  async function markThreadRead(t) {
    const messageId = t.latestMessageId || t.id;
    if (!messageId) return;
    markInteracted(t.id);
    removeThreadFromZones(t.id);
    setThreads((prev) => prev.map(x => x.id === t.id ? { ...x, isRead: true } : x));
    try {
      await apiFetch('/api/inbox/mark-read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ account_email: t.accountEmail, message_id: messageId }),
      });
    } catch {}
  }

  // Auto-clean runner: dry-run scan first, show confirmation, then execute.
  const DEFAULT_CLEAN_POLICY = {
    archivePromos: true,      promosOlderThanH: 24,
    archiveNewsletters: true, newslettersOlderThanH: 24,
    archiveSocial: true,      socialOlderThanH: 24,
    confirmationThreshold: 20,
    active: true,
  };
  const [cleanScan, setCleanScan] = useState(null);        // { would_archive, breakdown, threshold }
  const [cleanArchiving, setCleanArchiving] = useState(false);

  async function startBulkClean() {
    setBulkConfirmOpen(false);
    setCleanScan(null);
    let policy = DEFAULT_CLEAN_POLICY;
    try {
      const pr = await apiFetch('/api/email-clean-policy', { headers: { Authorization: `Bearer ${authToken}` } });
      const pdata = await pr.json().catch(() => null);
      if (pdata?.policy) policy = pdata.policy;
    } catch {}
    const effective = {
      ...policy,
      // Inbox button always wants all three types on by default.
      archivePromos: true, archiveNewsletters: true, archiveSocial: true,
    };
    try {
      const r = await apiFetch('/api/email-clean-policy/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ confirmed: false, policy: effective }),
      });
      const data = await r.json();
      if (!data || data.would_archive === 0) {
        try { toast.info('Nothing to clean right now.', 3000); } catch {}
        return;
      }
      setCleanScan({ ...data, threshold: effective.confirmationThreshold || 20 });
    } catch {
      try { toast.error('Scan failed', 4000); } catch {}
    }
  }

  async function confirmBulkClean() {
    setCleanArchiving(true);
    try {
      const r = await apiFetch('/api/email-clean-policy/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ confirmed: true, policy: {
          ...DEFAULT_CLEAN_POLICY,
          archivePromos: true, archiveNewsletters: true, archiveSocial: true,
        } }),
      });
      const data = await r.json();
      const n = data?.archived ?? 0;
      // Optimistically drop Low Priority threads from the local zone.
      setThreads((prev) => prev.filter(t => !lowPriorityIds.has(t.id)));
      setLowPriorityIds(new Set());
      try { toast.info(`Archived ${n} low priority emails.`, 3000); } catch {}
    } catch {}
    finally {
      setCleanArchiving(false);
      setCleanScan(null);
    }
  }

  function toggleZone(key) {
    setTouchedZones((prev) => prev.has(key) ? prev : new Set([...prev, key]));
    setExpandedZones((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  // Derived zones (apply account + pill filter, then bucket).
  const zones = useMemo(() => {
    const base = threads.filter(t => !accountFilter || t.accountEmail === accountFilter);
    const filtered = base.filter(t => {
      if (pillFilter === 'unread') return !t.isRead;
      if (pillFilter === 'action') {
        const mid = t.latestMessageId || t.id;
        const cls = classifications[mid];
        return !!cls?.actionRequired;
      }
      return true;
    });
    const attn = [], review = [], low = [], read = [];
    for (const t of filtered) {
      if (t.isRead) { read.push(t); continue; }
      if (needsAttentionIds.has(t.id)) { attn.push(t); continue; }
      if (lowPriorityIds.has(t.id)) { low.push(t); continue; }
      review.push(t);
    }
    return { attn, review, low, read };
  }, [threads, classifications, accountFilter, pillFilter, needsAttentionIds, lowPriorityIds]);

  const needsAttentionThreads = useMemo(() => threads.filter(t => {
    if (t.isRead) return false;
    const mid = t.latestMessageId || t.id;
    const cls = classifications[mid];
    if (!cls) return false;
    return cls.importanceRank >= 3 || cls.actionRequired;
  }), [threads, classifications]);

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

  // "Draft with Aria" now opens a slide-in conversational panel instead
  // of calling the API directly. The panel pushes the final draft back
  // into the compose body above the quoted-original separator.
  const [ariaOpen, setAriaOpen] = useState(false);
  function openAriaDraft() { if (compose) setAriaOpen(true); }
  function handleAriaInsert(draftText) {
    const cleaned = (draftText || '').trim();
    if (!cleaned) { setAriaOpen(false); return; }
    setCompose((c) => {
      if (!c) return c;
      const sep = '\n\n---\n';
      const idx = (c.body || '').indexOf(sep);
      const trailing = idx >= 0 ? (c.body || '').slice(idx) : '';
      return { ...c, body: trailing ? `${cleaned}${trailing}` : cleaned };
    });
    setAriaOpen(false);
  }

  return (
    <div className="flex-1 overflow-hidden flex" style={{ backgroundColor: '#fbf8fe', fontFamily: 'Manrope, sans-serif' }}>
      <style>{`
        .email-html-body img { max-width: 100%; height: auto; }
        .email-html-body a { color: #4f4dcf; text-decoration: underline; }
        .email-html-body table { max-width: 100%; }
        .email-html-body pre { white-space: pre-wrap; }
      `}</style>
      {/* Left — zoned thread list */}
      <div
        className={`border-r border-gray-100 flex-col h-full ${mobileShowThread ? 'hidden md:flex' : 'flex'}`}
        style={{ width: 320, minWidth: 320, flexShrink: 0, backgroundColor: '#fbf8fe', position: 'relative' }}
      >
        <div className="px-4 md:px-5 pt-3 md:pt-5 pb-2 md:pb-3">
          <h1 className="text-lg md:text-xl font-extrabold text-gray-900" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>Inbox</h1>
          <div className="mt-2 md:mt-3">
            <select
              value={accountFilter}
              onChange={(e) => setAccountFilter(e.target.value)}
              className="w-full px-2 md:px-3 py-1.5 md:py-2 bg-white border border-gray-200 rounded-lg md:rounded-xl text-xs md:text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="">All accounts</option>
              {accounts.map(a => <option key={a.id} value={a.account_email}>{a.account_email}</option>)}
            </select>
          </div>
          <div className="mt-2 flex items-center gap-1">
            {[
              { key: 'all',    label: 'All' },
              { key: 'unread', label: 'Unread' },
              { key: 'action', label: 'Action Required' },
            ].map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setPillFilter(key)}
                className={`px-2.5 py-1 text-[11px] font-semibold rounded-full transition-colors`}
                style={pillFilter === key
                  ? { backgroundColor: '#4f4dcf', color: '#fff' }
                  : { backgroundColor: 'transparent', color: '#6b7280', border: '1px solid #e5e7eb' }}
              >
                {label}
              </button>
            ))}
          </div>

        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-3">
          {threadsLoading ? (
            <ZonedSkeleton />
          ) : threadsError ? (
            <div className="bg-white border border-gray-100 rounded-xl shadow-sm p-4 mx-1 text-center">
              <p className="text-sm text-gray-600">Couldn&rsquo;t load inbox. Try again.</p>
              <button onClick={loadThreads} className="mt-2 text-xs font-semibold" style={{ color: '#4f4dcf' }}>Retry</button>
            </div>
          ) : (
            <>
              {/* Aria summary card */}
              <AriaSummaryCard items={needsAttentionThreads.slice(0, 3)} total={needsAttentionThreads.length} />

              {/* Inbox Zero — zones 1+2+3 empty */}
              {zones.attn.length === 0 && zones.review.length === 0 && zones.low.length === 0 ? (
                <div className="bg-white border border-gray-100 rounded-xl shadow-sm p-6 mx-1 my-3 text-center">
                  <span className="material-symbols-outlined" style={{ color: '#22c55e', fontSize: '36px' }}>task_alt</span>
                  <p className="text-sm font-semibold text-gray-800 mt-1" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>Inbox zero. Aria&rsquo;s got your back.</p>
                  <p className="text-xs text-gray-500 mt-1">New emails will be prioritized automatically.</p>
                </div>
              ) : null}

              {/* Zone 1 — Needs Your Attention */}
              <Zone
                icon="priority_high" iconColor="#ef4444"
                label="Needs Your Attention"
                badgeClass="bg-red-50 text-red-700 border-red-200"
                count={zones.attn.length}
                expanded={expandedZones.attn}
                onToggle={() => toggleZone('attn')}
                emptyText="Nothing urgent right now."
                showCountSuffix
              >
                {zones.attn.map(t => renderThreadRow({ t, activeThreadId, classifications, openThread, archiveSingle, markThreadRead }))}
              </Zone>

              {/* Zone 2 — For Your Review */}
              <Zone
                icon="mail" iconColor="#4f4dcf"
                label="For Your Review"
                badgeClass="bg-indigo-50 text-indigo-700 border-indigo-200"
                count={zones.review.length}
                expanded={expandedZones.review}
                onToggle={() => toggleZone('review')}
                emptyText="No emails to review."
                showCountSuffix
              >
                {zones.review.map(t => renderThreadRow({ t, activeThreadId, classifications, openThread, archiveSingle, markThreadRead }))}
              </Zone>

              {/* Zone 3 — Low Priority */}
              <Zone
                icon="low_priority" iconColor="#6b7280"
                label="Low Priority"
                badgeClass="bg-gray-50 text-gray-600 border-gray-200"
                count={zones.low.length}
                expanded={expandedZones.low}
                onToggle={() => toggleZone('low')}
                emptyText="No low priority emails."
                showCountSuffix
                footer={
                  zones.low.length > 0 && (
                    <div className="mt-1 px-1">
                      <button
                        onClick={startBulkClean}
                        className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg"
                        style={{ backgroundColor: 'transparent', color: '#4f4dcf', border: '1px solid rgba(79,77,207,0.25)' }}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>archive</span>
                        Archive All Low Priority
                      </button>
                    </div>
                  )
                }
              >
                {zones.low.map(t => renderThreadRow({ t, activeThreadId, classifications, openThread, archiveSingle, markThreadRead }))}
              </Zone>

              {/* Zone 4 — Read */}
              <Zone
                icon="drafts" iconColor="#9ca3af"
                label="Read"
                count={zones.read.length}
                hideBadge
                expanded={expandedZones.read}
                onToggle={() => toggleZone('read')}
                emptyText="No read threads."
              >
                {zones.read.map(t => renderThreadRow({ t, activeThreadId, classifications, openThread, archiveSingle, markThreadRead }))}
              </Zone>
            </>
          )}
        </div>

        {/* Bulk auto-clean confirmation — dry-run result shown here */}
        {cleanScan && (
          <div
            className="absolute inset-0 z-40 flex items-center justify-center"
            style={{ background: 'rgba(0,0,0,0.15)' }}
            onClick={() => !cleanArchiving && setCleanScan(null)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="bg-white border border-gray-200 rounded-xl shadow-lg p-4 w-[300px]"
              style={{ fontFamily: 'Manrope, sans-serif' }}
            >
              <div className="flex items-center gap-2">
                {cleanScan.would_archive >= (cleanScan.threshold || 20) ? (
                  <>
                    <span className="material-symbols-outlined" style={{ color: '#d97706', fontSize: '18px' }}>warning</span>
                    <p className="text-sm font-semibold text-gray-900" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                      About to archive {cleanScan.would_archive} emails — this is a lot.
                    </p>
                  </>
                ) : (
                  <>
                    <span className="material-symbols-outlined" style={{ color: '#22c55e', fontSize: '18px' }}>check_circle</span>
                    <p className="text-sm font-semibold text-gray-900" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                      Ready to archive {cleanScan.would_archive} emails:
                    </p>
                  </>
                )}
              </div>
              <ul className="mt-1.5 ml-6 space-y-0.5 text-[12px] text-gray-600">
                <li>• {cleanScan.breakdown?.promos || 0} promotions</li>
                <li>• {cleanScan.breakdown?.newsletters || 0} newsletters</li>
                <li>• {cleanScan.breakdown?.social || 0} social notifications</li>
              </ul>
              <div className="flex items-center justify-end gap-2 mt-3">
                <button onClick={() => !cleanArchiving && setCleanScan(null)} className="px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50 rounded-lg">Cancel</button>
                <button
                  onClick={confirmBulkClean}
                  disabled={cleanArchiving}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg disabled:opacity-50"
                  style={{ backgroundColor: '#4f4dcf', color: '#fff' }}
                >
                  {cleanArchiving ? 'Archiving…' : 'Archive Now'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Right — Aria chat by default; thread view when a thread is open */}
      <div className={`flex-1 flex-col h-full ${mobileShowThread ? 'flex' : 'hidden md:flex'}`} style={{ backgroundColor: '#fbf8fe', position: 'relative' }}>
        {!activeThreadId ? (
          <>
            <div ref={inboxChatScrollRef} className="flex-1 overflow-y-auto px-6 pt-4 pb-4">
              {inboxChatMessages.length === 0 && !inboxChatLoading ? (
                <div className="h-full flex items-center justify-center">
                  <div className="text-center">
                    <span className="material-symbols-outlined" style={{ color: '#4f4dcf', fontSize: '44px' }}>auto_awesome</span>
                    <p className="text-base font-semibold text-gray-900 mt-2" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>Ask me anything about your inbox</p>
                    <p className="text-xs text-gray-500 mt-1 max-w-[300px] mx-auto">Find emails, summarize threads, check what needs attention</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  {inboxChatMessages.map((m, i) => {
                    const isUser = m.role === 'user';
                    return (
                      <div key={i} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                        <div
                          className={`max-w-[85%] ${isUser ? 'text-white' : ''}`}
                          style={isUser
                            ? { backgroundColor: '#4f4dcf', fontSize: '14px', lineHeight: '1.55', borderRadius: '12px', padding: '9px 12px', fontFamily: 'Manrope, sans-serif', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
                            : { backgroundColor: '#fff', border: '1px solid #e5e7eb', fontSize: '14px', lineHeight: '1.55', borderRadius: '12px', padding: '9px 12px', color: '#1f2937', fontFamily: 'Manrope, sans-serif', wordBreak: 'break-word' }
                          }
                        >
                          {m.content
                            ? (isUser ? m.content : <ReactMarkdown components={INBOX_MD_COMPONENTS}>{m.content}</ReactMarkdown>)
                            : <span className="text-gray-400">Aria is thinking…</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <AriaInputBar
              value={inboxQuery}
              onChange={setInboxQuery}
              onSubmit={submitInboxQuery}
              disabled={inboxChatLoading}
            />
          </>
        ) : (
          <>
            <div className="flex items-start justify-between gap-3 px-6 pt-5 pb-3 border-b border-gray-100">
              <div className="flex items-start gap-2 min-w-0 flex-1">
                <button onClick={() => setMobileShowThread(false)} className="md:hidden text-gray-400 flex-shrink-0 mt-0.5" title="Back">
                  <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>arrow_back</span>
                </button>
                <h2 className="text-lg font-bold text-gray-900 whitespace-normal break-words min-w-0" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
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
                                  {cleanPlainText(m.body)}
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

            {/* Pinned Aria bar — always visible when viewing a thread */}
            <AriaInputBar
              value={inboxQuery}
              onChange={setInboxQuery}
              onSubmit={submitInboxQuery}
              disabled={inboxChatLoading}
            />

            {compose && (
              <ComposeDrawer
                compose={compose}
                accounts={accounts}
                drafting={false}
                onChange={(patch) => setCompose((c) => ({ ...c, ...patch }))}
                onCancel={() => setCompose(null)}
                onSend={sendCompose}
                onDraftWithAria={openAriaDraft}
              />
            )}

            {ariaOpen && compose && (
              <InboxAriaPanel
                apiFetch={apiFetch}
                authToken={authToken}
                context={{
                  from: compose.from,
                  to: compose.to,
                  subject: compose.subject,
                  originalFrom: thread?.messages?.[thread.messages.length - 1]?.from || '',
                  originalSubject: thread?.messages?.[0]?.subject || compose.subject,
                  originalBody: (thread?.messages?.[thread.messages.length - 1]?.body || '').slice(0, 500),
                }}
                onInsert={handleAriaInsert}
                onClose={() => setAriaOpen(false)}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// Persistent Aria input bar. Shown at the bottom of the right panel in
// both chat mode (no thread selected) and thread mode. ~56px tall.
function AriaInputBar({ value, onChange, onSubmit, disabled }) {
  const canSend = !!value?.trim() && !disabled;
  return (
    <div className="border-t border-gray-100 px-3 py-2" style={{ backgroundColor: '#fbf8fe' }}>
      <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-full pl-3 pr-1 py-1">
        <span className="material-symbols-outlined" style={{ color: '#4f4dcf', fontSize: '18px' }}>auto_awesome</span>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (canSend) onSubmit(); } }}
          placeholder="Ask about your inbox..."
          className="flex-1 bg-transparent text-sm focus:outline-none placeholder:text-gray-400 py-1.5"
          style={{ fontFamily: 'Manrope, sans-serif' }}
          disabled={disabled}
        />
        <button
          onClick={() => canSend && onSubmit()}
          disabled={!canSend}
          className="w-8 h-8 rounded-full flex items-center justify-center disabled:opacity-30 flex-shrink-0"
          style={{ backgroundColor: canSend ? '#4f4dcf' : 'transparent' }}
          aria-label="Send"
        >
          <span className={`material-symbols-outlined ${canSend ? 'text-white' : 'text-slate-400'}`} style={{ fontSize: '16px' }}>
            {disabled ? 'hourglass_empty' : 'arrow_forward'}
          </span>
        </button>
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

// ── Zoned-layout helpers ──────────────────────────────────────────────────

function AriaSummaryCard({ items, total }) {
  const empty = total === 0;
  return (
    <div
      className="rounded-xl p-3 mx-1 mb-2 border"
      style={{ backgroundColor: 'rgba(79,77,207,0.05)', borderColor: 'rgba(79,77,207,0.2)' }}
    >
      <div className="flex items-start gap-2">
        <span className="material-symbols-outlined" style={{ color: '#4f4dcf', fontSize: '18px' }}>auto_awesome</span>
        <div className="flex-1 min-w-0">
          {empty ? (
            <p className="text-[13px] text-gray-700" style={{ fontFamily: 'Manrope, sans-serif' }}>
              You&rsquo;re all caught up. Nothing urgent right now.
            </p>
          ) : (
            <>
              <p className="text-[13px] font-semibold text-gray-900" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                {total} email{total === 1 ? '' : 's'} need{total === 1 ? 's' : ''} your attention
              </p>
              <ul className="mt-1.5 space-y-0.5">
                {items.map((t) => {
                  const line = `${senderName(t.from) || shortAccount(t.accountEmail)}: ${decodeHtmlEntities(t.subject) || '(no subject)'}`;
                  return (
                    <li key={t.id} className="text-[12px] text-gray-500 truncate">
                      <span style={{ color: '#ef4444' }}>● </span>
                      {line.length > 50 ? line.slice(0, 50) + '…' : line}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Zone({ icon, iconColor, label, count, badgeClass, expanded, onToggle, children, emptyText, hideBadge, showCountSuffix, footer }) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : !!children;
  return (
    <div className="mb-2 px-1">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white transition-colors"
      >
        <span className="material-symbols-outlined" style={{ color: iconColor, fontSize: '16px' }}>{icon}</span>
        <span
          className="text-[10px] font-bold uppercase tracking-[0.14em] text-gray-500 flex-1 text-left"
          style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}
        >
          {label}{hideBadge && showCountSuffix ? ` (${count})` : ''}
        </span>
        {!hideBadge && (
          <span className={`inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${badgeClass || 'bg-gray-50 text-gray-600 border-gray-200'}`}>
            {count}
          </span>
        )}
        <span
          className="material-symbols-outlined text-gray-400"
          style={{ fontSize: '16px', transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 150ms ease' }}
        >
          expand_more
        </span>
      </button>
      {expanded && (
        hasChildren ? (
          <div className="mt-0.5">{children}</div>
        ) : (
          <p className="text-[12px] text-gray-400 italic px-3 py-2">{emptyText}</p>
        )
      )}
      {expanded && footer}
    </div>
  );
}

function ZonedSkeleton() {
  const row = (k) => (
    <div key={k} className="px-3 py-2.5 mb-1">
      <div className="flex items-start gap-2">
        <div className="w-2 h-2 rounded-full bg-gray-100 animate-pulse mt-1.5" />
        <div className="flex-1 space-y-1.5">
          <div className="h-3 w-32 bg-gray-100 rounded animate-pulse" />
          <div className="h-3 w-48 bg-gray-100 rounded animate-pulse" />
        </div>
      </div>
    </div>
  );
  return (
    <div>
      <div className="mb-2 px-1">
        <div className="h-6 w-44 bg-gray-100 rounded animate-pulse mx-2 mb-1" />
        {[0,1,2].map(row)}
      </div>
      <div className="mb-2 px-1">
        <div className="h-6 w-44 bg-gray-100 rounded animate-pulse mx-2 mb-1" />
        {[0,1].map(row)}
      </div>
    </div>
  );
}

function renderThreadRow({ t, activeThreadId, classifications, openThread, archiveSingle, markThreadRead }) {
  const tint = tintForAccount(t.accountEmail);
  const active = t.id === activeThreadId;
  const mid = t.latestMessageId || t.id;
  const cls = classifications[mid];
  const impStyle = cls ? IMPORTANCE_STYLES[cls.importance] : null;

  // Dot: critical=red, high=amber, unclassified unread=blue, read=none.
  let dotBg = 'transparent';
  let dotBorder = 'none';
  if (!t.isRead) {
    if (impStyle && cls.importance === 'critical') dotBg = '#ef4444';
    else if (impStyle && cls.importance === 'high') dotBg = '#f59e0b';
    else dotBg = '#4f4dcf';
  }

  const showPill = cls && cls.importanceRank >= 3 && !SUPPRESS_PILL.has(cls.category);

  return (
    <div
      key={`${t.accountEmail}:${t.id}`}
      className={`group relative rounded-xl mb-1 transition-colors ${active ? 'bg-primary/5' : 'hover:bg-white'}`}
      style={active ? { borderLeft: '3px solid #4f4dcf' } : { borderLeft: '3px solid transparent' }}
    >
      <button
        onClick={() => openThread(t)}
        className="w-full text-left px-3 py-1.5 md:py-2.5"
      >
        <div className="flex items-start gap-2">
          <span
            className="flex-shrink-0 mt-1.5 w-2 h-2 rounded-full"
            style={{ backgroundColor: dotBg, border: dotBorder }}
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span className={`text-sm truncate ${t.isRead ? 'text-gray-600' : 'text-gray-900 font-semibold'}`} style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                {senderName(t.from) || shortAccount(t.accountEmail)}
              </span>
              <span className="text-[10px] text-gray-400 flex-shrink-0">{relTime(t.date)}</span>
            </div>
            <div className={`text-[13px] truncate mt-0.5 ${t.isRead ? 'text-gray-500' : 'text-gray-800 font-semibold'}`}>
              {decodeHtmlEntities(t.subject) || '(no subject)'}
            </div>
            <div className="text-xs text-gray-400 truncate mt-0.5">{decodeHtmlEntities(t.snippet)}</div>
            <div className="mt-1.5 flex items-center gap-1.5">
              <span className="inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style={{ backgroundColor: tint.bg, color: tint.fg }}>
                {shortAccount(t.accountEmail)}{t.messageCount > 1 ? ` · ${t.messageCount}` : ''}
              </span>
              {showPill && (
                <span
                  className="inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded-full truncate"
                  style={{ backgroundColor: impStyle.bg, color: impStyle.fg, maxWidth: 120 }}
                >
                  {CATEGORY_LABELS[cls.category] || cls.category}
                </span>
              )}
            </div>
          </div>
        </div>
      </button>
      {/* Hover actions — desktop only */}
      <div className="hidden md:flex absolute top-1 right-1 gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={(e) => { e.stopPropagation(); archiveSingle(t); }}
          title="Archive"
          className="w-7 h-7 rounded-lg flex items-center justify-center bg-white border border-gray-200 hover:bg-gray-50"
        >
          <span className="material-symbols-outlined text-gray-500" style={{ fontSize: '15px' }}>archive</span>
        </button>
        {!t.isRead && (
          <button
            onClick={(e) => { e.stopPropagation(); markThreadRead(t); }}
            title="Mark read"
            className="w-7 h-7 rounded-lg flex items-center justify-center bg-white border border-gray-200 hover:bg-gray-50"
          >
            <span className="material-symbols-outlined text-gray-500" style={{ fontSize: '15px' }}>mark_email_read</span>
          </button>
        )}
      </div>
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

// ── Aria slide-in panel — drafts an email reply through a short chat ──
function InboxAriaPanel({ apiFetch, authToken, context, onInsert, onClose }) {
  const [visible, setVisible] = useState(false);       // drives slide-in transform
  const [messages, setMessages] = useState([]);        // [{role, content}]
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState(null);
  const listRef = useRef(null);

  const sender = useMemo(() => senderName(context.originalFrom) || 'the sender', [context.originalFrom]);

  const systemPrompt = useMemo(() => (
`You are helping the user draft an email reply.
Thread context:
From: ${context.originalFrom || '(unknown)'}
Subject: ${context.originalSubject || '(no subject)'}
Original message: ${context.originalBody || '(empty)'}

The user is composing a reply from ${context.from || '(their account)'}.
Have a brief conversation to understand their intent, then draft the reply.
When you have enough info, write the final draft and end your message with:
[DRAFT_READY]
---DRAFT---
[the email body text only, no subject]
---END---`
  ), [context]);

  // Mount animation + initial greeting (local only, not sent to API).
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 10);
    setMessages([{
      role: 'assistant',
      content: `I can help you draft this reply. What would you like to say to ${sender}?`,
    }]);
    return () => clearTimeout(t);
  }, [sender]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, draft]);

  function handleClose() {
    setVisible(false);
    setTimeout(() => onClose?.(), 300);
  }

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    const nextMsgs = [...messages, { role: 'user', content: text }, { role: 'assistant', content: '' }];
    setMessages(nextMsgs);
    setSending(true);
    try {
      // Strip the local seed greeting — it was never sent to the API.
      const apiMessages = nextMsgs.slice(0, -1).filter((m, i) => !(i === 0 && m.role === 'assistant'));
      const res = await apiFetch('/api/chat/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          systemPrompt,
          messages: apiMessages,
          context_hint: 'inbox',
        }),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = null;
      let fullText = '';
      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const raw of lines) {
          const em = raw.match(/^event: (.+)/);
          const dm = raw.match(/^data: (.+)/);
          if (em) currentEvent = em[1].trim();
          if (dm && currentEvent === 'text') {
            try { fullText = JSON.parse(dm[1])?.content || fullText; } catch {}
            const display = stripDraftMarkers(fullText);
            setMessages((prev) => {
              const u = [...prev];
              u[u.length - 1] = { ...u[u.length - 1], content: display };
              return u;
            });
          }
          if (dm && currentEvent === 'done') break outer;
          if (dm) currentEvent = null;
        }
      }

      const extracted = extractDraft(fullText);
      if (extracted) setDraft(extracted);
    } catch (err) {
      setMessages((prev) => {
        const u = [...prev];
        u[u.length - 1] = { role: 'assistant', content: `Couldn't draft right now — ${err.message}` };
        return u;
      });
    } finally {
      setSending(false);
    }
  }

  const slideStyle = {
    transform: visible ? 'translateX(0)' : 'translateX(100%)',
    transition: 'transform 300ms ease',
  };

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={handleClose}
        style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.15)', zIndex: 40, opacity: visible ? 1 : 0, transition: 'opacity 300ms ease' }}
      />
      {/* Panel */}
      <aside
        style={{
          position: 'absolute', top: 0, right: 0, bottom: 0, width: 380,
          maxWidth: '100%', backgroundColor: '#fbf8fe', borderLeft: '1px solid #e5e7eb',
          boxShadow: '-8px 0 24px rgba(15,15,40,0.08)', zIndex: 50,
          display: 'flex', flexDirection: 'column',
          fontFamily: 'Manrope, sans-serif',
          ...slideStyle,
        }}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-4 pt-4 pb-3 border-b border-gray-100">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="material-symbols-outlined" style={{ color: '#4f4dcf', fontSize: '18px' }}>auto_awesome</span>
              <h3 className="text-sm font-extrabold text-gray-900" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>Draft with Aria</h3>
            </div>
            <p className="text-[11px] text-gray-500 mt-0.5">Chat with Aria to craft your reply</p>
          </div>
          <button onClick={handleClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
            <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>close</span>
          </button>
        </div>

        {/* Messages */}
        <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
          {messages.map((m, i) => {
            const isUser = m.role === 'user';
            return (
              <div key={i} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[88%] ${isUser ? 'text-white' : ''}`}
                  style={isUser
                    ? { backgroundColor: '#4f4dcf', fontSize: '14px', lineHeight: '1.55', borderRadius: '12px', padding: '10px 12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
                    : { backgroundColor: '#f5f2fa', fontSize: '14px', lineHeight: '1.55', borderRadius: '12px', padding: '10px 12px', color: '#1f2937', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
                  }
                >
                  {m.content || <span className="animate-pulse text-gray-500">Thinking…</span>}
                </div>
              </div>
            );
          })}

          {draft && (
            <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-3">
              <div className="flex items-center gap-1.5 mb-2">
                <span className="material-symbols-outlined" style={{ color: '#4f4dcf', fontSize: '16px' }}>edit_note</span>
                <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-gray-500" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                  Draft ready
                </span>
              </div>
              <div style={{ borderTop: '1px solid #e5e7eb', margin: '4px 0 8px 0' }} />
              <div
                style={{ fontSize: '13px', lineHeight: '1.55', color: '#1f2937', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '220px', overflowY: 'auto', marginBottom: '10px' }}
              >
                {draft}
              </div>
              <button
                onClick={() => onInsert?.(draft)}
                className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold"
                style={{ backgroundColor: '#4f4dcf', color: '#fff' }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>check</span>
                Insert into reply
              </button>
            </div>
          )}
        </div>

        {/* Input */}
        <div className="px-3 py-2 border-t border-gray-100 flex items-center gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Tell Aria what you want to say…"
            className="flex-1 px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            disabled={sending}
            style={{ fontFamily: 'Manrope, sans-serif' }}
          />
          <button
            onClick={send}
            disabled={!input.trim() || sending}
            className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center disabled:opacity-40"
            style={{ backgroundColor: input.trim() ? '#4f4dcf' : 'transparent' }}
            aria-label="Send"
          >
            <span className={`material-symbols-outlined text-base ${input.trim() ? 'text-white' : 'text-slate-400'}`}>
              {sending ? 'hourglass_empty' : 'send'}
            </span>
          </button>
        </div>
      </aside>
    </>
  );
}

function extractDraft(text) {
  if (!text || !text.includes('[DRAFT_READY]')) return null;
  const m = text.match(/---DRAFT---\s*([\s\S]*?)\s*---END---/);
  return m ? m[1].trim() : null;
}
function stripDraftMarkers(text) {
  if (!text) return text;
  return text
    .replace(/\[DRAFT_READY\]/g, '')
    .replace(/---DRAFT---[\s\S]*?---END---/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
