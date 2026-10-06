import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="chip">404</p>
      <h1 className="text-2xl font-semibold">This page isn&apos;t in the wardrobe</h1>
      <p className="text-sm text-muted">The link may be old, or the item was deleted.</p>
      <Link href="/wardrobe" className="btn-primary">Back to my wardrobe</Link>
    </main>
  );
}
