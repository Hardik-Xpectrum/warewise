type Level = "info" | "warn" | "error";

/** Structured JSON logs; Vercel and local terminals both show them, searchable by requestId. */
export function log(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ level, msg, time: new Date().toISOString(), ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function errorFields(err: unknown) {
  return err instanceof Error ? { error: err.message, stack: err.stack } : { error: String(err) };
}
