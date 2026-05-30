import { XIcon } from '../icons/Icons.jsx';

export default function ToastContainer({ toasts, onDismiss }) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-20 md:bottom-5 right-3 md:right-5 left-3 md:left-auto z-50 flex flex-col gap-2 max-w-sm md:max-w-sm">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`flex items-start gap-3 px-4 py-3 rounded-xl shadow-lg border text-sm font-medium ${
            t.type === 'success'
              ? 'bg-surface-container-lowest border-success text-success'
              : 'bg-surface-container-lowest border-danger text-danger'
          }`}
        >
          <span className="flex-shrink-0 mt-0.5">{t.type === 'success' ? '✉️' : '❌'}</span>
          <span className="flex-1 leading-snug">{t.message}</span>
          <button
            onClick={() => onDismiss(t.id)}
            className="flex-shrink-0 text-text-faint hover:text-on-surface-variant transition-colors"
          >
            <XIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
