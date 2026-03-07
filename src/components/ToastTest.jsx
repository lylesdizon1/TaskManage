import { useToast } from '../contexts/ToastContext';

export default function ToastTest() {
  const toast = useToast();
  return (
    <div style={{ display: 'flex', gap: '0.5rem', padding: '1rem' }}>
      <button onClick={() => toast.success('Saved!')}>✓ Success</button>
      <button onClick={() => toast.error('Something broke')}>✕ Error</button>
      <button onClick={() => toast.warn('Watch out')}>⚠ Warn</button>
      <button onClick={() => toast.info('FYI...')}>ℹ Info</button>
    </div>
  );
}
