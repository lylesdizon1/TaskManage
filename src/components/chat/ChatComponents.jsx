import { useState, useRef, useEffect, useMemo } from 'react';
import { SendIcon } from '../icons/Icons.jsx';

// ─────────────────────────────────────────────────────────────────────────────
// Chat Message Thread (reusable for sliding panel and Chat tab)
// ─────────────────────────────────────────────────────────────────────────────

export function ChatMessageThread({ messages, loading }) {
  const messagesEndRef = useRef(null);
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, loading]);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 bg-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
      {messages.length === 0 && (
        <div className="text-center py-10 text-on-surface-variant">
          <span className="material-symbols-outlined text-4xl mb-3 block" style={{ color: '#4f4dcf', opacity: 0.3 }}>auto_awesome</span>
          <p className="text-sm font-medium text-on-surface-variant" style={{ fontFamily: 'Plus Jakarta Sans, sans-serif' }}>Ask your AI assistant</p>
          <p className="text-xs text-on-surface-variant mt-1">&ldquo;What should I focus on today?&rdquo;</p>
          <p className="text-xs text-on-surface-variant">&ldquo;Which Careific tasks are overdue?&rdquo;</p>
        </div>
      )}
      {messages.map((msg, i) => (
        <div key={i} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
          {msg.role === 'assistant' && msg.persona && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-primary/10 text-primary mb-1 ml-9">
              {msg.persona.emoji} {msg.persona.name}
            </span>
          )}
          {msg.role === 'assistant' && (
            <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center mr-2 mt-0.5 flex-shrink-0"><span className="material-symbols-outlined" style={{fontSize:'14px',color:'#4f4dcf'}}>auto_awesome</span></div>
          )}
          <div className={`max-w-[82%] rounded-xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words ${
            msg.role === 'user' ? 'text-white rounded-br-sm' : 'bg-surface-container-lowest text-on-surface border border-surface-container-low shadow-sm rounded-bl-sm'
          }`} style={msg.role === 'user' ? { backgroundColor: '#4f4dcf' } : undefined}>{msg.content}</div>
        </div>
      ))}
      {loading && (
        <div className="flex justify-start items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center"><span className="material-symbols-outlined" style={{fontSize:'14px',color:'#4f4dcf'}}>auto_awesome</span></div>
          <div className="bg-surface-container-lowest border border-surface-container-low rounded-xl px-4 py-3 shadow-sm">
            <div className="flex gap-1 items-center">
              {[0, 1, 2].map((j) => (
                <div key={j} className="w-1.5 h-1.5 bg-primary/60 rounded-full animate-bounce" style={{ animationDelay: `${j * 0.18}s` }} />
              ))}
            </div>
          </div>
        </div>
      )}
      <div ref={messagesEndRef} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sliding Chat Panel (no input — universal prompt bar handles input)
// ─────────────────────────────────────────────────────────────────────────────

export function SlidingChatPanel({ messages, loading, backend, contextBadge, onHide, activePersona }) {
  return (
    <div className="flex flex-col h-full bg-surface border-l border-surface-container-low overflow-hidden">
      {/* Header */}
      <div className="bg-surface-container-lowest border-b border-surface-container-low px-4 py-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-lg" style={{ color: '#4f4dcf' }}>chat</span>
          <span className="text-sm font-semibold text-on-surface" style={{ fontFamily: 'Plus Jakarta Sans, sans-serif' }}>Chat</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${backend === 'claude' ? 'bg-primary/10 text-primary' : 'bg-green-100 text-green-700'}`}>
            {backend === 'claude' ? 'Claude' : 'ChatGPT'}
          </span>
          {activePersona && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-primary/10 text-primary">
              {activePersona.emoji} {activePersona.name}
            </span>
          )}
        </div>
        <button onClick={onHide} className="text-xs text-on-surface-variant hover:text-on-surface font-medium px-2 py-1 flex items-center gap-1 transition-colors">
          <span>&rarr;</span> Hide
        </button>
      </div>
      {/* Context badge */}
      {contextBadge && (
        <div className="bg-primary/5 border-b border-primary/10 px-4 py-1.5 text-[11px] text-primary flex items-center gap-1.5 flex-shrink-0" style={{ fontFamily: 'Manrope, sans-serif' }}>
          <span className="material-symbols-outlined" style={{fontSize:'14px'}}>description</span><span>{contextBadge}</span>
        </div>
      )}
      {/* Messages */}
      <ChatMessageThread messages={messages} loading={loading} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat Tab Panel (conversation list + message view)
// ─────────────────────────────────────────────────────────────────────────────

function chatDateGroup(dateStr) {
  if (!dateStr) return 'Earlier';
  const d = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  if (d >= today) return 'Today';
  if (d >= yesterday) return 'Yesterday';
  return 'Earlier';
}

export function ChatTabPanel({ conversations, activeConvId, activeMessages, loading, backend, onSelectConv, onNewChat, onDeleteConv, onRenameConv }) {
  const [editingTitle, setEditingTitle] = useState(null);
  const [showMobileChat, setShowMobileChat] = useState(false);

  // Group conversations by date
  const grouped = useMemo(() => {
    const groups = { Today: [], Yesterday: [], Earlier: [] };
    conversations.forEach((c) => {
      const group = chatDateGroup(c.updatedAt || c.createdAt);
      groups[group].push(c);
    });
    return groups;
  }, [conversations]);

  // When a conversation is selected, show chat panel on mobile
  const handleSelectConv = (id) => {
    onSelectConv(id);
    setShowMobileChat(true);
  };

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Left sidebar — hidden on mobile when viewing a chat */}
      <div className={`${showMobileChat ? 'hidden' : 'flex'} flex-col w-full md:flex md:w-64 md:flex-shrink-0 border-r border-outline-variant/20 bg-surface-container-low overflow-hidden`}>
        <div className="px-4 pt-4 pb-3 flex-shrink-0">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-bold font-headline text-on-background">Conversations</span>
          </div>
          <button onClick={onNewChat} className="w-full px-3 py-2.5 text-[11px] font-bold text-on-primary bg-primary rounded-xl transition-colors hover:opacity-90 shadow-sm shadow-primary/20 flex items-center justify-center gap-1.5">
            <span className="material-symbols-outlined text-sm">add</span>
            New Chat
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-3">
          {conversations.length === 0 && (
            <p className="text-[11px] text-on-surface-variant px-2 py-4 text-center">No conversations yet</p>
          )}
          {['Today', 'Yesterday', 'Earlier'].map((group) => {
            const items = grouped[group];
            if (items.length === 0) return null;
            return (
              <div key={group} className="mb-2">
                <p className="text-[10px] font-bold text-on-surface-variant/50 uppercase tracking-widest px-2 py-1">{group}</p>
                {items.map((conv) => (
                  <div
                    key={conv.id}
                    onClick={() => handleSelectConv(conv.id)}
                    className={`group flex items-center justify-between px-2.5 py-2 rounded-xl cursor-pointer transition-colors ${
                      activeConvId === conv.id ? 'bg-primary/10 text-primary' : 'hover:bg-surface-container-high text-on-background'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-bold truncate">{conv.title || 'New conversation'}</p>
                      <div className="flex items-center gap-1 mt-0.5">
                        <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold ${conv.model === 'chatgpt' ? 'bg-green-50 text-green-600' : 'bg-primary/10 text-primary'}`}>
                          {conv.model === 'chatgpt' ? 'GPT' : 'Claude'}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); onDeleteConv(conv.id); }}
                      className="opacity-0 group-hover:opacity-100 text-on-surface-variant hover:text-error text-xs px-1 transition-opacity"
                    >
                      <span className="material-symbols-outlined text-sm">delete</span>
                    </button>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      {/* Right panel — hidden on mobile until a conversation is selected */}
      <div className={`${showMobileChat ? 'flex' : 'hidden'} flex-col flex-1 md:flex overflow-hidden bg-surface`}>
        {!activeConvId ? (
          <div className="flex-1 flex flex-col items-center justify-center text-on-surface-variant">
            <span className="material-symbols-outlined text-4xl text-primary/30 mb-3">chat</span>
            <p className="text-sm font-bold font-headline text-on-surface-variant/70">Select a conversation or start a new one</p>
            <button onClick={onNewChat} className="mt-4 px-4 py-2.5 text-[11px] font-bold text-on-primary bg-primary rounded-xl transition-colors hover:opacity-90 shadow-sm shadow-primary/20 flex items-center gap-1.5">
              <span className="material-symbols-outlined text-sm">add</span>
              New Chat
            </button>
          </div>
        ) : (
          <>
            {/* Conversation header */}
            <div className="bg-surface-container-lowest border-b border-outline-variant/20 px-5 py-3 flex items-center justify-between flex-shrink-0">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                {/* Mobile back button */}
                <button
                  className="md:hidden flex items-center gap-1 text-primary font-bold text-sm mr-2 flex-shrink-0"
                  onClick={() => setShowMobileChat(false)}
                >
                  <span className="material-symbols-outlined text-lg">arrow_back</span>
                </button>
                {editingTitle === activeConvId ? (
                  <input
                    autoFocus
                    defaultValue={conversations.find((c) => c.id === activeConvId)?.title || ''}
                    onBlur={(e) => { onRenameConv(activeConvId, e.target.value); setEditingTitle(null); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { onRenameConv(activeConvId, e.target.value); setEditingTitle(null); } }}
                    className="text-sm font-bold font-headline text-on-background bg-surface-container-low border border-outline-variant/30 rounded-xl px-3 py-1.5 flex-1 focus:outline-none focus:ring-1 focus:ring-primary/20"
                  />
                ) : (
                  <h3 onClick={() => setEditingTitle(activeConvId)} className="text-sm font-bold font-headline text-on-background truncate cursor-pointer hover:text-primary transition-colors">
                    {conversations.find((c) => c.id === activeConvId)?.title || 'New conversation'}
                  </h3>
                )}
                <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold flex-shrink-0 ${backend === 'claude' ? 'bg-primary/10 text-primary' : 'bg-green-50 text-green-600'}`}>
                  {backend === 'claude' ? 'Claude' : 'ChatGPT'}
                </span>
              </div>
              <button onClick={() => onDeleteConv(activeConvId)} className="text-on-surface-variant hover:text-error transition-colors p-1.5 rounded-lg hover:bg-error/5">
                <span className="material-symbols-outlined text-lg">delete</span>
              </button>
            </div>
            {/* Messages */}
            <ChatMessageThread messages={activeMessages} loading={loading} />
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Universal Prompt Bar
// ─────────────────────────────────────────────────────────────────────────────

export function UniversalPromptBar({ input, onInputChange, backend, onBackendChange, onSend, loading, activeTab, personaPill }) {
  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
  }

  const placeholders = {
    dashboard: 'What do you want to focus on today?',
    daily: 'Ask about your tasks...',
    calendar: 'Ask about your schedule...',
    financials: 'Ask about your finances...',
    notes: 'Ask about your notes...',
    chat: 'Ask anything...',
  };
  const placeholder = placeholders[activeTab] || 'Ask anything...';

  return (
    <div className="z-40 bg-surface border-b border-surface-container-low flex-shrink-0">
      <div className="flex items-center justify-center" style={{ height: 72, padding: '12px 24px' }}>
        <div className="flex items-center gap-2 w-full" style={{ maxWidth: 860, height: 52, borderRadius: 26, border: '1px solid var(--color-surface-container-low, #f1f0f5)', backgroundColor: 'var(--color-surface-container-lowest, #ffffff)', padding: '0 20px' }}>
          {personaPill && (
            <span className="flex-shrink-0 flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-primary/10 text-primary select-none">
              {personaPill.emoji} {personaPill.name}
            </span>
          )}
          <input
            type="text"
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="flex-1 min-w-0 bg-transparent text-on-surface placeholder-on-surface-variant border-0 outline-none focus:ring-0"
            style={{ fontSize: 16, fontFamily: 'Manrope, sans-serif' }}
          />
          <select
            value={backend}
            onChange={(e) => onBackendChange(e.target.value)}
            className="flex-shrink-0 px-2 py-1 font-semibold bg-transparent border-0 text-on-surface-variant focus:ring-0 cursor-pointer"
            style={{ fontSize: 15, fontFamily: 'Manrope, sans-serif' }}
          >
            <option value="claude">Claude</option>
            <option value="chatgpt">ChatGPT</option>
          </select>
          <button
            onClick={onSend}
            disabled={loading || !input.trim()}
            className="flex-shrink-0 flex items-center justify-center text-white rounded-full disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            style={{ backgroundColor: '#4f4dcf', width: 40, height: 40 }}
          >
            {loading ? (
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <SendIcon className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
