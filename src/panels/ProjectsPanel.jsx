import { useState, useEffect, useCallback } from 'react';

const STATUS_CHIP = {
  active:    { background: '#eaf3de', color: '#3b6d11' },
  completed: { background: '#f1efe8', color: '#5f5e5a' },
  archived:  { background: '#f1efe8', color: '#888' },
};

function Chip({ status }) {
  const s = STATUS_CHIP[status] || STATUS_CHIP.active;
  return (
    <span style={{ ...s, fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 6, fontFamily: "'Plus Jakarta Sans', sans-serif", textTransform: 'uppercase', letterSpacing: '0.04em' }}>
      {status}
    </span>
  );
}

/**
 * ProjectsPanel — entity-grouped project workspace (V1).
 * Lazy-loads on nav. All state is local; mutations hit the V1 API directly.
 */
export default function ProjectsPanel({ entities = [], apiFetch, authToken }) {
  const ownedOrShared = (entities || []).filter((e) => e); // all entities visible
  return (
    <div className="flex-1 overflow-y-auto px-8 py-6 w-full" style={{ minHeight: 0, fontFamily: 'Manrope, sans-serif' }}>
      <h1 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 24, fontWeight: 700, color: '#31323a', marginBottom: 24 }}>
        Projects
      </h1>
      {ownedOrShared.length === 0 ? (
        <div style={{ color: '#9ca3af', fontSize: 14 }}>No entities yet — create one in Settings to start a project workspace.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
          {ownedOrShared.map((entity) => (
            <EntitySection key={entity.id} entity={entity} apiFetch={apiFetch} authToken={authToken} />
          ))}
        </div>
      )}
    </div>
  );
}

function EntitySection({ entity, apiFetch, authToken }) {
  const [projects, setProjects] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');

  const reload = useCallback(async () => {
    try {
      const r = await apiFetch(`/api/projects?entity_id=${encodeURIComponent(entity.id)}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const data = await r.json();
      setProjects(Array.isArray(data?.projects) ? data.projects : []);
    } catch {} finally { setLoaded(true); }
  }, [apiFetch, authToken, entity.id]);

  useEffect(() => { reload(); }, [reload]);

  const create = async () => {
    const title = newTitle.trim();
    if (!title) return;
    try {
      const r = await apiFetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ entity_id: entity.id, title }),
      });
      if (r.ok) { setNewTitle(''); setAdding(false); reload(); }
    } catch {}
  };

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <h2 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 14, fontWeight: 700, color: '#1f2937', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          {entity.name}
        </h2>
        {!adding ? (
          <button onClick={() => setAdding(true)} style={{ fontSize: 12, fontWeight: 600, color: '#4f4dcf', background: 'transparent', border: 'none', cursor: 'pointer' }}>
            + New Project
          </button>
        ) : (
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              autoFocus
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') create(); if (e.key === 'Escape') { setAdding(false); setNewTitle(''); } }}
              placeholder="Project title"
              style={{ fontSize: 12, padding: '4px 8px', border: '1px solid #e5e7eb', borderRadius: 6, outline: 'none', minWidth: 200 }}
            />
            <button onClick={create} style={{ fontSize: 12, fontWeight: 600, color: '#fff', background: '#4f4dcf', border: 'none', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}>Add</button>
            <button onClick={() => { setAdding(false); setNewTitle(''); }} style={{ fontSize: 12, color: '#6b7280', background: 'transparent', border: 'none', cursor: 'pointer' }}>Cancel</button>
          </div>
        )}
      </div>
      {!loaded ? (
        <div style={{ fontSize: 12, color: '#9ca3af' }}>Loading…</div>
      ) : projects.length === 0 ? (
        <div style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>No projects yet</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {projects.map((p) => (
            <ProjectRow key={p.id} project={p} entity={entity} apiFetch={apiFetch} authToken={authToken} onChange={reload} />
          ))}
        </div>
      )}
    </section>
  );
}

function ProjectRow({ project, entity, apiFetch, authToken, onChange }) {
  const [expanded, setExpanded] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [tasksLoaded, setTasksLoaded] = useState(false);
  const [addingTask, setAddingTask] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [notes, setNotes] = useState([]);
  const [addingNote, setAddingNote] = useState(false);
  const [newNote, setNewNote] = useState('');

  const reload = useCallback(async () => {
    try {
      const [tr, nr] = await Promise.all([
        apiFetch(`/api/projects/${project.id}/tasks`, { headers: { Authorization: `Bearer ${authToken}` } }),
        apiFetch(`/api/project-notes?project_id=${encodeURIComponent(project.id)}`, { headers: { Authorization: `Bearer ${authToken}` } }),
      ]);
      const td = await tr.json();
      const nd = await nr.json();
      setTasks(Array.isArray(td?.tasks) ? td.tasks : []);
      setNotes(Array.isArray(nd?.notes) ? nd.notes : []);
    } catch {} finally { setTasksLoaded(true); }
  }, [apiFetch, authToken, project.id]);

  useEffect(() => { if (expanded && !tasksLoaded) reload(); }, [expanded, tasksLoaded, reload]);

  const totalTasks = tasks.length;
  const doneTasks = tasks.filter((t) => t.status === 'completed').length;

  const addTask = async () => {
    const title = newTaskTitle.trim();
    if (!title) return;
    try {
      const r = await apiFetch('/api/project-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ project_id: project.id, entity_id: entity.id, title }),
      });
      if (r.ok) { setNewTaskTitle(''); setAddingTask(false); reload(); }
    } catch {}
  };

  const addNote = async () => {
    const body = newNote.trim();
    if (!body) return;
    try {
      const r = await apiFetch('/api/project-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ project_id: project.id, entity_id: entity.id, body }),
      });
      if (r.ok) { setNewNote(''); setAddingNote(false); reload(); }
    } catch {}
  };

  const completeProject = async () => {
    try {
      await apiFetch(`/api/projects/${project.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ status: 'completed' }),
      });
      onChange?.();
    } catch {}
  };

  const deleteProject = async () => {
    if (!window.confirm(`Delete project "${project.title}" and all its tasks?`)) return;
    try {
      await apiFetch(`/api/projects/${project.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` } });
      onChange?.();
    } catch {}
  };

  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer' }} onClick={() => setExpanded((v) => !v)}>
        <span className="material-symbols-outlined" style={{ fontSize: 16, color: '#6b7280' }}>{expanded ? 'expand_more' : 'chevron_right'}</span>
        <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: '#1f2937' }}>{project.title}</span>
        {totalTasks > 0 && (
          <span style={{ fontSize: 11, color: '#6b7280' }}>{doneTasks}/{totalTasks} tasks done</span>
        )}
        <Chip status={project.status} />
      </div>
      {expanded && (
        <div style={{ borderTop: '1px solid #f3f4f6', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 12, background: '#fcfbff' }}>
          {/* Tasks */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Tasks</div>
              {!addingTask && (
                <button onClick={() => setAddingTask(true)} style={{ fontSize: 11, color: '#4f4dcf', background: 'transparent', border: 'none', cursor: 'pointer' }}>+ Add Task</button>
              )}
            </div>
            {addingTask && (
              <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                <input autoFocus value={newTaskTitle} onChange={(e) => setNewTaskTitle(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addTask(); if (e.key === 'Escape') { setAddingTask(false); setNewTaskTitle(''); } }}
                  placeholder="Task title" style={{ flex: 1, fontSize: 12, padding: '4px 8px', border: '1px solid #e5e7eb', borderRadius: 6, outline: 'none' }} />
                <button onClick={addTask} style={{ fontSize: 12, fontWeight: 600, color: '#fff', background: '#4f4dcf', border: 'none', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}>Add</button>
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {tasks.map((t) => (
                <TaskRow key={t.id} task={t} entity={entity} apiFetch={apiFetch} authToken={authToken} onChange={reload} />
              ))}
              {tasks.length === 0 && !addingTask && (
                <div style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>No tasks yet</div>
              )}
            </div>
          </div>
          {/* Notes */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Notes</div>
              {!addingNote && (
                <button onClick={() => setAddingNote(true)} style={{ fontSize: 11, color: '#4f4dcf', background: 'transparent', border: 'none', cursor: 'pointer' }}>+ Add note</button>
              )}
            </div>
            {addingNote && (
              <div style={{ marginBottom: 6 }}>
                <textarea autoFocus value={newNote} onChange={(e) => setNewNote(e.target.value)}
                  placeholder="Note…"
                  style={{ width: '100%', fontSize: 12, padding: '6px 8px', border: '1px solid #e5e7eb', borderRadius: 6, outline: 'none', resize: 'vertical', minHeight: 50, fontFamily: 'Manrope, sans-serif' }} />
                <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                  <button onClick={addNote} style={{ fontSize: 12, fontWeight: 600, color: '#fff', background: '#4f4dcf', border: 'none', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}>Add</button>
                  <button onClick={() => { setAddingNote(false); setNewNote(''); }} style={{ fontSize: 12, color: '#6b7280', background: 'transparent', border: 'none', cursor: 'pointer' }}>Cancel</button>
                </div>
              </div>
            )}
            {notes.map((n) => (
              <div key={n.id} style={{ fontSize: 12, color: '#374151', padding: '4px 0', borderTop: '1px dashed #e5e7eb', whiteSpace: 'pre-wrap' }}>{n.body}</div>
            ))}
          </div>
          {/* Project actions */}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', borderTop: '1px solid #f3f4f6', paddingTop: 8 }}>
            {project.status !== 'completed' && (
              <button onClick={completeProject} style={{ fontSize: 11, color: '#3b6d11', background: 'transparent', border: '1px solid #d1d5db', borderRadius: 6, padding: '2px 8px', cursor: 'pointer' }}>Mark complete</button>
            )}
            <button onClick={deleteProject} style={{ fontSize: 11, color: '#dc2626', background: 'transparent', border: '1px solid #d1d5db', borderRadius: 6, padding: '2px 8px', cursor: 'pointer' }}>Delete</button>
          </div>
        </div>
      )}
    </div>
  );
}

function TaskRow({ task, entity, apiFetch, authToken, onChange }) {
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState([]);
  const [taskNotes, setTaskNotes] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');

  const reload = useCallback(async () => {
    try {
      const [cr, nr] = await Promise.all([
        apiFetch(`/api/task-checklist-items?task_id=${encodeURIComponent(task.id)}`, { headers: { Authorization: `Bearer ${authToken}` } }),
        apiFetch(`/api/project-notes?task_id=${encodeURIComponent(task.id)}`, { headers: { Authorization: `Bearer ${authToken}` } }),
      ]);
      const cd = await cr.json().catch(() => ({}));
      const nd = await nr.json().catch(() => ({}));
      const fetchedItems = Array.isArray(cd?.items) ? cd.items : [];
      // Merge with locally-added items (dedupe by id, server wins on conflict).
      setItems((prev) => {
        const byId = new Map(prev.map((it) => [it.id, it]));
        for (const it of fetchedItems) byId.set(it.id, it);
        return Array.from(byId.values());
      });
      setTaskNotes(Array.isArray(nd?.notes) ? nd.notes : []);
    } catch {} finally { setLoaded(true); }
  }, [apiFetch, authToken, task.id]);

  // Load checklist + notes on mount so they appear before the user expands.
  // Without this, items don't survive a page reload until the row is opened.
  useEffect(() => { reload(); }, [reload]);

  const addItem = async () => {
    const t = text.trim();
    if (!t) return;
    try {
      const r = await apiFetch('/api/task-checklist-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ task_id: task.id, entity_id: entity.id, text: t }),
      });
      if (r.ok) {
        const data = await r.json();
        if (data?.item) setItems((prev) => [...prev, data.item]);
        setText(''); setAdding(false);
      }
    } catch {}
  };

  const toggleItem = async (id) => {
    try {
      const r = await apiFetch(`/api/task-checklist-items/${id}/toggle`, { method: 'POST', headers: { Authorization: `Bearer ${authToken}` } });
      if (r.ok) {
        const data = await r.json();
        if (data?.item) setItems((prev) => prev.map((it) => (it.id === id ? data.item : it)));
      }
    } catch {}
  };

  const completeTask = async () => {
    try {
      const r = await apiFetch(`/api/project-tasks/${task.id}/complete`, { method: 'POST', headers: { Authorization: `Bearer ${authToken}` } });
      if (r.ok) onChange?.();
    } catch {}
  };

  const allDone = items.length > 0 && items.every((it) => it.isDone);

  return (
    <div style={{ background: allDone ? 'rgba(16,185,129,0.06)' : '#fff', border: '1px solid #e5e7eb', borderRadius: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', cursor: 'pointer' }} onClick={() => setExpanded((v) => !v)}>
        <span className="material-symbols-outlined" style={{ fontSize: 14, color: '#6b7280' }}>{expanded ? 'expand_more' : 'chevron_right'}</span>
        <span style={{ flex: 1, fontSize: 13, color: task.status === 'completed' ? '#6b7280' : '#1f2937', textDecoration: task.status === 'completed' ? 'line-through' : 'none' }}>{task.title}</span>
        {task.status !== 'completed' && (
          <button onClick={(e) => { e.stopPropagation(); completeTask(); }} style={{ fontSize: 10, color: '#3b6d11', background: 'transparent', border: '1px solid #d1d5db', borderRadius: 5, padding: '1px 6px', cursor: 'pointer' }}>Complete</button>
        )}
      </div>
      {expanded && (
        <div style={{ padding: '6px 10px 10px 28px', borderTop: '1px dashed #e5e7eb' }}>
          {items.map((it) => (
            <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: it.isDone ? '#6b7280' : '#1f2937', padding: '2px 0' }}>
              <input type="checkbox" checked={!!it.isDone} onChange={() => toggleItem(it.id)} />
              <span style={{ textDecoration: it.isDone ? 'line-through' : 'none' }}>{it.text}</span>
            </div>
          ))}
          {adding ? (
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              <input autoFocus value={text} onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addItem(); if (e.key === 'Escape') { setAdding(false); setText(''); } }}
                placeholder="Checklist item" style={{ flex: 1, fontSize: 12, padding: '3px 6px', border: '1px solid #e5e7eb', borderRadius: 5, outline: 'none' }} />
              <button onClick={addItem} style={{ fontSize: 11, color: '#fff', background: '#4f4dcf', border: 'none', borderRadius: 5, padding: '2px 8px', cursor: 'pointer' }}>Add</button>
            </div>
          ) : (
            <button onClick={() => setAdding(true)} style={{ fontSize: 11, color: '#4f4dcf', background: 'transparent', border: 'none', cursor: 'pointer', marginTop: 4 }}>+ Add item</button>
          )}
          {taskNotes.length > 0 && (
            <div style={{ marginTop: 8, paddingTop: 6, borderTop: '1px dashed #e5e7eb' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', marginBottom: 3 }}>Notes</div>
              {taskNotes.map((n) => (
                <div key={n.id} style={{ fontSize: 11, color: '#374151', padding: '2px 0', whiteSpace: 'pre-wrap' }}>{n.body}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
