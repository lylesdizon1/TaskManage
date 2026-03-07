const BASE = import.meta.env.VITE_API_URL || '';

function getToken() {
  return localStorage.getItem('token');
}

async function request(path, options = {}) {
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options.headers,
  };

  const res = await fetch(`${BASE}${path}`, { ...options, headers });

  if (res.status === 401) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.dispatchEvent(new Event('auth:logout'));
    throw new Error('Session expired. Please log in again.');
  }

  if (!res.ok) {
    let errMsg = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      errMsg = data.message || data.error || errMsg;
    } catch (_) {}
    throw new Error(errMsg);
  }

  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  get:    (path, opts)       => request(path, { ...opts, method: 'GET' }),
  post:   (path, body, opts) => request(path, { ...opts, method: 'POST',   body: JSON.stringify(body) }),
  put:    (path, body, opts) => request(path, { ...opts, method: 'PUT',    body: JSON.stringify(body) }),
  patch:  (path, body, opts) => request(path, { ...opts, method: 'PATCH',  body: JSON.stringify(body) }),
  delete: (path, opts)       => request(path, { ...opts, method: 'DELETE' }),
};
