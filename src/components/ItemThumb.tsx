/* eslint-disable @next/next/no-img-element -- signed Supabase URLs expire; next/image optimisation is off */
export default function ItemThumb({ url, alt, className = "" }: { url: string | null; alt: string; className?: string }) {
  return (
    <div className={`overflow-hidden rounded-none bg-surface-2 ${className}`}>
      {url ? (
        <img src={url} alt={alt} loading="lazy" decoding="async" className="garment-shadow h-full w-full object-contain" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-xs text-muted">No image</div>
      )}
    </div>
  );
}
