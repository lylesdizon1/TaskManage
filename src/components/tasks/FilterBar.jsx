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
    <div className="bg-white border border-gray-100 rounded-xl px-3 py-2.5 mb-4">
      <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide -mx-1 px-1 md:flex-wrap md:overflow-visible">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide flex-shrink-0">
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
                  : 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100 hover:text-gray-600'
              }`}
            >
              {tag}{ent.shared ? ' 🔗' : ''}
            </button>
          );
        })}

        {/* Divider */}
        <span className="text-gray-200 flex-shrink-0">|</span>

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
                ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                : 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100 hover:text-gray-600'
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
            className="text-xs text-indigo-500 hover:text-indigo-700 font-medium ml-1 transition-colors flex-shrink-0"
          >
            Clear all
          </button>
        )}
      </div>
    </div>
  );
}
