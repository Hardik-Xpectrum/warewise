/** Generic page placeholder while the first data loads (later visits come from the cache). */
export default function PageSkeleton({ cards = 4 }: { cards?: number }) {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading">
      <div className="skeleton h-8 w-48" />
      <div className="skeleton h-4 w-72" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: cards }, (_, i) => <div key={i} className="skeleton h-28" />)}
      </div>
    </div>
  );
}
