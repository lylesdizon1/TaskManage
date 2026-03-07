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
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-2">Persona</label>
      <div className="flex flex-wrap gap-2 mb-3">
        {personas.map((p) => {
          const isActive = p.id === activePersonaId;
          const displayName = getPersonaName(p.id);
          return (
            <button
              key={p.id}
              onClick={() => selectPersona(p.id)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all flex items-center gap-1.5 ${
                isActive
                  ? 'bg-indigo-100 text-indigo-700 border border-indigo-300'
                  : 'bg-gray-50 text-gray-500 border border-gray-200 hover:border-gray-300'
              }`}
            >
              <span>{p.emoji}</span>
              {editing === p.id ? (
                <input
                  className="w-20 bg-transparent outline-none text-xs font-medium"
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
                <span>{displayName}</span>
              )}
              {isActive && (
                <span
                  className="ml-0.5 opacity-50 hover:opacity-100 text-indigo-400"
                  onClick={(e) => { e.stopPropagation(); startEdit(p.id); }}
                  title="Rename"
                >
                  ✏️
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="bg-gray-50 border border-gray-100 rounded-lg px-3 py-2.5 text-xs text-gray-500 italic">
        {personas.find((p) => p.id === activePersonaId)?.description}
      </div>
    </div>
  );
}
