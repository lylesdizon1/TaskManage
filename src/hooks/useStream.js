import { useState, useCallback, useRef } from 'react';

export default function useStream() {
  const [streaming, setStreaming] = useState(false);
  const [streamedText, setStreamedText] = useState('');
  const abortRef = useRef(null);

  const resetStream = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setStreaming(false);
    setStreamedText('');
  }, []);

  const streamChat = useCallback(async (messages, persona, contextSlices, onToolExecuted) => {
    resetStream();

    // App.jsx writes the JWT under 'tm_token' (see refreshToken/handleLogin).
    // Prior code read 'token' which never matched — this hook silently threw
    // 'Not authenticated' on every call. Latent: no current callers, but
    // future ones would have hit the bug.
    const token = localStorage.getItem('tm_token');
    if (!token) throw new Error('Not authenticated');

    const controller = new AbortController();
    abortRef.current = controller;

    setStreaming(true);
    setStreamedText('');

    const systemParts = [persona, contextSlices].filter(Boolean).flat();
    const systemPrompt = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;

    const body = {
      model: 'claude-sonnet-4-20250514',
      messages,
    };
    if (systemPrompt) body.systemPrompt = systemPrompt;

    try {
      const res = await fetch('/api/chat/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || 'Stream request failed');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);

          if (payload === '[DONE]') {
            setStreaming(false);
            return accumulated;
          }

          try {
            const parsed = JSON.parse(payload);
            if (parsed.error) throw new Error(parsed.error);
            if (parsed.toolExecuted) {
              onToolExecuted?.(parsed.toolExecuted, parsed.result);
            } else if (parsed.delta) {
              accumulated += parsed.delta;
              setStreamedText(accumulated);
            }
          } catch (e) {
            if (e.message !== 'Unexpected end of JSON input') throw e;
          }
        }
      }

      setStreaming(false);
      return accumulated;
    } catch (err) {
      setStreaming(false);
      if (err.name === 'AbortError') return '';
      throw err;
    }
  }, [resetStream]);

  return { streaming, streamedText, streamChat, resetStream };
}
