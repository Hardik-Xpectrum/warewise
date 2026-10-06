import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";

const cache = new Map<string, string>();

/** Prompts live in prompts/<job>/<version>.md so they can change without touching code. */
export function loadPrompt(job: string, version: string): string {
  const key = `${job}/${version}`;
  let text = cache.get(key);
  if (text === undefined) {
    if (!/^[a-z0-9_-]+$/i.test(job) || !/^[a-z0-9_.-]+$/i.test(version)) throw new Error(`Bad prompt id ${key}`);
    text = readFileSync(path.join(/* turbopackIgnore: true */ process.cwd(), "prompts", job, `${version}.md`), "utf8");
    cache.set(key, text);
  }
  return text;
}
