export async function fetchSuggestedTags(title, description, claudeKey, entityNames, authToken, apiFetch) {
  console.log('[AI-Tags] fetchSuggestedTags called:', { title, claudeKey: claudeKey ? '***set***' : '***MISSING***', entityCount: entityNames.length, entityNames, hasApiFetch: !!apiFetch });
  if (!claudeKey || !title.trim() || entityNames.length === 0) {
    console.log('[AI-Tags] BAIL: claudeKey=%s title=%s entityCount=%d', !!claudeKey, title, entityNames.length);
    return [];
  }

  const prompt =
    `Given these categories: ${entityNames.join(', ')}. ` +
    `Based on this task title and description: '${title} - ${description}', ` +
    `suggest which tags apply. Respond ONLY with a JSON array of matching tag names, ` +
    `e.g. ${JSON.stringify(entityNames.slice(0, 2))}. No explanation.`;

  try {
    console.log('[AI-Tags] calling /api/claude...');
    const res = await apiFetch('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        apiKey: claudeKey,
        model: 'claude-sonnet-4-20250514',
        max_tokens: 100,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    console.log('[AI-Tags] /api/claude response status:', res.status, 'ok:', res.ok);
    if (!res.ok) return [];
    const data = await res.json();
    const text = data.content?.[0]?.text || '';
    console.log('[AI-Tags] raw Claude text:', text);
    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) { console.log('[AI-Tags] no JSON array found in response'); return []; }
    const parsed = JSON.parse(match[0]);
    console.log('[AI-Tags] parsed array:', parsed);
    const result = parsed
      .map((t) => entityNames.find((e) => e.toLowerCase() === t.toLowerCase()))
      .filter(Boolean);
    console.log('[AI-Tags] final matched result:', result);
    return result;
  } catch (err) {
    console.error('[AI-Tags] ERROR:', err);
    return [];
  }
}
