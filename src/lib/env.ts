// Central place for environment variables, so a missing one fails loudly and early.

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

// NEXT_PUBLIC_* values must be referenced literally so Next.js can inline them in the browser bundle.
export const publicEnv = {
  supabaseUrl: () => required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
  supabaseKey: () =>
    required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY),
  emailLoginEnabled: () => process.env.NEXT_PUBLIC_ENABLE_EMAIL_LOGIN === "true",
  // Local development only: where Supabase catches outgoing email (Mailpit).
  devMailboxUrl: () => process.env.NEXT_PUBLIC_DEV_MAILBOX_URL || null,
};

export const serverEnv = {
  supabaseSecretKey: () => required("SUPABASE_SECRET_KEY", process.env.SUPABASE_SECRET_KEY),
  jobSecret: () => required("JOB_SECRET", process.env.JOB_SECRET),
  aiConfigFile: () => process.env.AI_CONFIG_FILE || "config/ai.config.json",
  // The services (vision, avatar, tryon): each is switched on by setting its URL. Unset, the web app
  // does that work in-process as before. SERVICE_SECRET signs calls both ways.
  serviceSecret: () => {
    const s = required("SERVICE_SECRET", process.env.SERVICE_SECRET);
    if (s.length < 32) throw new Error("SERVICE_SECRET must be at least 32 characters");
    return s;
  },
  serviceUrl: (name: "vision" | "avatar" | "tryon"): string | null =>
    ({ vision: process.env.VISION_URL, avatar: process.env.AVATAR_URL, tryon: process.env.TRYON_URL })[name]?.replace(/\/+$/, "") || null,
};
