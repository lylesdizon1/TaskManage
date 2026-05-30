import { getTagStyle } from '../../constants/colors.js';

export default function TagPill({ tag, isAi = false, entities = [] }) {
  const style = getTagStyle(tag, entities);
  const entity = entities.find((e) => e.name === tag);
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium border ${style.bg} ${style.text} ${style.border}`}
    >
      {tag}
      {entity?.shared && <span>{'\u{1F517}'}</span>}
      {isAi && (
        <span className="text-[9px] leading-none bg-primary text-on-primary px-1 py-0.5 rounded-full">
          AI
        </span>
      )}
    </span>
  );
}
