import { redirect } from "next/navigation";
import { createUserClient } from "@/lib/supabase/server";
import TodayView from "./TodayView";

export const metadata = { title: "Today · Warewise" };

export default async function TodayPage() {
  // New users start with the welcome flow (name, sizes, style, first clothes); it runs once.
  const supabase = await createUserClient();
  const { data } = await supabase.from("profiles").select("onboarded_at").maybeSingle();
  if (data && !data.onboarded_at) redirect("/welcome");
  return <TodayView />;
}
