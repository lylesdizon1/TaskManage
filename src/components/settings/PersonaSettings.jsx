// src/components/settings/PersonaSettings.jsx
import { useState } from 'react';
import { usePersona } from '../../contexts/PersonaContext';

export default function PersonaSettings() {
  const { personas, activePersonaId, selectPersona, renamePersona, getPersonaName } =
    usePersona();
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState('');

  const startEdit = (id) => {
    setEditing(id);
    setDraft(getPersonaName(id));
  };

  const commitEdit = (id) => {
    renamePersona(id, draft);
    setEditing(null);
  };

  return (
    <div className="persona-settings">
      <h2 className="settings-section-title">AI Personas</h2>
      <p className="settings-section-sub">
        Choose your active persona. Rename any to make it yours.
      </p>
      <div className="persona-grid">
        {personas.map((p) => {
          const isActive = p.id === activePersonaId;
          const displayName = getPersonaName(p.id);
          return (
            <div
              key={p.id}
              className={`persona-card ${isActive ? 'persona-card--active' : ''}`}
              onClick={() => selectPersona(p.id)}
            >
              <div className="persona-card__emoji">{p.emoji}</div>
              {editing === p.id ? (
                <input
                  className="persona-card__name-input"
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commitEdit(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitEdit(p.id);
                    if (e.key === 'Escape') setEditing(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <div className="persona-card__name">
                  {displayName}
                  <button
                    className="persona-card__rename-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      startEdit(p.id);
                    }}
                    title="Rename"
                  >
                    ✏️
                  </button>
                </div>
              )}
              <div className="persona-card__desc">{p.description}</div>
              {isActive && (
                <div className="persona-card__active-badge">Active</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
