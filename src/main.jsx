import React from 'react';
import ReactDOM from 'react-dom/client';
import { ToastProvider } from './contexts/ToastContext';
import { PersonaProvider } from './contexts/PersonaContext';
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx';
import './index.css';

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
