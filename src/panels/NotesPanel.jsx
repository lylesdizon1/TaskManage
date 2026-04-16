import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TiptapImage from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import { SpinnerIcon } from '../components/icons/Icons.jsx';
import { PILLAR_CONFIG, PILLAR_KEYS } from '../constants/pillars.js';
export { PILLAR_CONFIG, PILLAR_KEYS };

// ── Tiptap Rich Text Editor Component ────────────────────────────────────────

function TiptapToolbar({ editor, onImageClick }) {
  if (!editor) return null;
  const btnBase = 'w-7 h-7 flex items-center justify-center rounded text-xs transition-colors';
  const active = 'bg-purple-600 text-white';
  const inactive = 'text-gray-600 hover:bg-gray-100';
  const btn = (isActive) => `${btnBase} ${isActive ? active : inactive}`;
  return (
    <div className="flex items-center gap-1 px-3 py-2 border-b border-gray-100 flex-wrap overflow-x-auto" style={{ minHeight: 40 }}>
      <button type="button" tabIndex={-1} onClick={() => editor.chain().focus().toggleBold().run()} className={btn(editor.isActive('bold'))} title="Bold (Cmd+B)"><strong>B</strong></button>
      <button type="button" tabIndex={-1} onClick={() => editor.chain().focus().toggleItalic().run()} className={btn(editor.isActive('italic'))} title="Italic (Cmd+I)"><em>I</em></button>
      <button type="button" tabIndex={-1} onClick={() => editor.chain().focus().toggleUnderline().run()} className={btn(editor.isActive('underline'))} title="Underline (Cmd+U)"><span style={{ textDecoration: 'underline' }}>U</span></button>
      <div className="w-px h-5 bg-gray-200 mx-0.5" />
      <button type="button" tabIndex={-1} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} className={btn(editor.isActive('heading', { level: 1 }))} title="Heading 1">H1</button>
      <button type="button" tabIndex={-1} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} className={btn(editor.isActive('heading', { level: 2 }))} title="Heading 2">H2</button>
      <div className="w-px h-5 bg-gray-200 mx-0.5" />
      <button type="button" tabIndex={-1} onClick={() => editor.chain().focus().toggleBulletList().run()} className={btn(editor.isActive('bulletList'))} title="Bullet list">•</button>
      <button type="button" tabIndex={-1} onClick={() => editor.chain().focus().toggleOrderedList().run()} className={btn(editor.isActive('orderedList'))} title="Ordered list">1.</button>
      <div className="w-px h-5 bg-gray-200 mx-0.5" />
      <button type="button" tabIndex={-1} onClick={() => editor.chain().focus().toggleBlockquote().run()} className={btn(editor.isActive('blockquote'))} title="Quote">"</button>
      <button type="button" tabIndex={-1} onClick={() => editor.chain().focus().toggleCodeBlock().run()} className={btn(editor.isActive('codeBlock'))} title="Code block">&lt;/&gt;</button>
      <button type="button" tabIndex={-1} onClick={() => editor.chain().focus().setHorizontalRule().run()} className={`${btnBase} ${inactive}`} title="Divider">—</button>
      {onImageClick && (
        <>
          <div className="w-px h-5 bg-gray-200 mx-0.5" />
          <button type="button" tabIndex={-1} onClick={onImageClick} className={`${btnBase} ${inactive}`} title="Add image">📷</button>
        </>
      )}
    </div>
  );
}

function useNoteEditor({ content, onUpdate }) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2] } }),
      TiptapImage.configure({ inline: false, allowBase64: true }),
      Placeholder.configure({ placeholder: 'Start writing...' }),
    ],
    content: content || '',
    editorProps: {
      attributes: {
        class: 'tiptap-editor outline-none',
        style: 'min-height:300px;padding:16px;font-size:15px;line-height:1.7',
      },
      handleKeyDown: (view, event) => {
        console.log('Tiptap keydown:', event.key, 'editable:', view.editable, 'hasFocus:', view.hasFocus());
        return false; // never block
      },
    },
    onUpdate: ({ editor: ed }) => {
      if (onUpdate) onUpdate(ed.getHTML());
    },
  });
  return editor;
}

// Strips HTML tags for plain-text display/search
function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

// Highlights matching text in search results
function highlightMatch(text, query) {
  if (!query) return text;
  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  const parts = text.split(regex);
  return parts.map((part, i) =>
    regex.test(part) ? <strong key={i} className="text-purple-700 bg-purple-50">{part}</strong> : part
  );
}

// Wraps plain text in <p> tags if it doesn't contain HTML
function ensureHtml(content) {
  if (!content) return '';
  if (content.includes('<') && content.includes('>')) return content;
  return content.split('\n').map((line) => `<p>${line || '<br>'}</p>`).join('');
}

// ── Image Lightbox Component ─────────────────────────────────────────────────

function ImageLightbox({ images, startIndex, onClose, onDelete }) {
  const [idx, setIdx] = useState(startIndex || 0);
  const img = images[idx];
  if (!img) return null;
  return (
    <div className="fixed inset-0 z-[9999] bg-black/80 flex items-center justify-center" onClick={onClose}>
      <div className="relative max-w-[90vw] max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
        <img src={img.url} alt={img.originalName || 'image'} className="max-w-full max-h-[85vh] object-contain rounded-lg" />
        <button type="button" tabIndex={-1} onClick={onClose} className="absolute top-2 right-2 w-8 h-8 bg-black/60 text-white rounded-full flex items-center justify-center hover:bg-black/80">✕</button>
        {images.length > 1 && (
          <>
            <button type="button" tabIndex={-1} onClick={() => setIdx((idx - 1 + images.length) % images.length)} className="absolute left-2 top-1/2 -translate-y-1/2 w-10 h-10 bg-black/60 text-white rounded-full flex items-center justify-center hover:bg-black/80 text-lg">←</button>
            <button type="button" tabIndex={-1} onClick={() => setIdx((idx + 1) % images.length)} className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 bg-black/60 text-white rounded-full flex items-center justify-center hover:bg-black/80 text-lg">→</button>
          </>
        )}
        {onDelete && (
          <button type="button" tabIndex={-1} onClick={() => onDelete(img.id)} className="absolute bottom-3 right-3 px-3 py-1.5 bg-red-600 text-white text-xs rounded-lg hover:bg-red-700 flex items-center gap-1">🗑️ Delete</button>
        )}
      </div>
    </div>
  );
}

// ── Note Image Gallery Strip ─────────────────────────────────────────────────

function NoteImageGallery({ noteId, authToken, images, setImages, onAddClick, apiFetch }) {
  const [lightboxIdx, setLightboxIdx] = useState(null);
  const [uploading, setUploading] = useState(false);

  async function handleDelete(imageId) {
    try {
      await apiFetch(`/api/notes/${noteId}/images/${imageId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      setImages((prev) => prev.filter((img) => img.id !== imageId));
      setLightboxIdx(null);
    } catch {}
  }

  if (!images.length) return null;

  return (
    <div className="border-t border-gray-100 pt-3 mt-3">
      <div className="text-xs text-gray-400 font-medium mb-2 flex items-center gap-1.5">
        📷 Attachments ({images.length})
      </div>
      <div className="flex gap-2 flex-wrap">
        {images.map((img, i) => (
          <div key={img.id} className="relative group cursor-pointer" onClick={() => setLightboxIdx(i)}>
            <img src={img.url} alt={img.originalName || 'attachment'} className="w-20 h-20 object-cover rounded-lg border border-gray-200" style={{ minWidth: 80 }} />
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 rounded-lg flex items-center justify-center transition-opacity">
              <button type="button" tabIndex={-1} onClick={(e) => { e.stopPropagation(); handleDelete(img.id); }} className="text-white text-sm">🗑️</button>
            </div>
          </div>
        ))}
        {onAddClick && (
          <button type="button" tabIndex={-1} onClick={onAddClick} className="w-20 h-20 rounded-lg border-2 border-dashed border-gray-300 flex items-center justify-center text-gray-400 hover:border-purple-400 hover:text-purple-500 transition-colors text-2xl" title="Add image">+</button>
        )}
      </div>
      {lightboxIdx !== null && (
        <ImageLightbox images={images} startIndex={lightboxIdx} onClose={() => setLightboxIdx(null)} onDelete={handleDelete} />
      )}
    </div>
  );
}

// Re-export for consumers that import from NotesPanel
export { VIEW_TO_PILLAR } from '../constants/pillars.js';

function relativeTime(dateStr) {
  const now = new Date();
  const d = new Date(dateStr);
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay === 1) return 'Yesterday';
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

export default function NotesPanel({ authToken, onEditorStateChange, onCategoriesLoaded, onNotesLoaded, quickCapturedNote, addToast, entities = [], apiFetch, onNoteOpenRef }) {
  const [notes, setNotes] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pillarFilter, setPillarFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [selectedNote, setSelectedNote] = useState(null);
  const [editorData, setEditorData] = useState({ title: '', content: '', pillar: '', category: '', subcategory: '', tags: '', entityId: '' });
  const [saveStatus, setSaveStatus] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState(null); // { pillar, category, confidence, reason }
  const [noteImages, setNoteImages] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const suggestTimerRef = useRef(null);
  const saveTimerRef = useRef(null);
  const searchTimerRef = useRef(null);
  const fileInputRef = useRef(null);
  const searchInputRef = useRef(null);
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` };

  const loadNotes = useCallback(async () => {
    const params = new URLSearchParams();
    if (pillarFilter) params.set('entityId', pillarFilter);
    if (categoryFilter) params.set('category', categoryFilter);
    try {
      const res = await apiFetch(`/api/notes?${params}`, { headers: { Authorization: `Bearer ${authToken}` } });
      const data = await res.json();
      if (Array.isArray(data)) setNotes(data.filter((n) => n.type !== 'digest'));
    } catch {}
  }, [authToken, pillarFilter, categoryFilter]);

  const loadCategories = useCallback(async () => {
    try {
      const res = await apiFetch('/api/notes/categories', { headers: { Authorization: `Bearer ${authToken}` } });
      const data = await res.json();
      if (Array.isArray(data)) setCategories(data);
    } catch {}
  }, [authToken]);

  useEffect(() => {
    Promise.all([loadNotes(), loadCategories()]).then(() => setLoading(false));
  }, [loadNotes, loadCategories]);

  // Report editor state to parent (for FAB visibility)
  useEffect(() => {
    if (onEditorStateChange) onEditorStateChange(selectedNote !== null);
  }, [selectedNote, onEditorStateChange]);

  // Forward categories to parent (for quick capture modal)
  useEffect(() => {
    if (onCategoriesLoaded) onCategoriesLoaded(categories);
  }, [categories, onCategoriesLoaded]);

  // Forward notes to parent (for chat context)
  useEffect(() => {
    if (onNotesLoaded) onNotesLoaded(notes);
  }, [notes, onNotesLoaded]);

  // Prepend quick-captured note if received from FAB
  useEffect(() => {
    if (quickCapturedNote) setNotes((prev) => [quickCapturedNote, ...prev]);
  }, [quickCapturedNote]);

  // ── Tiptap editor ──
  const tiptapEditor = useNoteEditor({
    content: ensureHtml(editorData.content),
    onUpdate: (html) => {
      handleEditorChange('content', html);
    },
  });

  // ── Sync editor content & focus when note changes ──
  const pendingContentRef = useRef(null);
  useEffect(() => {
    if (!tiptapEditor || !selectedNote) return;
    let cancelled = false;

    function applyContentAndFocus() {
      if (cancelled) return;
      const dom = tiptapEditor.view?.dom;
      // Wait until the editor's contenteditable is actually in the document
      if (!dom || !dom.isConnected) {
        requestAnimationFrame(applyContentAndFocus);
        return;
      }
      // Set content from pendingContentRef (set by openNote / handleNewNote)
      const html = pendingContentRef.current;
      if (html !== null) {
        pendingContentRef.current = null;
        tiptapEditor.commands.setContent(html);
      }
      // Focus the contenteditable directly, then set cursor position
      dom.focus({ preventScroll: true });
      tiptapEditor.commands.focus('end');
      console.log('Editor focus result:', tiptapEditor.isFocused, document.activeElement?.tagName, document.activeElement?.contentEditable);
    }
    requestAnimationFrame(applyContentAndFocus);

    return () => { cancelled = true; };
  }, [selectedNote?.id, tiptapEditor]);

  // ── Load images when note changes ──
  useEffect(() => {
    if (!selectedNote?.id) { setNoteImages([]); return; }
    apiFetch(`/api/notes/${selectedNote.id}/images`, { headers: { Authorization: `Bearer ${authToken}` } })
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setNoteImages(data); })
      .catch(() => setNoteImages([]));
  }, [selectedNote?.id, authToken]);

  // ── Image upload handler ──
  async function uploadImages(files) {
    if (!selectedNote?.id || !files?.length) return;
    for (const file of files) {
      if (file.size > 10 * 1024 * 1024) { if (addToast) addToast({ type: 'error', message: `${file.name} exceeds 10MB limit` }); continue; }
      if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.type)) { if (addToast) addToast({ type: 'error', message: `${file.name}: unsupported format` }); continue; }
      const formData = new FormData();
      formData.append('image', file);
      try {
        const res = await apiFetch(`/api/notes/${selectedNote.id}/images`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${authToken}` },
          body: formData,
        });
        const img = await res.json();
        if (img.id) setNoteImages((prev) => [...prev, img]);
      } catch { if (addToast) addToast({ type: 'error', message: `Failed to upload ${file.name}` }); }
    }
  }

  // ── Drag & drop handlers for editor area ──
  function handleDragOver(e) { e.preventDefault(); setDragOver(true); }
  function handleDragLeave(e) { e.preventDefault(); setDragOver(false); }
  function handleDrop(e) {
    e.preventDefault(); setDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
    if (files.length) uploadImages(files);
  }

  // ── Paste handler for images ──
  function handlePaste(e) {
    const items = Array.from(e.clipboardData?.items || []);
    const imageFiles = items.filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
    if (imageFiles.length) uploadImages(imageFiles);
  }

  // ── Search ──
  useEffect(() => {
    if (!searchQuery || searchQuery.length < 2) { setSearchResults(null); return; }
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(async () => {
      try {
        const res = await apiFetch(`/api/notes/search?q=${encodeURIComponent(searchQuery)}`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        const data = await res.json();
        setSearchResults(Array.isArray(data) ? data : []);
      } catch { setSearchResults([]); }
    }, 300);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [searchQuery, authToken]);

  // ── Cmd+F shortcut for search ──
  useEffect(() => {
    function handleKeyDown(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
      if (e.key === 'Escape' && searchQuery) {
        setSearchQuery('');
        setSearchResults(null);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [searchQuery]);

  // Build category tree
  const parentCategories = useMemo(() => categories.filter((c) => !c.parentId), [categories]);
  const childCategories = useMemo(() => categories.filter((c) => c.parentId), [categories]);

  function getSubcategories(parentName, pillar) {
    const parent = parentCategories.find((p) => p.pillar === pillar);
    if (!parent) return [];
    return childCategories.filter((c) => c.parentId === parent.id);
  }


  function handleNewNote() {
    const tempNote = {
      id: null, title: '', content: '', type: 'structured',
      pillar: pillarFilter || null, category: '', subcategory: '',
      tags: [], pinned: false, archived: false,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    setSelectedNote(tempNote);
    setEditorData({ title: '', content: '', pillar: pillarFilter || '', category: '', subcategory: '', tags: '', entityId: '' });
    setSaveStatus('new');
    setShowDeleteConfirm(false);
    setNoteImages([]);
    pendingContentRef.current = '';
  }

  function openNote(note) {
    const htmlContent = ensureHtml(note.content || '');
    pendingContentRef.current = htmlContent;
    setSelectedNote(note);
    setEditorData({
      title: note.title || '',
      content: note.content || '',
      pillar: note.pillar || '',
      category: note.category || '',
      subcategory: note.subcategory || '',
      tags: (note.tags || []).join(', '),
      entityId: note.entityId || '',
    });
    setSaveStatus('saved');
    setShowDeleteConfirm(false);
    setAiSuggestion(null);
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
  }

  // Expose openNote to parent via ref callback
  useEffect(() => {
    if (onNoteOpenRef) onNoteOpenRef(openNote);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleEditorChange(field, value) {
    setEditorData((prev) => ({ ...prev, [field]: value }));
    setSaveStatus('saving...');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveNote({ ...editorData, [field]: value });
    }, 2000);
  }

  async function saveNote(data) {
    if (!selectedNote) return;
    const body = {
      title: data.title,
      content: data.content,
      pillar: data.pillar || null,
      category: data.category,
      subcategory: data.subcategory,
      tags: data.tags ? data.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
      entityId: data.entityId || null,
    };
    try {
      if (!selectedNote.id) {
        // New note — POST to create
        body.type = 'structured';
        const res = await apiFetch('/api/notes', { method: 'POST', headers, body: JSON.stringify(body) });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          setSaveStatus(`Save failed — ${err.error || res.statusText}`);
          return;
        }
        const created = await res.json();
        setSelectedNote(created);
        setNotes((prev) => [created, ...prev]);
        setSaveStatus('saved');
        // Schedule AI pillar suggestion
        if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
        suggestTimerRef.current = setTimeout(() => requestPillarSuggestion(created.id, data.content, data.pillar), 2000);
      } else {
        // Existing note — PUT to update
        const res = await apiFetch(`/api/notes/${selectedNote.id}`, { method: 'PUT', headers, body: JSON.stringify(body) });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          setSaveStatus(`Save failed — ${err.error || res.statusText}`);
          return;
        }
        const updated = await res.json();
        setSelectedNote(updated);
        setNotes((prev) => prev.map((n) => n.id === updated.id ? updated : n));
        setSaveStatus('saved');
        // Schedule AI pillar suggestion
        if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
        suggestTimerRef.current = setTimeout(() => requestPillarSuggestion(updated.id, data.content, data.pillar), 2000);
      }
    } catch (e) { setSaveStatus(`Save failed — ${e.message || 'network error'}`); }
  }

  // AI pillar suggestion — called 2s after save completes
  async function requestPillarSuggestion(noteId, content, currentPillar) {
    // Only suggest if no pillar manually set and 10+ words
    if (currentPillar || !content || content.trim().split(/\s+/).length < 10) return;
    try {
      const res = await apiFetch(`/api/notes/${noteId}/suggest-pillar`, {
        method: 'POST', headers,
        body: JSON.stringify({ content }),
      });
      const data = await res.json();
      if (!data.pillar || data.confidence < 0.5) return;
      if (data.confidence > 0.85) {
        // Auto-apply silently
        await apiFetch(`/api/notes/${noteId}`, {
          method: 'PUT', headers,
          body: JSON.stringify({ pillar: data.pillar, category: data.category }),
        });
        setSelectedNote((prev) => prev && prev.id === noteId ? { ...prev, pillar: data.pillar, category: data.category } : prev);
        setEditorData((prev) => ({ ...prev, pillar: data.pillar, category: data.category || prev.category }));
        setNotes((prev) => prev.map((n) => n.id === noteId ? { ...n, pillar: data.pillar, category: data.category } : n));
        if (addToast) addToast({ type: 'success', message: `✨ Aria tagged this as ${data.category || PILLAR_CONFIG[data.pillar]?.label || data.pillar}` });
      } else {
        // Show suggestion pill
        setAiSuggestion({ pillar: data.pillar, category: data.category, confidence: data.confidence, reason: data.reason, noteId });
      }
    } catch {}
  }

  function applyAiSuggestion() {
    if (!aiSuggestion || !selectedNote) return;
    const { pillar, category, noteId } = aiSuggestion;
    apiFetch(`/api/notes/${noteId}`, { method: 'PUT', headers, body: JSON.stringify({ pillar, category }) }).catch(() => {});
    setEditorData((prev) => ({ ...prev, pillar, category: category || prev.category }));
    setSelectedNote((prev) => prev && prev.id === noteId ? { ...prev, pillar, category } : prev);
    setNotes((prev) => prev.map((n) => n.id === noteId ? { ...n, pillar, category } : n));
    setAiSuggestion(null);
    if (addToast) addToast({ type: 'success', message: `✨ Tagged as ${category || PILLAR_CONFIG[pillar]?.label || pillar}` });
  }

  async function handlePin() {
    if (!selectedNote || !selectedNote.id) return;
    try {
      const res = await apiFetch(`/api/notes/${selectedNote.id}/pin`, { method: 'PUT', headers });
      const updated = await res.json();
      if (updated.id) {
        setSelectedNote(updated);
        setNotes((prev) => prev.map((n) => n.id === updated.id ? updated : n));
      }
    } catch {}
  }

  async function handleDelete(noteId) {
    const id = noteId || selectedNote?.id;
    if (!id) {
      // Unsaved new note — just discard
      setSelectedNote(null);
      setShowDeleteConfirm(false);
      return;
    }
    try {
      await apiFetch(`/api/notes/${id}`, { method: 'DELETE', headers });
      setNotes((prev) => prev.filter((n) => n.id !== id));
      if (selectedNote?.id === id) setSelectedNote(null);
      setShowDeleteConfirm(false);
    } catch {}
  }

  function closeEditor() {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      // Only save if there's actual content
      if (selectedNote && (editorData.title || editorData.content)) {
        saveNote(editorData);
      }
    }
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
    setAiSuggestion(null);
    setSelectedNote(null);
  }

  // Filtered subcategories based on selected pillar in editor
  const editorSubcats = useMemo(() => {
    if (!editorData.pillar) return [];
    return getSubcategories(editorData.pillar, editorData.pillar);
  }, [editorData.pillar, categories]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Date grouping helper (must be before useMemo) ──
  function getDateGroup(dateStr) {
    const now = new Date();
    const d = new Date(dateStr);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    const weekAgo = new Date(today); weekAgo.setDate(today.getDate() - 7);
    if (d >= today) return 'Today';
    if (d >= yesterday) return 'Yesterday';
    if (d >= weekAgo) return 'This Week';
    return 'Earlier';
  }

  const displayNotes = (searchResults !== null ? searchResults : notes).filter((n) => !pillarFilter || n.entityId === pillarFilter);

  // Group notes by date — must be called unconditionally (before any early return)
  const groupedNotes = useMemo(() => {
    const groups = {};
    const order = ['Today', 'Yesterday', 'This Week', 'Earlier'];
    displayNotes.forEach((note) => {
      const group = getDateGroup(note.updatedAt || note.createdAt);
      if (!groups[group]) groups[group] = [];
      groups[group].push(note);
    });
    return order.filter((g) => groups[g]?.length).map((g) => ({ label: g, notes: groups[g] }));
  }, [displayNotes]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <SpinnerIcon className="w-6 h-6 text-indigo-400 animate-spin" />
      </div>
    );
  }

  // ── Editor view (mobile replaces list, desktop is right panel) ──
  const editorPanel = selectedNote && (
    <div className="flex-1 flex flex-col overflow-hidden bg-white">
      {/* Editor header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <button onClick={closeEditor} className="text-sm text-gray-500 hover:text-gray-700 md:hidden">← Back</button>
        <div className="flex items-center gap-2">
          <span className={`text-xs px-2 py-0.5 rounded ${saveStatus === 'saved' ? 'bg-green-50 text-green-600' : saveStatus.startsWith('Save failed') ? 'bg-red-50 text-red-600' : saveStatus === 'new' ? 'bg-blue-50 text-blue-600' : 'bg-yellow-50 text-yellow-600'}`}>
            {saveStatus === 'saved' ? '✓ Saved' : saveStatus.startsWith('Save failed') ? saveStatus : saveStatus === 'new' ? 'New note' : '⏳ Saving...'}
          </span>
          <button onClick={handlePin} className={`p-1.5 rounded hover:bg-gray-100 ${selectedNote.pinned ? 'text-amber-500' : 'text-gray-400'}`} title={selectedNote.pinned ? 'Unpin' : 'Pin'}>📌</button>
        </div>
      </div>

      {/* Tiptap toolbar */}
      <TiptapToolbar editor={tiptapEditor} onImageClick={selectedNote?.id ? () => fileInputRef.current?.click() : undefined} />
      {/* Hidden file input for image uploads */}
      <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple style={{ display: 'none' }} onChange={(e) => { uploadImages(Array.from(e.target.files)); e.target.value = ''; }} />

      {/* Editor body */}
      <div
        className={`flex-1 overflow-y-auto px-4 py-3 space-y-3 relative ${dragOver ? 'ring-2 ring-purple-400 ring-inset' : ''}`}
        onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop} onPaste={handlePaste}
      >
        {dragOver && (
          <div className="absolute inset-0 bg-purple-50/80 z-10 flex items-center justify-center rounded-lg pointer-events-none">
            <span className="text-purple-600 font-medium text-sm">Drop image here</span>
          </div>
        )}
        <input
          type="text" value={editorData.title}
          onChange={(e) => handleEditorChange('title', e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              tiptapEditor?.commands?.focus('start');
            }
          }}
          placeholder="Title (optional)"
          className="w-full text-lg font-semibold bg-transparent border-0 outline-none placeholder-gray-300"
        />
        {/* Entity picker */}
        <div className="flex gap-2 flex-wrap pb-1">
          <button type="button"
            onClick={() => handleEditorChange('entityId', '')}
            className={`px-3 py-1 rounded-full text-[11px] font-bold transition-colors ${!editorData.entityId ? 'bg-primary text-on-primary' : 'bg-surface-variant text-on-surface-variant hover:bg-surface-variant/70'}`}>
            None
          </button>
          {(entities || []).map((ent, idx) => {
            const ENTITY_COLORS = ['#4f4dcf','#0ea5e9','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#14b8a6'];
            const entColor = (ent.color && ent.color.startsWith('#')) ? ent.color : ENTITY_COLORS[idx % ENTITY_COLORS.length];
            const isActive = editorData.entityId === ent.id;
            return (
              <button type="button" key={ent.id}
                onClick={() => handleEditorChange('entityId', isActive ? '' : ent.id)}
                className={`px-3 py-1 rounded-full text-[11px] font-bold transition-colors ${isActive ? 'text-white' : 'bg-surface-variant text-on-surface-variant hover:bg-surface-variant/70'}`}
                style={isActive ? { backgroundColor: entColor } : { borderLeft: `3px solid ${entColor}` }}>
                {ent.name}
              </button>
            );
          })}
        </div>
        <div style={{ flex: 1, cursor: 'text', minHeight: '100%' }} onClick={() => tiptapEditor?.commands?.focus()}>
          <EditorContent editor={tiptapEditor} />
        </div>

        {/* Image gallery strip */}
        {selectedNote?.id && (
          <NoteImageGallery
            noteId={selectedNote.id}
            authToken={authToken}
            images={noteImages}
            setImages={setNoteImages}
            onAddClick={() => fileInputRef.current?.click()}
            apiFetch={apiFetch}
          />
        )}

      </div>
    </div>
  );

  // ── Main layout ──
  return (
    <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
      {/* Left sidebar — notes list */}
      <div className={`w-full md:w-96 flex-shrink-0 flex flex-col overflow-hidden bg-surface-container-low ${selectedNote ? 'hidden md:flex' : 'flex'}`}>
        {/* Library header */}
        <div className="px-6 pt-6 pb-4 flex items-center justify-between">
          <h2 className="text-xl font-bold font-headline tracking-tight text-on-background">Library</h2>
          <span className="text-xs font-bold text-on-surface-variant uppercase tracking-widest">{notes.length} Notes</span>
        </div>
        {/* Search bar */}
        <div className="px-6 pb-4">
          <div className="relative">
            <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-outline text-lg">search</span>
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search notes..."
              className="w-full bg-surface-container-lowest rounded-xl py-3 pl-11 pr-4 border-none text-sm focus:ring-2 focus:ring-primary/10 text-on-background placeholder:text-outline"
            />
            {searchQuery && (
              <button type="button" onClick={() => { setSearchQuery(''); setSearchResults(null); }} className="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-background text-xs">✕</button>
            )}
          </div>
          {searchResults !== null && (
            <div className="text-[10px] text-on-surface-variant mt-1 px-1">{searchResults.length} note{searchResults.length !== 1 ? 's' : ''} found</div>
          )}
        </div>



        {/* Entity filter pills */}
        <div className="px-6 pb-4 flex gap-2 flex-wrap">
          <button type="button" onClick={() => { setPillarFilter(''); setCategoryFilter(''); }}
            className={`px-4 py-2 rounded-full text-xs font-bold transition-colors ${!pillarFilter ? 'bg-primary text-on-primary' : 'bg-surface-container-lowest text-on-surface-variant hover:bg-surface-variant/50'}`}>
            All
          </button>
          {(entities || []).map((ent, idx) => {
            const ENTITY_COLORS = ['#4f4dcf','#0ea5e9','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#14b8a6'];
            const dotColor = (ent.color && ent.color.startsWith('#')) ? ent.color : ENTITY_COLORS[idx % ENTITY_COLORS.length];
            const isActive = pillarFilter === ent.id;
            return (
              <button type="button" key={ent.id} onClick={() => { setPillarFilter(isActive ? '' : ent.id); setCategoryFilter(''); }}
                className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-bold transition-colors ${isActive ? 'bg-primary text-on-primary' : 'bg-surface-container-lowest text-on-surface-variant hover:bg-surface-variant/50'}`}>
                {!isActive && <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: dotColor }} />}
                {ent.name}
              </button>
            );
          })}
        </div>

        {/* New Note button — above list */}
        <div className="px-6 pb-4 flex-shrink-0">
          <button type="button" onClick={handleNewNote}
            className="w-full bg-gradient-to-br from-primary to-primary-container text-on-primary py-3 rounded-xl font-bold flex items-center justify-center gap-2 shadow-[0px_10px_30px_rgba(79,77,207,0.2)] hover:scale-[1.02] active:scale-[0.98] transition-all text-sm">
            <span className="material-symbols-outlined text-lg">add</span>
            New Note
          </button>
        </div>
        {/* Notes list grouped by date. min-h-0 unlocks flex overflow on
            mobile browsers (Safari in particular); pb-20 clears the
            bottom nav bar so the last note isn't clipped. */}
        <div className="flex-1 overflow-y-auto min-h-0 pb-20 md:pb-0" style={{ WebkitOverflowScrolling: 'touch' }}>
          {searchResults !== null && displayNotes.length === 0 ? (
            <div className="flex flex-col items-center text-gray-400 py-10 px-3">
              <p className="text-sm text-gray-500 mb-2">No notes found for '{searchQuery}'</p>
              <button type="button" onClick={() => { setSearchQuery(''); setSearchResults(null); }} className="text-xs text-purple-600 hover:underline">Clear search</button>
            </div>
          ) : displayNotes.length === 0 ? (
            <div className="flex flex-col items-center text-gray-400 py-10 px-3">
              <p className="text-sm text-gray-500 mb-1">No notes yet</p>
              <button type="button" onClick={handleNewNote}
                className="mt-2 px-4 py-1.5 bg-purple-600 text-white text-xs font-medium rounded-lg hover:bg-purple-700 transition-colors">
                + Create your first note
              </button>
            </div>
          ) : (
            groupedNotes.map(({ label, notes: groupNotes }) => (
              <div key={label}>
                <div className="px-3 pt-3 pb-1">
                  <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">{label}</span>
                </div>
                {groupNotes.map((note) => {
                  const plainContent = stripHtml(note.content || '');
                  const titleText = note.title || plainContent.slice(0, 30) || 'Untitled';
                  const isActive = selectedNote?.id === note.id || (selectedNote && !selectedNote.id && !note.id);
                  const pillarCfg = note.pillar && PILLAR_CONFIG[note.pillar];
                  // Build meta line: "Hustle · Careific · 2 min ago"
                  const metaParts = [];
                  if (pillarCfg) metaParts.push(pillarCfg.label);
                  if (note.category) metaParts.push(note.category);
                  metaParts.push(relativeTime(note.updatedAt || note.createdAt));
                  return (
                    <button type="button" key={note.id || 'new'} onClick={() => openNote(note)}
                      className={`group w-full text-left px-6 py-1.5 transition-all hover:translate-x-1`}
                    >
                      <div className={`bg-surface-container-lowest p-5 rounded-xl border-l-4 shadow-[0px_4px_12px_rgba(0,0,0,0.02)] transition-all ${isActive ? 'border-primary shadow-[0px_4px_20px_rgba(79,77,207,0.06)]' : 'border-transparent hover:border-surface-variant'}`}>
                      <div className="flex justify-between items-start mb-2">
                        <div className="flex items-center gap-1.5 flex-1 min-w-0">
                          {note.pinned && <span className="material-symbols-outlined text-sm text-outline" style={{fontVariationSettings:"'FILL' 1"}}>push_pin</span>}
                          <h3 className="font-bold text-on-surface line-clamp-1 text-sm">
                            {searchQuery && titleText.toLowerCase().includes(searchQuery.toLowerCase())
                              ? highlightMatch(titleText.slice(0, 40), searchQuery)
                              : titleText.slice(0, 40)}
                          </h3>
                        </div>
                        {isActive && <span className="text-[10px] font-bold text-primary bg-primary-container/10 px-2 py-0.5 rounded-full flex-shrink-0 ml-2">ACTIVE</span>}
                        {note.id && (
                          <div className="flex-shrink-0 relative ml-auto"
                            onClick={(e) => e.stopPropagation()}
                            onMouseDown={(e) => e.stopPropagation()}
                          >
                            <button type="button" tabIndex={-1}
                              onClick={(e) => { e.stopPropagation(); handleDelete(note.id); }}
                              className="w-7 h-7 flex items-center justify-center rounded-full text-error bg-error-container/20 hover:bg-error-container/50 transition-colors"
                              title="Delete note">
                              <span className="material-symbols-outlined" style={{fontSize:'16px'}}>close</span>
                            </button>
                          </div>
                        )}
                      </div>
                      <p className="text-sm text-on-surface-variant line-clamp-2 mb-3 leading-relaxed">
                        {stripHtml(note.content || '').slice(0, 80) || 'No content'}
                      </p>
                      <div className="flex items-center gap-3">
                        <span className="text-[11px] font-bold text-outline">{metaParts[metaParts.length - 1]}</span>
                        {metaParts.length > 1 && <><div className="w-1 h-1 rounded-full bg-outline-variant" /><span className="text-[11px] font-bold text-outline">{metaParts.slice(0, -1).join(' · ')}</span></>}
                      </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

      </div>

      {/* Editor panel — single instance for both mobile & desktop */}
      {selectedNote ? (
        <div className="flex-1 flex flex-col overflow-hidden">
          {editorPanel}
        </div>
      ) : (
        <div className="hidden md:flex md:flex-1 md:border-l md:border-gray-100">
          <div className="flex-1 flex items-center justify-center text-gray-300 text-sm">
            Select a note or create a new one
          </div>
        </div>
      )}
    </div>
  );
}
