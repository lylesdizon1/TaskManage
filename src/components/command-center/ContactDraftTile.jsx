import InlineEditableField from './InlineEditableField.jsx';
import { TileFooter } from './TaskDraftTile.jsx';

/**
 * ContactDraftTile — inline editable draft shown above Confirm for a
 * create_contact intent. Field names match server/tools.cjs create_contact
 * (display_name, first_name, last_name, primary_email, primary_phone,
 * company, role, notes, image_blob_id, raw_ocr_text, source).
 *
 * Used in two flows:
 *   1) Desktop: user uploads a business card in Command Center → OCR
 *      parses → this tile renders for review → Confirm posts.
 *   2) Desktop chat: Aria proposes a contact from any source → this
 *      tile renders pre-filled → Confirm posts.
 *
 * The source-image thumbnail (top-right) is only rendered when
 * image_blob_id is present. Image bytes are fetched via the
 * /api/image-blobs/:id route which requires the bearer token, so the
 * <img> uses authFetch wrapping — for browser <img> tags the simplest
 * path is to consume the blob URL from the parent. To keep this
 * component thin and matching TaskDraftTile shape, the parent supplies
 * a pre-resolved blobImageUrl prop when needed.
 *
 * Props:
 *   payload         — { display_name, first_name, last_name, primary_email,
 *                       primary_phone, company, role, notes, image_blob_id,
 *                       source, raw_ocr_text }
 *   status          — 'draft' | 'executing' | 'success' | 'error'
 *   error           — string when status === 'error'
 *   blobImageUrl    — optional resolved URL for the source-card thumbnail
 *   onChange        — (patch) => void
 *   onConfirm       — () => void
 *   onCancel        — () => void
 *   onRetry         — () => void
 */
export default function ContactDraftTile({
  payload = {},
  status = 'draft',
  error,
  blobImageUrl,
  onChange,
  onConfirm,
  onCancel,
  onRetry,
}) {
  const disabled = status === 'executing';
  // Saving requires at least one of display_name / first+last / company.
  // Mirrors the server-side acceptance rule so the Confirm button can't
  // submit a row the API will reject.
  const hasMinFields = Boolean(
    (payload.display_name && payload.display_name.trim())
    || ((payload.first_name && payload.first_name.trim()) || (payload.last_name && payload.last_name.trim()))
    || (payload.company && payload.company.trim()),
  );

  return (
    <div
      className="bg-surface-container-lowest border border-outline-variant rounded-xl"
      style={{ fontFamily: 'Manrope, sans-serif' }}
    >
      <div className="flex items-center justify-between gap-1.5 px-3 pt-2.5 pb-1">
        <div className="flex items-center gap-1.5">
          <span className="material-symbols-outlined" style={{ color: 'rgb(var(--accent))', fontSize: '15px' }}>person_add</span>
          <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-on-surface-variant" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
            Contact draft{payload.source === 'business_card_ocr' ? ' · from photo' : ''}
          </span>
        </div>
        {blobImageUrl && (
          <a
            href={blobImageUrl}
            target="_blank"
            rel="noreferrer"
            className="block w-10 h-10 rounded border border-outline-variant overflow-hidden hover:border-primary"
            title="View source photo"
          >
            <img src={blobImageUrl} alt="Source card" className="w-full h-full object-cover" />
          </a>
        )}
      </div>

      <div className="px-3 pb-2 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          <InlineEditableField
            label="First name"
            value={payload.first_name || ''}
            onChange={(v) => onChange?.({ first_name: v || null })}
            placeholder="—"
            disabled={disabled}
          />
          <InlineEditableField
            label="Last name"
            value={payload.last_name || ''}
            onChange={(v) => onChange?.({ last_name: v || null })}
            placeholder="—"
            disabled={disabled}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <InlineEditableField
            label="Company"
            value={payload.company || ''}
            onChange={(v) => onChange?.({ company: v || null })}
            placeholder="—"
            disabled={disabled}
          />
          <InlineEditableField
            label="Role"
            value={payload.role || ''}
            onChange={(v) => onChange?.({ role: v || null })}
            placeholder="—"
            disabled={disabled}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <InlineEditableField
            label="Email"
            value={payload.primary_email || ''}
            onChange={(v) => onChange?.({ primary_email: v || null })}
            inputType="email"
            placeholder="—"
            disabled={disabled}
          />
          <InlineEditableField
            label="Phone"
            value={payload.primary_phone || ''}
            onChange={(v) => onChange?.({ primary_phone: v || null })}
            placeholder="—"
            disabled={disabled}
          />
        </div>
        <InlineEditableField
          label="Notes"
          value={payload.notes || ''}
          onChange={(v) => onChange?.({ notes: v || null })}
          placeholder="Anything else worth remembering?"
          disabled={disabled}
        />
      </div>

      <TileFooter
        status={status}
        error={error}
        disabled={disabled || !hasMinFields}
        onConfirm={onConfirm}
        onCancel={onCancel}
        onRetry={onRetry}
        successLabel="Contact saved"
      />
    </div>
  );
}
