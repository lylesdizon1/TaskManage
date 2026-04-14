// Thin client wrapper around POST /api/aria/parse-draft.
// Returns one of: { type:'task', … }, { type:'event', … }, { type:'default_chat' }.
// Any failure resolves to { type:'default_chat' } so the Command Center
// silently falls back to normal agentic chat.
export async function parseActionDraft({ apiFetch, authToken, message, timezone, today, entities, projects }) {
  try {
    const entityList = Array.isArray(entities)
      ? entities.slice(0, 50).map((e) => ({ id: e.id, name: e.name })).filter((e) => e.name)
      : [];
    const projectList = Array.isArray(projects)
      ? projects.slice(0, 50).map((p) => ({ id: p.id, title: p.title, entityId: p.entityId, entityName: p.entityName })).filter((p) => p.id && p.title)
      : [];
    const res = await apiFetch('/api/aria/parse-draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ message, timezone, today, entities: entityList, projects: projectList }),
    });
    if (!res.ok) return { type: 'default_chat' };
    const data = await res.json();
    if (!data || typeof data !== 'object') return { type: 'default_chat' };
    return data;
  } catch {
    return { type: 'default_chat' };
  }
}
