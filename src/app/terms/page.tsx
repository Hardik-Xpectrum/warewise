import Link from "next/link";

export const metadata = { title: "Terms · Warewise" };

const CONTACT = process.env.NEXT_PUBLIC_CONTACT_EMAIL ?? "privacy@warewise.example";

export default function Terms() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-12 text-sm leading-6">
      <h1 className="text-2xl font-semibold">Terms of use</h1>
      <p className="mt-2 text-muted">Last updated 26 September 2026.</p>

      <h2 className="mt-8 font-semibold">The service</h2>
      <p>Warewise helps you organise your clothes and suggests outfits. Suggestions, fit notes, measurements and try-on images are estimates made by software, including AI; they can be wrong. Try-on images are illustrations, not a guarantee of how a garment will look or fit.</p>

      <h2 className="mt-6 font-semibold">Your account</h2>
      <p>You must be 18 or over. Keep your sign-in secure; you&apos;re responsible for activity on your account. One account per person.</p>

      <h2 className="mt-6 font-semibold">Your content</h2>
      <p>You keep ownership of the photos you upload. You give Warewise permission to store and process them only to provide the service (and, if you opt in, to improve Warewise&apos;s models). Upload only photos you have the right to use: photos of yourself and your own clothes. Don&apos;t upload photos of other people without their permission.</p>

      <h2 className="mt-6 font-semibold">Fair use</h2>
      <p>Daily limits apply to uploads, the AI stylist and AI try-on so the free service stays available. Don&apos;t attempt to break, overload or scrape the service, or to access other people&apos;s data.</p>

      <h2 className="mt-6 font-semibold">Shopping links</h2>
      <p>Links to shops such as Myntra and AJIO are for convenience. Purchases are between you and the shop.</p>

      <h2 className="mt-6 font-semibold">Availability and liability</h2>
      <p>The service is provided as it is, may change, and may be unavailable at times, especially free AI features that depend on shared GPU capacity. To the extent the law allows, Warewise isn&apos;t liable for indirect losses arising from using it.</p>

      <h2 className="mt-6 font-semibold">Ending</h2>
      <p>You can delete your account at any time. We may suspend accounts that break these terms.</p>

      <h2 className="mt-6 font-semibold">Law and contact</h2>
      <p>These terms are governed by the laws of India. Questions: <a className="underline" href={`mailto:${CONTACT}`}>{CONTACT}</a>. How we handle data is in the <Link className="underline" href="/privacy">privacy notice</Link>.</p>
    </main>
  );
}
