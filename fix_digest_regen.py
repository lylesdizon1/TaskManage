content = open('src/App.jsx').read()

old = """  // Digest: load from localStorage cache or fetch
  useEffect(() => {
    const cacheKey = `digest_${today}`;
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      try {
        setDigest(JSON.parse(cached));
        setDigestLoading(false);
        return;
      } catch { /* invalid cache, refetch */ }
    }

    const existingDigest = notes.find((n) => n.type === 'digest' && n.createdAt && n.createdAt.slice(0, 10) === today);
    if (existingDigest) {
      setDigest(existingDigest);
      localStorage.setItem(cacheKey, JSON.stringify(existingDigest));
      setDigestLoading(false);
      return;
    }

    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` };
    apiFetch('/api/notes/daily-digest', {
      method: 'POST', headers,
      body: JSON.stringify({ apiKey: apiKeys?.claude || '' }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data && data.content) {
          setDigest(data);
          localStorage.setItem(cacheKey, JSON.stringify(data));
        }
      })
      .catch(() => {})
      .finally(() => setDigestLoading(false));
  }, [today]); // eslint-disable-line react-hooks/exhaustive-deps"""

new = """  const fetchDigest = (force = false) => {
    const cacheKey = `digest_${today}`;
    if (!force) {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        try {
          setDigest(JSON.parse(cached));
          setDigestLoading(false);
          return;
        } catch { /* invalid cache, refetch */ }
      }
      const existingDigest = notes.find((n) => n.type === 'digest' && n.createdAt && n.createdAt.slice(0, 10) === today);
      if (existingDigest) {
        setDigest(existingDigest);
        localStorage.setItem(cacheKey, JSON.stringify(existingDigest));
        setDigestLoading(false);
        return;
      }
    } else {
      localStorage.removeItem(cacheKey);
      setDigest(null);
      setDigestLoading(true);
    }
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` };
    apiFetch('/api/notes/daily-digest', {
      method: 'POST', headers,
      body: JSON.stringify({ apiKey: apiKeys?.claude || '', force }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data && data.content) {
          setDigest(data);
          localStorage.setItem(cacheKey, JSON.stringify(data));
        }
      })
      .catch(() => {})
      .finally(() => setDigestLoading(false));
  };

  // Digest: load from localStorage cache or fetch
  useEffect(() => {
    fetchDigest(false);
  }, [today]); // eslint-disable-line react-hooks/exhaustive-deps"""

# Also wire up the regenerate button
old2 = """                onClick={() => onRegenerateDigest && onRegenerateDigest()}"""
new2 = """                onClick={() => fetchDigest(true)}"""

assert old in content, "Block 1 not found!"
content = content.replace(old, new, 1)
assert old2 in content, "Block 2 not found!"
content = content.replace(old2, new2, 1)
open('src/App.jsx', 'w').write(content)
print("Done!")
