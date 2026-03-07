// src/contexts/PersonaContext.jsx
import { createContext, useContext, useState, useCallback } from 'react';
import { PERSONAS, DEFAULT_PERSONA_ID, getPersonaById } from '../config/personas';

const PersonaContext = createContext(null);

const STORAGE_KEY = 'dizon_persona_settings';

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {}
}

export function PersonaProvider({ children }) {
  const [settings, setSettings] = useState(() => loadSettings());
  const [activePersonaId, setActivePersonaId] = useState(
    () => settings.activePersonaId ?? DEFAULT_PERSONA_ID
  );

  const getPersonaName = useCallback(
    (id) => settings.customNames?.[id] ?? getPersonaById(id)?.defaultName ?? id,
    [settings]
  );

  const selectPersona = useCallback(
    (id) => {
      const updated = { ...settings, activePersonaId: id };
      setActivePersonaId(id);
      setSettings(updated);
      saveSettings(updated);
    },
    [settings]
  );

  const renamePersona = useCallback(
    (id, name) => {
      const trimmed = name.trim();
      const updated = {
        ...settings,
        customNames: {
          ...(settings.customNames ?? {}),
          [id]: trimmed || getPersonaById(id)?.defaultName,
        },
      };
      setSettings(updated);
      saveSettings(updated);
    },
    [settings]
  );

  const activePersona = {
    ...getPersonaById(activePersonaId),
    displayName: getPersonaName(activePersonaId),
  };

  return (
    <PersonaContext.Provider
      value={{
        personas: PERSONAS,
        activePersonaId,
        activePersona,
        selectPersona,
        renamePersona,
        getPersonaName,
      }}
    >
      {children}
    </PersonaContext.Provider>
  );
}

export function usePersona() {
  const ctx = useContext(PersonaContext);
  if (!ctx) throw new Error('usePersona must be used within PersonaProvider');
  return ctx;
}
