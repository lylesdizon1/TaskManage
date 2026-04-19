import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import DOMPurify from 'dompurify';
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

// HTML email sanitization — handed to dangerouslySetInnerHTML below.
// Backed by DOMPurify (browser DOM-aware parser). Replaces the previous
// hand-rolled regex pass which was bypassable via HTML entity / mixed-
// encoding tricks. Allowlist covers what real emails legitimately use;
// scripts, forms, iframes, and inline event handlers are stripped.
const SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'b', 'i', 'u', 'a', 'ul', 'ol', 'li', 'div', 'span',
    'table', 'tr', 'td', 'th', 'thead', 'tbody', 'h1', 'h2', 'h3',
    'h4', 'h5', 'h6', 'img', 'strong', 'em', 'blockquote', 'pre',
    'code', 'hr', 'small', 'sub', 'sup',
  ],
  ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'style', 'width', 'height', 'colspan', 'rowspan', 'border', 'cellpadding', 'cellspacing'],
  FORBID_TAGS: ['script', 'style', 'form', 'input', 'iframe', 'object', 'embed', 'link', 'meta'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur', 'onchange', 'onsubmit'],
  // Defense-in-depth — DOMPurify already blocks javascript:/vbscript: by
  // default, but we name them explicitly so a future config tweak can't
  // re-open the hole silently.
  ALLOWED_URI_REGEXP: /^(?:https?|mailto|tel|cid):/i,
};

function sanitizeHtml(raw) {
  if (!raw) return '';
  return DOMPurify.sanitize(String(raw), SANITIZE_CONFIG);
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

// Stable avatar palette — 9 hues spanning the design system + complementary
// accents. Hashed deterministically per sender so the same sender always
// renders the same color across refreshes.
const AVATAR_PALETTE = [
  { bg: '#ededff', fg: '#4f4dcf' }, // primary container
  { bg: '#dcfce7', fg: '#166534' }, // emerald
  { bg: '#fef3c7', fg: '#b45309' }, // amber
  { bg: '#fce7f3', fg: '#be185d' }, // pink
  { bg: '#cffafe', fg: '#0e7490' }, // cyan
  { bg: '#ede9fe', fg: '#6d28d9' }, // violet
  { bg: '#ffe4e6', fg: '#be123c' }, // rose
  { bg: '#dbeafe', fg: '#1d4ed8' }, // blue
  { bg: '#f1f5f9', fg: '#475569' }, // slate
];
function avatarColorForSender(seed) {
  if (!seed) return AVATAR_PALETTE[0];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}

// Color tokens per semantic category. Maps 1:1 to the 14 categories
// labelMapper.cjs assigns to Gmail labels / Outlook folders.
const LABEL_CATEGORY_STYLES = {
  finance:       { bg: 'rgba(217,119,6,0.10)',  fg: '#b45309' },
  legal:         { bg: 'rgba(220,38,38,0.10)',  fg: '#b91c1c' },
  clients:       { bg: 'rgba(13,148,136,0.10)', fg: '#0f766e' },
  vendors:       { bg: 'rgba(180,83,9,0.10)',   fg: '#9a3412' },
  personal:      { bg: 'rgba(219,39,119,0.10)', fg: '#be185d' },
  team:          { bg: 'rgba(79,77,207,0.10)',  fg: '#4f4dcf' },
  receipts:      { bg: 'rgba(217,119,6,0.10)',  fg: '#b45309' },
  newsletters:   { bg: 'rgba(107,114,128,0.10)',fg: '#4b5563' },
  notifications: { bg: 'rgba(107,114,128,0.10)',fg: '#4b5563' },
  travel:        { bg: 'rgba(2,132,199,0.10)',  fg: '#0369a1' },
  hr:            { bg: 'rgba(124,58,237,0.10)', fg: '#6d28d9' },
  projects:      { bg: 'rgba(147,51,234,0.10)', fg: '#7e22ce' },
  archive:       { bg: 'rgba(71,85,105,0.10)',  fg: '#475569' },
  other:         { bg: 'rgba(156,163,175,0.10)',fg: '#6b7280' },
};
function labelStyleFor(category) {
  return LABEL_CATEGORY_STYLES[category] || LABEL_CATEGORY_STYLES.other;
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

  // V2 Phase 1A: search + cursor pagination over /api/inbox/threads.
  // searchQuery is the active query forwarded to the route (Gmail's native
  // q= syntax — supports operators like from:, subject:, has:attachment).
  // searchInput is the debounced input buffer.
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  // Cursor stack: each entry is the cursor that loaded the page currently
  // visible. Top of stack = current page. Pop to go Newer; push current +
  // navigate with nextCursor to go Older. Empty stack = at first page.
  const [cursorStack, setCursorStack] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);

  const loadAccounts = useCallback(async () => {
    try {
      const r = await apiFetch('/api/inbox/accounts', { headers: { Authorization: `Bearer ${authToken}` } });
      const data = await r.json();
      setAccounts(Array.isArray(data) ? data : []);
    } catch {
      setAccounts([]);
    }
  }, [apiFetch, authToken]);

  // currentCursor is the cursor used for the page in view (top of the
  // cursorStack), or '' for page 1. Passed to /api/inbox/threads.
  const currentCursor = cursorStack.length ? cursorStack[cursorStack.length - 1] : '';
  // AbortController-aware loader — fast typing in search + flipping account
  // filter previously fired overlapping fetches; the slower one would
  // resolve last and clobber the fresh result. Now: each call carries an
  // AbortController and the caller (the useEffect below) cancels the prior
  // one when deps change, avoiding both stale-state writes and unmount-
  // after-fetch setState calls.
  const loadThreads = useCallback(async (signal) => {
    setThreadsLoading(true);
    setThreadsError(null);
    try {
      const qs = new URLSearchParams();
      if (accountFilter) qs.set('account_email', accountFilter);
      qs.set('max_results', '25');
      if (searchQuery) qs.set('query', searchQuery);
      if (currentCursor) qs.set('cursor', currentCursor);
      const r = await apiFetch(`/api/inbox/threads?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${authToken}` },
        signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (signal?.aborted) return; // a newer call superseded us
      const list = Array.isArray(data?.threads) ? data.threads : [];
      setThreads(list);
      setNextCursor(data?.nextCursor || null);
      onUnreadCountChange?.(list.filter(t => !t.isRead).length);
    } catch (err) {
      if (err.name === 'AbortError' || signal?.aborted) return;
      setThreadsError(err.message || 'Failed');
      setThreads([]);
      setNextCursor(null);
    } finally {
      if (!signal?.aborted) setThreadsLoading(false);
    }
  }, [accountFilter, apiFetch, authToken, onUnreadCountChange, searchQuery, currentCursor]);

  // Reset pagination whenever the search query or account filter changes —
  // staying on a deep cursor across a context shift returns nonsense.
  useEffect(() => { setCursorStack([]); }, [searchQuery, accountFilter]);

  // 400ms debounce on the search input. Enter triggers immediately via
  // the input's onKeyDown handler below.
  useEffect(() => {
    const t = setTimeout(() => setSearchQuery(searchInput.trim()), 400);
    return () => clearTimeout(t);
  }, [searchInput]);

  function goOlder() {
    if (!nextCursor) return;
    setCursorStack((prev) => [...prev, nextCursor]);
  }
  function goNewer() {
    setCursorStack((prev) => prev.slice(0, -1));
  }
  function clearSearch() {
    setSearchInput('');
    setSearchQuery('');
  }

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
  useEffect(() => {
    const ctrl = new AbortController();
    loadThreads(ctrl.signal);
    return () => ctrl.abort();
  }, [loadThreads]);

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

  // Star toggle. Tracked on the thread row optimistically so swipe-right
  // gives instant feedback even before the server round-trip completes.
  async function starSingle(t, nextState) {
    const messageId = t.latestMessageId || t.id;
    if (!messageId) return;
    const desired = typeof nextState === 'boolean' ? nextState : !t.starred;
    setThreads((prev) => prev.map(x => x.id === t.id ? { ...x, starred: desired } : x));
    try {
      await apiFetch('/api/inbox/star', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ account_email: t.accountEmail, message_id: messageId, starred: desired }),
      });
    } catch {
      // Revert optimistic flip on failure.
      setThreads((prev) => prev.map(x => x.id === t.id ? { ...x, starred: !desired } : x));
    }
  }

  // Move-to picker state — shown from the thread detail action bar.
  // Loaded once at mount so row label chips can render immediately and
  // the picker has data on first open.
  const [movePickerOpen, setMovePickerOpen] = useState(false);
  const [moveLabels, setMoveLabels] = useState([]);
  const [moveLabelsLoading, setMoveLabelsLoading] = useState(false);
  const [moveSelectedLabel, setMoveSelectedLabel] = useState(null);

  // O(1) lookup keyed by `${accountEmail}::${labelId}` so each ThreadRow
  // can resolve its first mapped Gmail label to a colored chip without
  // scanning the full label list.
  const labelLookup = useMemo(() => {
    const map = {};
    for (const l of moveLabels) {
      map[`${l.accountEmail}::${l.labelId}`] = l;
    }
    return map;
  }, [moveLabels]);

  const loadLabels = useCallback(async () => {
    setMoveLabelsLoading(true);
    try {
      const r = await apiFetch('/api/inbox/labels', { headers: { Authorization: `Bearer ${authToken}` } });
      const data = await r.json();
      setMoveLabels(Array.isArray(data?.labels) ? data.labels : []);
    } catch { setMoveLabels([]); }
    finally { setMoveLabelsLoading(false); }
  }, [apiFetch, authToken]);
  useEffect(() => { loadLabels(); }, [loadLabels]);

  function openMovePicker() {
    setMovePickerOpen(true);
    setMoveSelectedLabel(null);
    if (!moveLabels.length && !moveLabelsLoading) loadLabels();
  }

  async function moveCurrent(scope) {
    if (!thread || !moveSelectedLabel || !activeAccount) return;
    const lastMsg = thread.messages?.[thread.messages.length - 1];
    if (!lastMsg) return;
    try {
      await apiFetch('/api/inbox/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          account_email: activeAccount,
          message_id: lastMsg.id,
          target_label_id: moveSelectedLabel.labelId,
          target_label_name: moveSelectedLabel.labelName,
          scope,
        }),
      });
      toast.success(`Moved to ${moveSelectedLabel.labelName}`);
      removeThreadFromZones(thread.id);
      setThreads((prev) => prev.filter(x => x.id !== thread.id));
      setThread(null);
      setActiveThreadId(null);
      setMobileShowThread(false);
      setMovePickerOpen(false);
    } catch {
      toast.error('Move failed');
    }
  }

  async function starCurrent() {
    if (!thread) return;
    const t = threads.find((x) => x.id === thread.id);
    if (t) await starSingle(t);
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
      {/* Left panel — w-96 (384px) per V2 design comp. */}
      <div
        className={`flex-col h-full ${mobileShowThread ? 'hidden md:flex' : 'flex'}`}
        style={{ width: 384, minWidth: 384, flexShrink: 0, backgroundColor: '#f5f2fa', borderRight: '1px solid rgba(0,0,0,0.08)', position: 'relative' }}
      >
        {/* Header: Inbox title + unread count badge */}
        <div className="px-5 pt-5 pb-3">
          <div className="flex items-baseline gap-2">
            <h1 className="text-2xl font-extrabold text-gray-900" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>Inbox</h1>
            {(() => {
              const unread = threads.filter(t => !t.isRead).length;
              if (!unread) return null;
              return (
                <span
                  className="px-2 py-0.5 rounded-full text-[11px] font-bold"
                  style={{ backgroundColor: '#ededff', color: '#4f4dcf' }}
                >
                  {unread}
                </span>
              );
            })()}
          </div>
        </div>

        {/* Search — full width, icon left */}
        <div className="px-5 pb-2">
          <div className="relative">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" style={{ fontSize: 18 }}>search</span>
            <input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') setSearchQuery(searchInput.trim()); }}
              placeholder="Search emails..."
              className="w-full pl-10 pr-9 py-2 bg-white text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              style={{ borderRadius: 10, border: '1px solid rgba(0,0,0,0.08)' }}
            />
            {(searchInput || searchQuery) && (
              <button
                type="button"
                onClick={clearSearch}
                aria-label="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
              </button>
            )}
          </div>
          {searchQuery && !threadsLoading && (
            <div className="mt-1.5 text-[11px] text-gray-500">
              {threads.length === 0
                ? <>No results for <span className="font-semibold text-gray-700">&ldquo;{searchQuery}&rdquo;</span></>
                : <>{threads.length} result{threads.length === 1 ? '' : 's'} for <span className="font-semibold text-gray-700">&ldquo;{searchQuery}&rdquo;</span></>}
            </div>
          )}
        </div>

        {/* Filter pills + account dropdown right-aligned */}
        <div className="px-5 pb-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            {[
              { key: 'all',    label: 'All' },
              { key: 'unread', label: 'Unread' },
              { key: 'action', label: 'Action' },
            ].map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setPillFilter(key)}
                className="px-2.5 py-1 text-[11px] font-semibold rounded-full transition-colors"
                style={pillFilter === key
                  ? { backgroundColor: '#4f4dcf', color: '#fff' }
                  : { backgroundColor: 'transparent', color: '#6b7280', border: '1px solid rgba(0,0,0,0.08)' }}
              >
                {label}
              </button>
            ))}
          </div>
          {accounts.length > 0 && (
            <select
              value={accountFilter}
              onChange={(e) => setAccountFilter(e.target.value)}
              className="text-[11px] text-gray-700 bg-white px-2 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              style={{ borderRadius: 8, border: '1px solid rgba(0,0,0,0.08)', maxWidth: 140 }}
              title="Filter by account"
            >
              <option value="">All accounts</option>
              {accounts.map((a) => {
                // Legacy placeholder rows can have empty account_email —
                // showing a blank <option> is invisible and confusing.
                // Fall back to a labeled "Account #id (reconnect)" so the
                // user sees the integration exists and knows the action.
                const label = (a.account_email && a.account_email.trim())
                  ? shortAccount(a.account_email)
                  : `Account #${a.id} (reconnect)`;
                return (
                  <option key={a.id} value={a.account_email || ''}>{label}</option>
                );
              })}
            </select>
          )}
        </div>
        <div className="flex-1 overflow-y-auto px-3 pb-3">
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
                {zones.attn.map(t => renderThreadRow({ t, activeThreadId, classifications, openThread, archiveSingle, markThreadRead, starSingle, labelLookup }))}
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
                {zones.review.map(t => renderThreadRow({ t, activeThreadId, classifications, openThread, archiveSingle, markThreadRead, starSingle, labelLookup }))}
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
                {zones.low.map(t => renderThreadRow({ t, activeThreadId, classifications, openThread, archiveSingle, markThreadRead, starSingle, labelLookup }))}
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
                {zones.read.map(t => renderThreadRow({ t, activeThreadId, classifications, openThread, archiveSingle, markThreadRead, starSingle, labelLookup }))}
              </Zone>
            </>
          )}
        </div>

        {/* V2 pagination — pinned to the bottom of the panel (not inline
            at the end of the scroll list, per the design comp). */}
        {!threadsLoading && !threadsError && (cursorStack.length > 0 || nextCursor) && (
          <div
            className="px-4 py-2 flex items-center justify-between text-[12px]"
            style={{ backgroundColor: '#f5f2fa', borderTop: '1px solid rgba(0,0,0,0.08)' }}
          >
            <button
              type="button"
              onClick={goNewer}
              disabled={cursorStack.length === 0}
              className="px-2.5 py-1 rounded-md font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ color: '#4f4dcf' }}
            >
              ← Newer
            </button>
            <span className="text-gray-500">
              {cursorStack.length === 0 ? 'Showing latest 25' : `Page ${cursorStack.length + 1}`}
            </span>
            <button
              type="button"
              onClick={goOlder}
              disabled={!nextCursor}
              className="px-2.5 py-1 rounded-md font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ color: '#4f4dcf' }}
            >
              Older →
            </button>
          </div>
        )}

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
                      <div key={m.ts || i} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
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
            {/* Thread header: back (mobile), subject, sender row */}
            <div className="px-6 pt-5 pb-4 bg-white" style={{ borderBottom: '1px solid rgba(0,0,0,0.08)' }}>
              <button
                onClick={() => setMobileShowThread(false)}
                className="md:hidden flex items-center gap-1 text-gray-500 mb-2 text-xs font-semibold"
                title="Back"
              >
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>arrow_back</span>
                Back
              </button>
              <h2
                className="text-[18px] font-semibold text-gray-900 leading-snug break-words"
                style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}
              >
                {thread?.messages?.[0]?.subject || '(no subject)'}
              </h2>
              {(() => {
                const latest = thread?.messages?.[thread.messages.length - 1];
                if (!latest) return null;
                const senderRaw = senderName(latest.from) || senderEmail(latest.from);
                const av = avatarColorForSender(senderEmail(latest.from) || senderRaw);
                return (
                  <div className="mt-3 flex items-center gap-3">
                    <div
                      className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
                      style={{ backgroundColor: av.bg, color: av.fg, fontSize: 12, fontWeight: 700, fontFamily: "'Plus Jakarta Sans', sans-serif" }}
                    >
                      {initials(senderRaw)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-gray-900 truncate" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                        {senderRaw}
                      </div>
                      <div className="text-[11px] text-gray-500 truncate">
                        to {latest.to || activeAccount || 'me'} · {absTime(latest.date)}
                      </div>
                    </div>
                    {activeAccount && (() => { const tint = tintForAccount(activeAccount); return (
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0" style={{ backgroundColor: tint.bg, color: tint.fg }}>
                        {shortAccount(activeAccount)}
                      </span>
                    ); })()}
                  </div>
                );
              })()}
              {/* Label chips row — Gmail labels on the latest message, semantic-colored */}
              {(() => {
                const latest = thread?.messages?.[thread.messages.length - 1];
                if (!latest || !Array.isArray(latest.labelIds) || !latest.labelIds.length) return null;
                const SYS = /^(UNREAD|INBOX|STARRED|IMPORTANT|SENT|DRAFT|TRASH|SPAM|CHAT|CATEGORY_)/;
                const chips = latest.labelIds
                  .filter((lid) => !SYS.test(lid))
                  .map((lid) => labelLookup?.[`${activeAccount}::${lid}`])
                  .filter(Boolean);
                if (!chips.length) return null;
                return (
                  <div className="mt-3 flex items-center gap-1.5 flex-wrap">
                    {chips.map((c) => {
                      const ls = labelStyleFor(c.semanticCategory);
                      return (
                        <span key={c.labelId} className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ backgroundColor: ls.bg, color: ls.fg }}>
                          {c.labelName}
                        </span>
                      );
                    })}
                  </div>
                );
              })()}
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

            {thread && (() => {
              // "Reply in Gmail" deeplink — opens this thread in Gmail web
              // so the user can reply with their normal compose UX. We
              // skip the inline ComposeDrawer for this primary action.
              const gmailUrl = activeAccount && thread.id
                ? `https://mail.google.com/mail/u/0/#inbox/${thread.id}`
                : null;
              const currentRow = threads.find((x) => x.id === thread.id);
              return (
                <div className="px-4 py-2.5 space-y-1.5" style={{ backgroundColor: '#f5f2fa', borderTop: '1px solid rgba(0,0,0,0.08)' }}>
                  {/* Row 1: Reply / Reply All / Forward + primary "Reply in Gmail" */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <ActionBtn icon="reply"     label="Reply"     onClick={() => openCompose('reply')} />
                    <ActionBtn icon="reply_all" label="Reply All" onClick={() => openCompose('replyAll')} />
                    <ActionBtn icon="forward"   label="Forward"   onClick={() => openCompose('forward')} />
                    {gmailUrl && (
                      <a
                        href={gmailUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold rounded-lg shadow-sm"
                        style={{ backgroundColor: '#4f4dcf', color: '#fff' }}
                        title="Open this thread in Gmail to reply"
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 15 }}>open_in_new</span>
                        Reply in Gmail
                      </a>
                    )}
                  </div>
                  {/* Row 2: Archive / Mark read / Star / Move to */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <ActionBtn icon="archive" label="Archive" onClick={archiveCurrent} />
                    <ActionBtn
                      icon="mark_email_read"
                      label="Mark read"
                      onClick={() => { if (currentRow) markThreadRead(currentRow); }}
                    />
                    <ActionBtn
                      icon={currentRow?.starred ? 'star' : 'star_outline'}
                      label={currentRow?.starred ? 'Unstar' : 'Star'}
                      onClick={starCurrent}
                    />
                    <ActionBtn icon="drive_file_move" label="Move to..." onClick={openMovePicker} />
                  </div>
                </div>
              );
            })()}

            {/* Move-to picker — modal-ish overlay anchored to the thread detail. */}
            {movePickerOpen && (
              <div className="absolute inset-0 z-20 flex items-end md:items-center md:justify-center bg-black/30" onClick={() => setMovePickerOpen(false)}>
                <div
                  className="w-full md:w-[420px] bg-white rounded-t-2xl md:rounded-2xl shadow-xl p-4 max-h-[70vh] overflow-y-auto"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-bold text-gray-900" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>Move to label</h3>
                    <button onClick={() => setMovePickerOpen(false)} className="text-gray-400 hover:text-gray-600">
                      <span className="material-symbols-outlined" style={{ fontSize: 18 }}>close</span>
                    </button>
                  </div>
                  {moveLabelsLoading ? (
                    <div className="py-6 text-center text-xs text-gray-500">Loading labels…</div>
                  ) : moveLabels.length === 0 ? (
                    <div className="py-6 text-center text-xs text-gray-500">No labels found. Create one in Gmail first.</div>
                  ) : !moveSelectedLabel ? (
                    <div className="space-y-1">
                      {moveLabels.map((l) => (
                        <button
                          key={`${l.accountEmail}::${l.labelId}`}
                          onClick={() => setMoveSelectedLabel(l)}
                          className="w-full text-left px-3 py-2 rounded-lg hover:bg-gray-50 flex items-center justify-between"
                        >
                          <div>
                            <div className="text-sm font-semibold text-gray-800">{l.labelName}</div>
                            <div className="text-[10px] text-gray-400">
                              {l.semanticCategory || 'unmapped'}{l.messageCount ? ` · ${l.messageCount} msgs` : ''}
                            </div>
                          </div>
                          <span className="material-symbols-outlined text-gray-400" style={{ fontSize: 16 }}>chevron_right</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div>
                      <div className="text-xs text-gray-500 mb-2">
                        Move to <span className="font-semibold text-gray-800">{moveSelectedLabel.labelName}</span>:
                      </div>
                      <div className="space-y-1">
                        <button onClick={() => moveCurrent('thread')} className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-gray-50 border border-gray-200">
                          <div className="text-sm font-semibold text-gray-800">Just this email</div>
                          <div className="text-[11px] text-gray-500">One-off move; no future filing.</div>
                        </button>
                        <button onClick={() => moveCurrent('sender')} className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-gray-50 border border-gray-200">
                          <div className="text-sm font-semibold text-gray-800">All emails from this sender</div>
                          <div className="text-[11px] text-gray-500">Records a filing pattern. Aria can later auto-file.</div>
                        </button>
                        <button onClick={() => moveCurrent('domain')} className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-gray-50 border border-gray-200">
                          <div className="text-sm font-semibold text-gray-800">All emails from this domain</div>
                          <div className="text-[11px] text-gray-500">Records a domain-wide filing pattern.</div>
                        </button>
                      </div>
                      <button onClick={() => setMoveSelectedLabel(null)} className="mt-3 text-xs font-semibold text-gray-500">← Back</button>
                    </div>
                  )}
                </div>
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

// Wrapper so call sites stay readable; the real swipe + render lives in
// <ThreadRow /> below.
function renderThreadRow(props) {
  return <ThreadRow key={`${props.t.accountEmail}:${props.t.id}`} {...props} />;
}

// SWIPE_THRESHOLD: minimum horizontal travel (px) before we commit to
// revealing the action drawer. Below this we treat the gesture as a tap.
const SWIPE_THRESHOLD = 60;
const SWIPE_DRAWER_WIDTH = 140; // px — width of the revealed action panel

function ThreadRow({ t, activeThreadId, classifications, openThread, archiveSingle, markThreadRead, starSingle, labelLookup }) {
  const tint = tintForAccount(t.accountEmail);
  const active = t.id === activeThreadId;
  const mid = t.latestMessageId || t.id;
  const cls = classifications[mid];
  const impStyle = cls ? IMPORTANCE_STYLES[cls.importance] : null;
  const senderDisplay = senderName(t.from) || shortAccount(t.accountEmail);
  const avatar = avatarColorForSender(senderEmail(t.from) || senderDisplay);

  // Unread dot color (rendered as a small overlay on the avatar):
  // critical=red, high=amber, otherwise primary.
  let unreadDotBg = null;
  if (!t.isRead) {
    if (impStyle && cls.importance === 'critical') unreadDotBg = '#ef4444';
    else if (impStyle && cls.importance === 'high') unreadDotBg = '#f59e0b';
    else unreadDotBg = '#4f4dcf';
  }

  // Find the first user-mapped Gmail label on this thread to render as
  // a colored category chip. Skip system labels (UNREAD, INBOX, STARRED,
  // CATEGORY_*, IMPORTANT) — those aren't filing intent.
  const SYSTEM_LABEL_RE = /^(UNREAD|INBOX|STARRED|IMPORTANT|SENT|DRAFT|TRASH|SPAM|CHAT|CATEGORY_)/;
  const labelChip = (() => {
    if (!labelLookup || !Array.isArray(t.labelIds)) return null;
    for (const lid of t.labelIds) {
      if (SYSTEM_LABEL_RE.test(lid)) continue;
      const found = labelLookup[`${t.accountEmail}::${lid}`];
      if (found) return found;
    }
    return null;
  })();
  const labelStyle = labelChip ? labelStyleFor(labelChip.semanticCategory) : null;
  const showClsChip = cls && cls.importanceRank >= 3 && !SUPPRESS_PILL.has(cls.category);

  // Swipe state — touch-only (mobile). Desktop uses the hover actions.
  const touchStartX = useRef(null);
  const touchDeltaX = useRef(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);

  function onTouchStart(e) {
    touchStartX.current = e.touches[0].clientX;
    touchDeltaX.current = 0;
  }
  function onTouchMove(e) {
    if (touchStartX.current == null) return;
    touchDeltaX.current = e.touches[0].clientX - touchStartX.current;
    // Live-track left swipes only when the drawer is closed; clamp.
    if (!drawerOpen && touchDeltaX.current < 0) {
      setDragOffset(Math.max(touchDeltaX.current, -SWIPE_DRAWER_WIDTH));
    }
  }
  function onTouchEnd() {
    const delta = touchDeltaX.current;
    touchStartX.current = null;
    touchDeltaX.current = 0;

    if (drawerOpen) {
      // Any tap on the row body while drawer is open: close it (the action
      // buttons themselves stop propagation in their own onClick handlers).
      setDrawerOpen(false);
      setDragOffset(0);
      return;
    }
    if (delta <= -SWIPE_THRESHOLD) {
      // Commit to revealed drawer — Archive + Mark Read.
      setDrawerOpen(true);
      setDragOffset(-SWIPE_DRAWER_WIDTH);
    } else if (delta >= SWIPE_THRESHOLD) {
      // Right swipe → toggle star.
      starSingle?.(t);
      setDragOffset(0);
    } else {
      // Below threshold — snap back; tap-through to onClick handles open.
      setDragOffset(0);
    }
  }

  return (
    <div
      key={`${t.accountEmail}:${t.id}`}
      className="group relative mb-1 transition-colors overflow-hidden"
      style={{
        borderRadius: 10,
        backgroundColor: active ? '#ededff' : 'transparent',
        borderLeft: active ? '3px solid #4f4dcf' : '3px solid transparent',
      }}
    >
      {/* Mobile swipe drawer — sits behind the row, revealed on left-swipe. */}
      <div
        className="md:hidden absolute inset-y-0 right-0 flex items-stretch"
        style={{ width: SWIPE_DRAWER_WIDTH }}
        aria-hidden={!drawerOpen}
      >
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); markThreadRead(t); setDrawerOpen(false); setDragOffset(0); }}
          className="flex-1 flex flex-col items-center justify-center text-white text-[10px] font-semibold"
          style={{ backgroundColor: '#3b82f6' }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>mark_email_read</span>
          Read
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); archiveSingle(t); setDrawerOpen(false); setDragOffset(0); }}
          className="flex-1 flex flex-col items-center justify-center text-white text-[10px] font-semibold"
          style={{ backgroundColor: '#6b7280' }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>archive</span>
          Archive
        </button>
      </div>

      <div
        className="relative"
        style={{
          transform: `translateX(${dragOffset}px)`,
          transition: touchStartX.current == null ? 'transform 160ms ease' : 'none',
          // Solid background so the swipe drawer behind isn't visible
          // through the row at rest. Match panel surface (#f5f2fa) when
          // inactive, primary container (#ededff) when selected. The
          // drawer only shows when this wrapper translates left.
          backgroundColor: active ? '#ededff' : '#f5f2fa',
        }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
      <button
        onClick={() => { if (drawerOpen) { setDrawerOpen(false); setDragOffset(0); return; } openThread(t); }}
        className="w-full text-left px-3 py-2.5 transition-colors hover:bg-[#f5f2fa]"
        style={{ backgroundColor: 'transparent' }}
      >
        <div className="flex items-start gap-3">
          {/* Avatar — 36×36 circle, initials, hashed color, with unread dot overlay */}
          <div className="relative flex-shrink-0">
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center"
              style={{
                backgroundColor: avatar.bg,
                color: avatar.fg,
                fontSize: 12,
                fontWeight: 700,
                fontFamily: "'Plus Jakarta Sans', sans-serif",
              }}
            >
              {initials(senderDisplay)}
            </div>
            {unreadDotBg && (
              <span
                className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full"
                style={{ backgroundColor: unreadDotBg, border: '2px solid #f5f2fa' }}
                aria-label="unread"
              />
            )}
            {t.starred && (
              <span
                className="absolute -top-0.5 -right-0.5 material-symbols-outlined"
                style={{ fontSize: 12, color: '#f59e0b' }}
                aria-label="starred"
              >
                star
              </span>
            )}
          </div>

          <div className="flex-1 min-w-0">
            {/* Sender + timestamp */}
            <div className="flex items-center justify-between gap-2">
              <span
                className={`text-sm truncate ${t.isRead ? 'text-gray-600' : 'text-gray-900 font-bold'}`}
                style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}
              >
                {senderDisplay}
              </span>
              <span className="text-[10px] text-gray-400 flex-shrink-0">{relTime(t.date)}</span>
            </div>
            {/* Subject */}
            <div className={`text-[13px] truncate mt-0.5 ${t.isRead ? 'text-gray-500' : 'text-gray-800 font-semibold'}`}>
              {decodeHtmlEntities(t.subject) || '(no subject)'}
            </div>
            {/* Snippet */}
            <div className="text-xs text-gray-400 truncate mt-0.5">{decodeHtmlEntities(t.snippet)}</div>
            {/* Tags row: account chip + label chip + classification chip */}
            <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
              <span className="inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style={{ backgroundColor: '#ededff', color: '#4f4dcf' }}>
                {shortAccount(t.accountEmail)}{t.messageCount > 1 ? ` · ${t.messageCount}` : ''}
              </span>
              {labelChip && (
                <span
                  className="inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded-full truncate"
                  style={{ backgroundColor: labelStyle.bg, color: labelStyle.fg, maxWidth: 120 }}
                  title={`${labelChip.labelName} → ${labelChip.semanticCategory || 'unmapped'}`}
                >
                  {labelChip.labelName}
                </span>
              )}
              {showClsChip && (
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
      </div>
      {/* Hover actions — desktop only. Outside the swipe transform so
          they stay anchored regardless of mobile drawer state. */}
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
        {starSingle && (
          <button
            onClick={(e) => { e.stopPropagation(); starSingle(t); }}
            title={t.starred ? 'Unstar' : 'Star'}
            className="w-7 h-7 rounded-lg flex items-center justify-center bg-white border border-gray-200 hover:bg-gray-50"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '15px', color: t.starred ? '#f59e0b' : '#9ca3af' }}>
              {t.starred ? 'star' : 'star_outline'}
            </span>
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
              <div key={m.ts || i} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
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
