import { redirect } from "next/navigation";
import Toaster from "@/components/Toaster";
import { createUserClient } from "@/lib/supabase/server";
import WelcomeFlow from "./WelcomeFlow";

export const metadata = { title: "Welcome · Warewise" };

export default async function WelcomePage() {
  const supabase = await createUserClient();
  const { data } = await supabase.from("profiles").select("display_name,onboarded_at").maybeSingle();
  if (data?.onboarded_at) redirect("/today");
  // The sign-up trigger fills display_name from Google's name or the email's local part; only
  // offer it if it reads like a name (letters and spaces), not "rahul.k92".
  const raw = data?.display_name ?? "";
  const name = /^[\p{L} ]{2,}$/u.test(raw) ? raw.replace(/\b\p{L}/gu, (c: string) => c.toUpperCase()) : "";
  return (
    <>
      <WelcomeFlow initialName={name} />
      <Toaster />
    </>
  );
}
