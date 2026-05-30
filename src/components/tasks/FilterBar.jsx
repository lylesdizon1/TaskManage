import { getEntityStyle } from '../../constants/colors.js';
import { buildGroupedEntities } from '../../utils/helpers.js';

export default function FilterBar({
  activeTagFilters,
  setActiveTagFilters,
  statusFilter,
  setStatusFilter,
  entities,
}) {
  const hasFilters = activeTagFilters.length > 0 || statusFilter !== 'all';

  return (
    <div className="bg-surface-container-lowest border border-outline-variant rounded-xl px-3 py-2.5 mb-4">
      <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide -mx-1 px-1 md:flex-wrap md:overflow-visible">
        <span className="text-xs font-semibold text-text-faint uppercase tracking-wide flex-shrink-0">
          Filter
        </span>

        {/* Tag filters — dynamic from user's entities */}
        {buildGroupedEntities(entities || []).map((ent) => {
          const tag = ent.name;
          const style = getEntityStyle(ent.color);
          const active = activeTagFilters.includes(tag);
          return (
            <button
              key={tag}
              onClick={() =>
                setActiveTagFilters((f) =>
                  active ? f.filter((t) => t !== tag) : [...f, tag],
                )
              }
              className={`text-xs px-2.5 py-1.5 md:py-1 rounded-full font-medium border transition-all flex-shrink-0 min-h-[32px] md:min-h-0 ${
                active
                  ? `${style.bg} ${style.text} ${style.border} ring-2 ring-offset-1 ${style.ring}`
                  : 'bg-surface-container-low text-text-faint border-outline-variant hover:bg-surface-container hover:text-on-surface-variant'
              }`}
            >
              {tag}{ent.shared ? ' 🔗' : ''}
            </button>
          );
        })}

        {/* Divider */}
        <span className="text-text-faint flex-shrink-0">|</span>

        {/* Status filters */}
        {[
          { key: 'all', label: 'All' },
          { key: 'active', label: 'Active' },
          { key: 'done', label: 'Done' },
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setStatusFilter(key)}
            className={`text-xs px-2.5 py-1.5 md:py-1 rounded-full font-medium border transition-all flex-shrink-0 min-h-[32px] md:min-h-0 ${
              statusFilter === key
                ? 'bg-primary text-on-primary border-primary shadow-sm'
                : 'bg-surface-container-low text-text-faint border-outline-variant hover:bg-surface-container hover:text-on-surface-variant'
            }`}
          >
            {label}
          </button>
        ))}

        {/* Clear */}
        {hasFilters && (
          <button
            onClick={() => {
              setActiveTagFilters([]);
              setStatusFilter('all');
            }}
            className="text-xs text-primary hover:opacity-80 font-medium ml-1 transition-colors flex-shrink-0"
          >
            Clear all
          </button>
        )}
      </div>
    </div>
  );
}
