import { createContext, useContext, useState, useCallback, useRef } from 'react';

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const counterRef = useRef(0);

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const addToast = useCallback((message, type = 'info', duration = 4000) => {
    const id = ++counterRef.current;
    setToasts(prev => [...prev, { id, message, type, duration }]);
    if (duration > 0) {
      setTimeout(() => removeToast(id), duration);
    }
    return id;
  }, [removeToast]);

  const toast = {
    success: (msg, duration) => addToast(msg, 'success', duration),
    error:   (msg, duration) => addToast(msg, 'error', duration ?? 6000),
    warn:    (msg, duration) => addToast(msg, 'warn', duration),
    info:    (msg, duration) => addToast(msg, 'info', duration),
  };

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

const STYLES = {
  success: { bg: 'rgb(var(--success))', icon: '✓' },
  error:   { bg: 'rgb(var(--danger))', icon: '✕' },
  warn:    { bg: 'rgb(var(--warning))', icon: '⚠' },
  info:    { bg: 'rgb(var(--accent))', icon: 'ℹ' },
};

function ToastContainer({ toasts, onRemove }) {
  if (!toasts.length) return null;
  return (
    <div style={{
      position: 'fixed', bottom: '1.5rem', right: '1.5rem',
      zIndex: 9999, display: 'flex', flexDirection: 'column', gap: '0.5rem',
      maxWidth: '360px', width: '100%',
    }}>
      {toasts.map(t => (
        <ToastItem key={t.id} toast={t} onRemove={onRemove} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onRemove }) {
  const { bg, icon } = STYLES[toast.type] || STYLES.info;
  const labelStyle = { flex: 1, fontSize: '0.875rem', lineHeight: '1.4' };
  const btnStyle = {
    background: 'none', border: 'none', color: 'rgb(var(--accent-contrast) / 0.8)',
    cursor: 'pointer', fontSize: '1rem', padding: 0, flexShrink: 0,
  };
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: '0.75rem',
      background: bg, color: 'rgb(var(--accent-contrast))', borderRadius: '0.5rem',
      padding: '0.75rem 1rem', boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
      animation: 'slideIn 0.2s ease',
    }}>
      <span style={{ fontSize: '1rem', marginTop: '1px', flexShrink: 0 }}>{icon}</span>
      <span style={labelStyle}>{toast.message}</span>
      <button onClick={() => onRemove(toast.id)} style={btnStyle}>x</button>
    </div>
  );
}
