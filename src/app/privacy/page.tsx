import Link from "next/link";

export const metadata = { title: "Privacy · Warewise" };

const CONTACT = process.env.NEXT_PUBLIC_CONTACT_EMAIL ?? "privacy@warewise.example";
const UPDATED = "26 September 2026";

export default function Privacy() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-12 text-sm leading-6">
      <h1 className="text-2xl font-semibold">Privacy notice</h1>
      <p className="mt-2 text-muted">Last updated {UPDATED}. Written for India&apos;s Digital Personal Data Protection Act, 2023.</p>

      <h2 className="mt-8 font-semibold">What we collect and why</h2>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li><strong>Account:</strong> your email and name (from Google or a sign-in link), to run your account.</li>
        <li><strong>Wardrobe:</strong> photos of your clothes (a cleaned copy and thumbnail; location data is removed), their tags, outfits and what you mark as worn, to suggest outfits.</li>
        <li><strong>Profile:</strong> city (for weather), style preferences, sizes and optional body measurements, to fit suggestions and try-on.</li>
        <li><strong>Avatar photos:</strong> up to 5 photos of you, cut out on your device, to show clothes on you.</li>
        <li><strong>Likes, saves and feedback,</strong> to learn your taste.</li>
        <li><strong>Error reports:</strong> technical details of crashes (no cookies, request bodies, photos or personal fields).</li>
      </ul>

      <h2 className="mt-6 font-semibold">Where it goes</h2>
      <p>Data is stored privately with Supabase in Mumbai. To tag clothes and suggest outfits, photos and wardrobe details are sent to AI providers on free tiers (currently Google Gemini, with Groq and OpenRouter as backups). <strong>Free tiers may use submitted data to improve the provider&apos;s products.</strong> Avatar photos are sent to an outside service only if you turn on <strong>Realistic AI try-on</strong>, which uses Leffa and IDM-VTON hosted on Hugging Face. The same switch covers the <strong>AI 3D avatar</strong>, which sends one photo (your avatar photo or a try-on image) to a 3D service (TRELLIS or Stable Fast 3D on Hugging Face, or fal.ai, Tripo or Meshy) to build a 3D model that is then stored privately in your account. Weather comes from Open-Meteo using only your city name. We never sell your data.</p>

      <h2 className="mt-6 font-semibold">How long we keep it</h2>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>Your wardrobe, outfits and profile: until you delete them or your account.</li>
        <li>Raw AI request logs: 30 days. Unsaved outfit suggestions: 14 days. Daily outfit picks: 7 days.</li>
        <li>After account deletion, everything is removed immediately, including every photo.</li>
      </ul>

      <h2 className="mt-6 font-semibold">Consent</h2>
      <p>Using your data to improve Warewise&apos;s own models (&ldquo;Help improve Warewise&rdquo;) and realistic AI try-on are off until you switch them on, and you can switch either off at any time in your <Link className="underline" href="/profile">profile</Link>. Withdrawing consent stops future use; it doesn&apos;t affect what was done before.</p>

      <h2 className="mt-6 font-semibold">Your rights</h2>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li><strong>Access:</strong> Profile → Download my data gives you everything we hold, with links to your photos.</li>
        <li><strong>Correction:</strong> edit any item, tag or profile field in the app.</li>
        <li><strong>Erasure:</strong> Profile → Delete account removes it all immediately.</li>
        <li><strong>Grievances:</strong> write to our grievance contact at <a className="underline" href={`mailto:${CONTACT}`}>{CONTACT}</a>. We reply within 7 days. If unresolved, you may complain to the Data Protection Board of India.</li>
      </ul>

      <h2 className="mt-6 font-semibold">Children</h2>
      <p>Warewise is for people aged 18 and over.</p>
      <p className="mt-8 text-muted">See also the <Link className="underline" href="/terms">terms of use</Link>.</p>
    </main>
  );
}
