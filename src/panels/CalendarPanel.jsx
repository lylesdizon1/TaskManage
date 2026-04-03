import { useState, useEffect } from 'react';
import { SpinnerIcon, CalendarIcon } from '../components/icons/Icons.jsx';

const API_BASE = '';

export default function CalendarPanel({ currentUser, addToast, apiFetch }) {
  const [gcalStatus, setGcalStatus] = useState({ connected: false, email: null });
  const [loading, setLoading]       = useState(true);

  // Check connection status on mount and after OAuth redirect
  useEffect(() => {
    checkStatus();
    // Handle ?gcal=connected redirect from OAuth callback
    const params = new URLSearchParams(window.location.search);
    if (params.get('gcal') === 'connected') {
      window.history.replaceState({}, '', window.location.pathname);
      checkStatus();
      addToast({ type: 'success', message: 'Google Calendar connected!' });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function checkStatus() {
    setLoading(true);
    try {
      const res = await apiFetch(`${API_BASE}/api/gcal/status?userId=${currentUser.id}`);
      const data = await res.json();
      setGcalStatus(data);
    } catch {
      setGcalStatus({ connected: false });
    } finally {
      setLoading(false);
    }
  }

  async function handleConnect() {
    try {
      const res = await apiFetch(`${API_BASE}/api/gcal/auth-url?userId=${currentUser.id}`);
      const data = await res.json();
      if (data.error) {
        addToast({ type: 'error', message: data.error });
        return;
      }
      window.location.href = data.url;
    } catch (err) {
      addToast({ type: 'error', message: 'Failed to start Google sign-in' });
    }
  }

  async function handleDisconnect() {
    try {
      await apiFetch(`${API_BASE}/api/gcal/disconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUser.id }),
      });
      setGcalStatus({ connected: false, email: null });
      addToast({ type: 'success', message: 'Google Calendar disconnected' });
    } catch {
      addToast({ type: 'error', message: 'Failed to disconnect' });
    }
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400">
        <SpinnerIcon className="w-6 h-6 animate-spin" />
      </div>
    );
  }

  if (!gcalStatus.connected) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
        <div className="w-16 h-16 bg-indigo-100 rounded-2xl flex items-center justify-center mb-4">
          <CalendarIcon className="w-8 h-8 text-indigo-600" />
        </div>
        <h3 className="text-lg font-bold text-gray-900 mb-2">Connect Google Calendar</h3>
        <p className="text-sm text-gray-500 mb-6 max-w-xs">
          Sign in with Google to view your calendar and sync tasks with due dates as calendar events.
        </p>
        <button
          onClick={handleConnect}
          className="flex items-center gap-3 px-5 py-3 bg-white border border-gray-300 rounded-xl shadow-sm hover:bg-gray-50 transition-colors text-sm font-medium text-gray-700"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
          </svg>
          Sign in with Google
        </button>
      </div>
    );
  }

  // Connected — show embedded calendar
  const calendarSrc = `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(gcalStatus.email)}&ctz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Connection status bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-green-50 border-b border-green-100 flex-shrink-0">
        <div className="flex items-center gap-2 text-xs text-green-700">
          <span className="w-2 h-2 bg-green-500 rounded-full" />
          Connected as {gcalStatus.email}
        </div>
        <button
          onClick={handleDisconnect}
          className="text-xs text-gray-400 hover:text-red-500 transition-colors font-medium"
        >
          Disconnect
        </button>
      </div>
      {/* Calendar iframe (desktop) / Open button (mobile) */}
      <iframe
        src={calendarSrc}
        className="flex-1 w-full border-0 hidden md:block"
        title="Google Calendar"
      />
      <div className="flex-1 flex flex-col items-center justify-center px-6 md:hidden">
        <div className="w-16 h-16 bg-indigo-100 rounded-2xl flex items-center justify-center mb-4">
          <CalendarIcon className="w-8 h-8 text-indigo-600" />
        </div>
        <h3 className="text-lg font-bold text-gray-900 mb-2">Your Calendar</h3>
        <p className="text-sm text-gray-500 mb-6 max-w-xs text-center">
          View and manage your Google Calendar events in a new tab.
        </p>
        <a
          href={`https://calendar.google.com/calendar/r?authuser=${encodeURIComponent(gcalStatus.email)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 px-6 py-3 bg-indigo-600 text-white rounded-xl shadow-sm hover:bg-indigo-700 transition-colors text-sm font-medium min-h-[48px]"
        >
          <CalendarIcon className="w-5 h-5" />
          Open Google Calendar
        </a>
      </div>
    </div>
  );
}
