/**
 * Build a smart system prompt with persona, user identity, and relevant context.
 *
 * @param {Object} options
 * @param {string} options.user - Current user name (e.g. 'lyle')
 * @param {string} options.intent - Detected intent (e.g. 'FINANCIAL')
 * @param {Object} options.slices - Trimmed context slices from tokenBudget
 * @param {Object} options.persona - Persona object with name, systemPrompt, etc.
 * @returns {string} Complete system prompt
 */
export function buildSmartSystemPrompt({ user, intent, slices, persona }) {
  const sections = [];

  // Persona system prompt
  if (persona && persona.systemPrompt) {
    sections.push(persona.systemPrompt);
  }

  // User identity
  sections.push(`Current user: ${user || 'unknown'}. Detected intent: ${intent}.`);

  // Transactions
  if (slices.transactions && slices.transactions.length > 0) {
    const lines = slices.transactions.map(t =>
      `- ${t.date || 'no date'}: ${t.description || t.name || 'unnamed'} — $${t.amount ?? '?'}${t.category ? ` (${t.category})` : ''}`
    );
    sections.push(`Recent Transactions (${slices.transactions.length}):\n${lines.join('\n')}`);
  }

  // Tasks
  if (slices.tasks && slices.tasks.length > 0) {
    const lines = slices.tasks.map(t => {
      const parts = [`- ${t.title || t.name || 'untitled'}`];
      if (t.priority) parts.push(`[${t.priority}]`);
      if (t.dueDate) parts.push(`due ${t.dueDate}`);
      if (t.tag || t.tags) parts.push(`tag: ${t.tag || t.tags.join(', ')}`);
      if (t.owner) parts.push(`owner: ${t.owner}`);
      if (t.completed) parts.push('(done)');
      return parts.join(' ');
    });
    sections.push(`Tasks (${slices.tasks.length}):\n${lines.join('\n')}`);
  }

  // Events
  if (slices.events && slices.events.length > 0) {
    const lines = slices.events.map(e => {
      const date = e.start || e.date || 'no date';
      const end = e.end ? ` – ${e.end}` : '';
      return `- ${date}${end}: ${e.summary || e.title || 'untitled'}${e.location ? ` @ ${e.location}` : ''}`;
    });
    sections.push(`Upcoming Events (${slices.events.length}):\n${lines.join('\n')}`);
  }

  // Notes
  if (slices.notes && slices.notes.length > 0) {
    const lines = slices.notes.map(n => {
      const tag = n.tag || (n.tags && n.tags.join(', ')) || '';
      const date = n.date || n.createdAt || '';
      const content = n.content || n.body || n.text || '';
      const preview = content.length > 200 ? content.slice(0, 200) + '...' : content;
      return `- ${date ? date + ': ' : ''}${preview}${tag ? ` [${tag}]` : ''}`;
    });
    sections.push(`Notes (${slices.notes.length}):\n${lines.join('\n')}`);
  }

  // Entities
  if (slices.entities && slices.entities.length > 0) {
    const lines = slices.entities.map(e => {
      const parts = [`- ${e.name || 'unnamed'}`];
      if (e.type) parts.push(`(${e.type})`);
      if (e.email) parts.push(`email: ${e.email}`);
      if (e.phone) parts.push(`phone: ${e.phone}`);
      if (e.relationship) parts.push(`rel: ${e.relationship}`);
      return parts.join(' ');
    });
    sections.push(`Entities (${slices.entities.length}):\n${lines.join('\n')}`);
  }

  return sections.join('\n\n');
}
