import React from 'react';
import ReactDOM from 'react-dom/client';
import { ToastProvider } from './contexts/ToastContext';
import { PersonaProvider } from './contexts/PersonaContext';
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx';
import './index.css';

// Vite emits `vite:preloadError` when a dynamically-imported chunk fails
// to load — usually because a deploy rotated the asset hashes mid-session
// and the user's tab still holds the old hash. Catching it here, BEFORE
// React renders the ErrorBoundary fallback, prevents the brief
// "Something went wrong" flash users were seeing on menu navigation.
//
// One-shot guard via sessionStorage so a genuinely broken chunk doesn't
// reload-loop forever — second failure falls through to the ErrorBoundary.
window.addEventListener('vite:preloadError', (event) => {
  if (sessionStorage.getItem('chunk_reload_attempted')) return; // let ErrorBoundary handle
  sessionStorage.setItem('chunk_reload_attempted', '1');
  event.preventDefault();
  window.location.reload();
});

// Clear the reload sentinel once we've been alive 5s without erroring —
// means the reload worked and future chunk-load failures (next deploy)
// should be allowed to retry instead of falling through to ErrorBoundary.
setTimeout(() => {
  try { sessionStorage.removeItem('chunk_reload_attempted'); } catch {}
}, 5000);

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <PersonaProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </PersonaProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
