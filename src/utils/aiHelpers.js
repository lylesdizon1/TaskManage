export async function fetchSuggestedTags(title, description, claudeKey, entityNames, authToken, apiFetch) {
  if (!claudeKey || !title.trim() || entityNames.length === 0) return [];

  const prompt =
    `Given these categories: ${entityNames.join(', ')}. ` +
    `Based on this task title and description: '${title} - ${description}', ` +
    `suggest which tags apply. Respond ONLY with a JSON array of matching tag names, ` +
    `e.g. ${JSON.stringify(entityNames.slice(0, 2))}. No explanation.`;

  try {
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

    if (!res.ok) return [];
    const data = await res.json();
    const text = data.content?.[0]?.text || '';
    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    return parsed.filter((t) => entityNames.includes(t));
  } catch {
    return [];
  }
}
