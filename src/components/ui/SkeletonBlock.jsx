export default function SkeletonBlock({ className = '' }) {
  return <div className={`bg-gray-200 rounded-lg animate-pulse ${className}`} />;
}
