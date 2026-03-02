import { useState, useEffect, useRef, useCallback, useMemo } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const TAGS = ['Careific', 'Rose', 'Buyflip', 'Care Home', 'Personal'];

const TAG_STYLES = {
  Careific:    'bg-indigo-100 text-indigo-700 border-indigo-200',
  Rose:        'bg-pink-100   text-pink-700   border-pink-200',
  Buyflip:     'bg-amber-100  text-amber-700  border-amber-200',
  'Care Home': 'bg-teal-100   text-teal-700   border-teal-200',
  Personal:    'bg-slate-100  text-slate-600  border-slate-200',
};

const TAG_ACTIVE_RING = {
  Careific:    'ring-indigo-400',
  Rose:        'ring-pink-400',
  Buyflip:     'ring-amber-400',
  'Care Home': 'ring-teal-400',
  Personal:    'ring-slate-400',
};

const PRIORITY_BORDER = {
  high:   'border-l-4 border-l-red-500',
  medium: 'border-l-4 border-l-amber-400',
  low:    'border-l-4 border-l-green-500',
};

const PRIORITY_BADGE = {
  high:   'bg-red-50   text-red-500',
  medium: 'bg-amber-50 text-amber-500',
  low:    'bg-green-50 text-green-600',
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ─────────────────────────────────────────────────────────────────────────────
// AI UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

async function fetchSuggestedTags(title, description, claudeKey) {
  if (!claudeKey || !title.trim()) return [];

  const prompt =
    `Given these business categories: Careific (AI care management SaaS platform), ` +
    `Rose (a specific care home facility), Buyflip (a separate business venture), ` +
    `Care Home (general care home operations), Personal (personal tasks). ` +
    `Based on this task title and description: '${title} - ${description}', ` +
    `suggest which tags apply. Respond ONLY with a JSON array of matching tag names, ` +
    `e.g. ["Careific", "Personal"]. No explanation.`;

  try {
    const res = await fetch('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: claudeKey,
        model: 'claude-sonnet-4-20250514',
        max_tokens: 100,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) return [];
    const data = await res.json();
    const text = data.content?.[0]?.text || '';
    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    return parsed.filter((t) => TAGS.includes(t));
  } catch {
    return [];
  }
}

async function callClaudeChat(messages, systemPrompt, apiKey) {
  const res = await fetch('/api/claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey,
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text || '(no response)';
}

async function callOpenAIChat(messages, systemPrompt, apiKey) {
  const res = await fetch('/api/openai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey,
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '(no response)';
}

// ─────────────────────────────────────────────────────────────────────────────
// TAG PILL
// ─────────────────────────────────────────────────────────────────────────────

function TagPill({ tag, isAi = false }) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium border ${TAG_STYLES[tag]}`}
    >
      {tag}
      {isAi && (
        <span className="text-[9px] leading-none bg-indigo-500 text-white px-1 py-0.5 rounded-full">
          AI
        </span>
      )}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS MODAL
// ─────────────────────────────────────────────────────────────────────────────

function SettingsModal({ apiKeys, onSave, onClose }) {
  const [draft, setDraft] = useState({ ...apiKeys });

  function handleKeyDown(e) {
    if (e.key === 'Escape') onClose();
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50"
      onKeyDown={handleKeyDown}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6 animate-in fade-in">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-gray-100 rounded-lg flex items-center justify-center">
              <GearIcon className="w-4 h-4 text-gray-600" />
            </div>
            <h2 className="text-lg font-bold text-gray-900">API Settings</h2>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg p-1 transition-colors"
          >
            <XIcon className="w-5 h-5" />
          </button>
        </div>

        <p className="text-xs text-gray-500 mb-5 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
          Keys are stored in memory only and never sent to any server other than
          the respective AI provider via the local proxy.
        </p>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Claude API Key
            </label>
            <input
              type="password"
              value={draft.claude}
              onChange={(e) => setDraft((k) => ({ ...k, claude: e.target.value }))}
              placeholder="sk-ant-api03-..."
              autoComplete="off"
              className="w-full px-3 py-2 bg-gray-100 border border-gray-200 rounded-lg text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition"
            />
            <p className="text-xs text-gray-400 mt-1">
              Powers AI tag suggestions + Claude chat
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              OpenAI API Key
            </label>
            <input
              type="password"
              value={draft.openai}
              onChange={(e) => setDraft((k) => ({ ...k, openai: e.target.value }))}
              placeholder="sk-..."
              autoComplete="off"
              className="w-full px-3 py-2 bg-gray-100 border border-gray-200 rounded-lg text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition"
            />
            <p className="text-xs text-gray-400 mt-1">Powers ChatGPT chat</p>
          </div>
        </div>

        <div className="flex gap-3 mt-6">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2.5 border border-gray-200 rounded-xl text-gray-700 hover:bg-gray-50 font-medium text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              onSave(draft);
              onClose();
            }}
            className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 font-medium text-sm transition-colors shadow-sm"
          >
            Save Keys
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ADD TASK FORM
// ─────────────────────────────────────────────────────────────────────────────

function AddTaskForm({ onAdd, claudeKey }) {
  const emptyForm = {
    title: '',
    description: '',
    priority: 'medium',
    dueDate: '',
    tags: [],
  };

  const [form, setForm] = useState(emptyForm);
  const [aiSuggested, setAiSuggested] = useState([]); // tags AI recommended
  const [suggesting, setSuggesting] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const debounceRef = useRef(null);

  const runSuggestion = useCallback(
    async (title, desc) => {
      if (!claudeKey || !title.trim()) return;
      setSuggesting(true);
      const suggested = await fetchSuggestedTags(title, desc, claudeKey);
      setSuggesting(false);
      if (suggested.length > 0) {
        setAiSuggested(suggested);
        setForm((f) => ({
          ...f,
          tags: [...new Set([...f.tags, ...suggested])],
        }));
      }
    },
    [claudeKey],
  );

  function scheduleOrRunSuggestion(title, desc) {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSuggestion(title, desc), 600);
  }

  function handleTitleChange(e) {
    const val = e.target.value;
    setForm((f) => ({ ...f, title: val }));
    scheduleOrRunSuggestion(val, form.description);
  }

  function handleDescChange(e) {
    const val = e.target.value;
    setForm((f) => ({ ...f, description: val }));
    scheduleOrRunSuggestion(form.title, val);
  }

  function handleBlur() {
    clearTimeout(debounceRef.current);
    runSuggestion(form.title, form.description);
  }

  function toggleTag(tag) {
    setForm((f) => ({
      ...f,
      tags: f.tags.includes(tag)
        ? f.tags.filter((t) => t !== tag)
        : [...f.tags, tag],
    }));
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (!form.title.trim()) return;
    onAdd({
      id: uid(),
      ...form,
      completed: false,
      createdAt: new Date().toISOString(),
    });
    setForm(emptyForm);
    setAiSuggested([]);
    setIsOpen(false);
  }

  return (
    <div className="mb-5">
      {!isOpen ? (
        <button
          onClick={() => setIsOpen(true)}
          className="w-full flex items-center gap-2 px-4 py-3 bg-white border-2 border-dashed border-gray-200 rounded-xl text-gray-400 hover:border-indigo-300 hover:text-indigo-500 hover:bg-indigo-50/30 transition-all text-sm font-medium group"
        >
          <span className="w-5 h-5 rounded-full bg-gray-100 group-hover:bg-indigo-100 flex items-center justify-center text-base leading-none transition-colors">
            +
          </span>
          Add new task
        </button>
      ) : (
        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-xl border border-gray-200 shadow-sm p-5"
        >
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-900">New Task</h3>
            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                setForm(emptyForm);
                setAiSuggested([]);
              }}
              className="text-gray-300 hover:text-gray-500 transition-colors"
            >
              <XIcon className="w-4 h-4" />
            </button>
          </div>

          <div className="space-y-3">
            {/* Title */}
            <input
              type="text"
              placeholder="Task title *"
              value={form.title}
              onChange={handleTitleChange}
              onBlur={handleBlur}
              autoFocus
              required
              className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition"
            />

            {/* Description */}
            <textarea
              placeholder="Description (optional) — helps AI suggest tags"
              value={form.description}
              onChange={handleDescChange}
              onBlur={handleBlur}
              rows={2}
              className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition resize-none"
            />

            {/* Priority + Due Date */}
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  Priority
                </label>
                <select
                  value={form.priority}
                  onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}
                  className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition"
                >
                  <option value="low">🟢 Low</option>
                  <option value="medium">🟡 Medium</option>
                  <option value="high">🔴 High</option>
                </select>
              </div>

              <div className="flex-1">
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  Due Date
                </label>
                <input
                  type="date"
                  value={form.dueDate}
                  onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value }))}
                  className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition"
                />
              </div>
            </div>

            {/* Tags */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-medium text-gray-500">Tags</span>
                {suggesting && (
                  <span className="text-xs text-indigo-500 flex items-center gap-1">
                    <SpinnerIcon className="w-3 h-3 animate-spin" />
                    AI suggesting…
                  </span>
                )}
                {!suggesting && aiSuggested.length > 0 && (
                  <span className="text-xs text-indigo-400 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 inline-block" />
                    AI auto-selected tags
                  </span>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                {TAGS.map((tag) => {
                  const isSelected = form.tags.includes(tag);
                  const isAiPick = aiSuggested.includes(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => toggleTag(tag)}
                      className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full font-medium border transition-all ${
                        isSelected
                          ? `${TAG_STYLES[tag]} ring-2 ring-offset-1 ${TAG_ACTIVE_RING[tag]}`
                          : 'bg-gray-50 text-gray-500 border-gray-200 hover:bg-gray-100'
                      }`}
                    >
                      {tag}
                      {isAiPick && isSelected && (
                        <span className="text-[9px] leading-none bg-indigo-500 text-white px-1 py-0.5 rounded-full">
                          AI
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setIsOpen(false);
                  setForm(emptyForm);
                  setAiSuggested([]);
                }}
                className="flex-1 px-4 py-2 border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 text-sm font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium transition-colors shadow-sm"
              >
                Add Task
              </button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TASK CARD
// ─────────────────────────────────────────────────────────────────────────────

function TaskCard({ task, onToggle, onDelete }) {
  const overdue =
    task.dueDate && !task.completed && new Date(task.dueDate) < new Date();

  return (
    <div
      className={`bg-white rounded-xl border border-gray-100 shadow-sm p-4 ${PRIORITY_BORDER[task.priority]} transition-opacity ${
        task.completed ? 'opacity-55' : 'opacity-100'
      }`}
    >
      <div className="flex items-start gap-3">
        {/* Checkbox */}
        <label className="flex items-center mt-0.5 cursor-pointer">
          <input
            type="checkbox"
            checked={task.completed}
            onChange={() => onToggle(task.id)}
            className="w-4 h-4 accent-indigo-600 rounded cursor-pointer"
          />
        </label>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <h4
              className={`text-sm font-medium leading-snug ${
                task.completed
                  ? 'line-through text-gray-400'
                  : 'text-gray-900'
              }`}
            >
              {task.title}
            </h4>
            <button
              onClick={() => onDelete(task.id)}
              className="flex-shrink-0 text-gray-200 hover:text-red-400 transition-colors mt-0.5"
              title="Delete task"
            >
              <XIcon className="w-4 h-4" />
            </button>
          </div>

          {task.description && (
            <p className="text-xs text-gray-500 mt-1 line-clamp-2 leading-relaxed">
              {task.description}
            </p>
          )}

          {/* Footer: tags left, meta right */}
          <div className="flex items-end justify-between gap-2 mt-2.5">
            <div className="flex flex-wrap gap-1">
              {task.tags.map((tag) => (
                <TagPill key={tag} tag={tag} />
              ))}
            </div>

            <div className="flex items-center gap-1.5 flex-shrink-0 ml-1">
              <span
                className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${PRIORITY_BADGE[task.priority]}`}
              >
                {task.priority}
              </span>
              {task.dueDate && (
                <span
                  className={`text-[11px] ${
                    overdue ? 'text-red-500 font-medium' : 'text-gray-400'
                  }`}
                >
                  {overdue && '⚠ '}
                  {task.dueDate}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FILTER BAR
// ─────────────────────────────────────────────────────────────────────────────

function FilterBar({
  activeTagFilters,
  setActiveTagFilters,
  statusFilter,
  setStatusFilter,
}) {
  const hasFilters = activeTagFilters.length > 0 || statusFilter !== 'all';

  return (
    <div className="bg-white border border-gray-100 rounded-xl px-3 py-2.5 mb-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
          Filter
        </span>

        {/* Tag filters */}
        {TAGS.map((tag) => {
          const active = activeTagFilters.includes(tag);
          return (
            <button
              key={tag}
              onClick={() =>
                setActiveTagFilters((f) =>
                  active ? f.filter((t) => t !== tag) : [...f, tag],
                )
              }
              className={`text-xs px-2.5 py-1 rounded-full font-medium border transition-all ${
                active
                  ? `${TAG_STYLES[tag]} ring-2 ring-offset-1 ${TAG_ACTIVE_RING[tag]}`
                  : 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100 hover:text-gray-600'
              }`}
            >
              {tag}
            </button>
          );
        })}

        {/* Divider */}
        <span className="text-gray-200">|</span>

        {/* Status filters */}
        {[
          { key: 'all', label: 'All' },
          { key: 'active', label: 'Active' },
          { key: 'done', label: 'Done' },
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setStatusFilter(key)}
            className={`text-xs px-2.5 py-1 rounded-full font-medium border transition-all ${
              statusFilter === key
                ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                : 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100 hover:text-gray-600'
            }`}
          >
            {label}
          </button>
        ))}

        {/* Clear */}
        {hasFilters && (
          <button
            onClick={() => {
              setActiveTagFilters([]);
              setStatusFilter('all');
            }}
            className="text-xs text-indigo-500 hover:text-indigo-700 font-medium ml-1 transition-colors"
          >
            Clear all
          </button>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CHAT PANEL
// ─────────────────────────────────────────────────────────────────────────────

function ChatPanel({ tasks, apiKeys }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [backend, setBackend] = useState('claude');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Auto-grow textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, [input]);

  const currentKey = backend === 'claude' ? apiKeys.claude : apiKeys.openai;
  const hasKey = Boolean(currentKey);

  function buildSystemPrompt() {
    const taskSummary = tasks.map((t) => ({
      title: t.title,
      priority: t.priority,
      tags: t.tags,
      completed: t.completed,
      dueDate: t.dueDate || null,
    }));
    return (
      `You are a business productivity assistant managing multiple ventures. ` +
      `Businesses: Careific (care management SaaS), Rose (care home facility), ` +
      `Buyflip (separate venture), Care Home (operations), Personal. ` +
      `Current tasks with tags: ${JSON.stringify(taskSummary)}. ` +
      `Help the user prioritize, plan, and delegate across their businesses.`
    );
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || loading) return;

    if (!hasKey) {
      setMessages((m) => [
        ...m,
        { role: 'user', content: text },
        {
          role: 'assistant',
          content: `⚠️ No ${backend === 'claude' ? 'Claude' : 'OpenAI'} API key set. Open Settings (gear icon) to add one.`,
        },
      ]);
      setInput('');
      return;
    }

    const userMsg = { role: 'user', content: text };
    const history = [...messages, userMsg];
    setMessages(history);
    setInput('');
    setLoading(true);
    setError('');

    try {
      let reply;
      if (backend === 'claude') {
        reply = await callClaudeChat(history, buildSystemPrompt(), currentKey);
      } else {
        reply = await callOpenAIChat(history, buildSystemPrompt(), currentKey);
      }
      setMessages((m) => [...m, { role: 'assistant', content: reply }]);
    } catch (err) {
      setError(err.message || 'Request failed');
      setMessages((m) => [
        ...m,
        { role: 'assistant', content: `❌ Error: ${err.message || 'Request failed'}` },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="flex flex-col h-full bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="bg-white border-b border-gray-100 px-4 py-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-indigo-100 rounded-lg flex items-center justify-center">
            <ChatIcon className="w-4 h-4 text-indigo-600" />
          </div>
          <span className="text-sm font-semibold text-gray-900">AI Assistant</span>
        </div>

        {/* Backend Toggle */}
        <div className="flex bg-gray-100 rounded-lg p-0.5 gap-0.5">
          {[
            { key: 'claude', label: 'Claude' },
            { key: 'chatgpt', label: 'ChatGPT' },
          ].map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setBackend(key)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                backend === key
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* No-key warning */}
      {!hasKey && (
        <div className="bg-amber-50 border-b border-amber-100 px-4 py-2 text-xs text-amber-700 flex items-center gap-1.5 flex-shrink-0">
          <span>⚠️</span>
          <span>
            No {backend === 'claude' ? 'Claude' : 'OpenAI'} API key — add one in
            Settings to enable chat.
          </span>
        </div>
      )}

      {/* Context note */}
      <div className="bg-indigo-50 border-b border-indigo-100 px-4 py-2 text-xs text-indigo-600 flex items-center gap-1.5 flex-shrink-0">
        <span>📋</span>
        <span>
          {tasks.length} task{tasks.length !== 1 ? 's' : ''} injected as context
        </span>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 bg-gray-50/50">
        {messages.length === 0 && (
          <div className="text-center py-10 text-gray-400">
            <div className="text-4xl mb-3">🤖</div>
            <p className="text-sm font-medium text-gray-500">Ask your AI assistant</p>
            <p className="text-xs text-gray-400 mt-1">
              &ldquo;What should I focus on today?&rdquo;
            </p>
            <p className="text-xs text-gray-400">
              &ldquo;Which Careific tasks are overdue?&rdquo;
            </p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            {msg.role === 'assistant' && (
              <div className="w-6 h-6 rounded-full bg-indigo-100 flex items-center justify-center mr-2 mt-0.5 flex-shrink-0 text-xs">
                🤖
              </div>
            )}
            <div
              className={`max-w-[82%] rounded-xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words ${
                msg.role === 'user'
                  ? 'bg-indigo-600 text-white rounded-br-sm'
                  : 'bg-white text-gray-800 border border-gray-200 shadow-sm rounded-bl-sm'
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-indigo-100 flex items-center justify-center text-xs">
              🤖
            </div>
            <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 shadow-sm">
              <div className="flex gap-1 items-center">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce"
                    style={{ animationDelay: `${i * 0.18}s` }}
                  />
                ))}
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="bg-white border-t border-gray-200 p-3 flex gap-2 items-end flex-shrink-0">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={`Message ${backend === 'claude' ? 'Claude' : 'ChatGPT'}… (Enter to send)`}
          rows={1}
          className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition resize-none"
          style={{ overflowY: 'hidden' }}
        />
        <button
          onClick={handleSend}
          disabled={loading || !input.trim()}
          className="flex-shrink-0 w-9 h-9 flex items-center justify-center bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-sm"
          title="Send (Enter)"
        >
          <SendIcon className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SVG ICON HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function GearIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
      />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

function XIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

function SendIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
    </svg>
  );
}

function ChatIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
      />
    </svg>
  );
}

function SpinnerIcon({ className }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

function ChecklistIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
      />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_TASKS = [
  {
    id: uid(),
    title: 'Review Q1 care management SaaS roadmap',
    description: 'Check sprint backlog and confirm priorities with engineering team',
    priority: 'high',
    dueDate: '2026-03-05',
    tags: ['Careific'],
    completed: false,
    createdAt: new Date().toISOString(),
  },
  {
    id: uid(),
    title: 'Order supplies for Rose facility',
    description: 'Medical consumables and kitchen supplies for March',
    priority: 'medium',
    dueDate: '2026-03-04',
    tags: ['Rose', 'Care Home'],
    completed: false,
    createdAt: new Date().toISOString(),
  },
  {
    id: uid(),
    title: 'Buyflip investor deck update',
    description: 'Update slides with latest revenue figures',
    priority: 'high',
    dueDate: '2026-03-07',
    tags: ['Buyflip'],
    completed: false,
    createdAt: new Date().toISOString(),
  },
  {
    id: uid(),
    title: 'Gym session',
    description: '',
    priority: 'low',
    dueDate: '',
    tags: ['Personal'],
    completed: true,
    createdAt: new Date().toISOString(),
  },
];

export default function App() {
  const [tasks, setTasks] = useState(SAMPLE_TASKS);
  const [activeView, setActiveView] = useState('daily');
  const [activeTagFilters, setActiveTagFilters] = useState([]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [showSettings, setShowSettings] = useState(false);
  const [apiKeys, setApiKeys] = useState({ claude: '', openai: '' });

  function addTask(task) {
    setTasks((prev) => [task, ...prev]);
  }

  function toggleTask(id) {
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, completed: !t.completed } : t)),
    );
  }

  function deleteTask(id) {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }

  const filteredTasks = useMemo(() => {
    return tasks.filter((task) => {
      if (activeView === 'priority' && task.priority !== 'high') return false;
      if (
        activeTagFilters.length > 0 &&
        !activeTagFilters.some((t) => task.tags.includes(t))
      )
        return false;
      if (statusFilter === 'active' && task.completed) return false;
      if (statusFilter === 'done' && !task.completed) return false;
      return true;
    });
  }, [tasks, activeView, activeTagFilters, statusFilter]);

  const completedCount = filteredTasks.filter((t) => t.completed).length;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* ── Header ── */}
      <header className="bg-white border-b border-gray-200 px-6 py-3.5 flex items-center justify-between sticky top-0 z-30">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-indigo-600 rounded-xl flex items-center justify-center shadow-sm">
            <ChecklistIcon className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-base font-bold text-gray-900 leading-none">TaskManage</h1>
            <p className="text-[11px] text-gray-400 mt-0.5">Multi-venture productivity</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Summary pill */}
          <span className="hidden sm:inline-flex text-xs bg-gray-100 text-gray-500 px-3 py-1.5 rounded-full font-medium">
            {tasks.filter((t) => !t.completed).length} active ·{' '}
            {tasks.filter((t) => t.completed).length} done
          </span>

          <button
            onClick={() => setShowSettings(true)}
            className="p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            title="Settings"
          >
            <GearIcon className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* ── Main layout ── */}
      <main className="flex" style={{ height: 'calc(100vh - 57px)' }}>
        {/* ── Left: Task panel (60%) ── */}
        <section className="flex flex-col border-r border-gray-200 overflow-hidden" style={{ width: '60%' }}>
          {/* View Tabs */}
          <div className="bg-white border-b border-gray-100 px-6 pt-4 pb-0 flex-shrink-0">
            <div className="flex gap-1 w-fit">
              {[
                { key: 'daily', label: 'Daily Tasks' },
                { key: 'priority', label: 'High Priority' },
              ].map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => setActiveView(key)}
                  className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-all -mb-px ${
                    activeView === key
                      ? 'border-indigo-600 text-indigo-700'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-200'
                  }`}
                >
                  {label}
                  {key === 'priority' && (
                    <span className="ml-1.5 text-[10px] bg-red-100 text-red-500 font-semibold px-1.5 py-0.5 rounded-full">
                      {tasks.filter((t) => t.priority === 'high' && !t.completed).length}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <AddTaskForm onAdd={addTask} claudeKey={apiKeys.claude} />
            <FilterBar
              activeTagFilters={activeTagFilters}
              setActiveTagFilters={setActiveTagFilters}
              statusFilter={statusFilter}
              setStatusFilter={setStatusFilter}
            />

            {/* Task count */}
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs text-gray-400">
                {filteredTasks.length} task{filteredTasks.length !== 1 ? 's' : ''}
                {activeView === 'priority' ? ' (high priority)' : ''}
              </span>
              {completedCount > 0 && (
                <span className="text-xs text-gray-400">
                  {completedCount} completed
                </span>
              )}
            </div>

            {/* Task list */}
            <div className="space-y-2.5">
              {filteredTasks.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-gray-400">
                  <div className="text-5xl mb-3">✓</div>
                  <p className="text-sm font-medium text-gray-500">
                    {activeView === 'priority' ? 'No high-priority tasks' : 'No tasks here'}
                  </p>
                  <p className="text-xs text-gray-400 mt-1">
                    {activeTagFilters.length > 0 || statusFilter !== 'all'
                      ? 'Try clearing filters'
                      : 'Click "Add new task" above'}
                  </p>
                </div>
              ) : (
                filteredTasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    onToggle={toggleTask}
                    onDelete={deleteTask}
                  />
                ))
              )}
            </div>
          </div>
        </section>

        {/* ── Right: Chat panel (40%) ── */}
        <section className="flex flex-col overflow-hidden p-4" style={{ width: '40%' }}>
          <ChatPanel tasks={tasks} apiKeys={apiKeys} />
        </section>
      </main>

      {/* ── Settings Modal ── */}
      {showSettings && (
        <SettingsModal
          apiKeys={apiKeys}
          onSave={setApiKeys}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
