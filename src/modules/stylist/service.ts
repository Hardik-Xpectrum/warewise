import "server-only";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { aiChat, AiUnavailableError, jobPromptVersion } from "@/modules/ai/router";
import { extractJson } from "@/modules/ai/json";
import { loadPrompt } from "@/modules/ai/prompts";
import { AppError, errors } from "@/modules/platform/errors";
import { must, type AuthedContext } from "@/modules/platform/http";
import { errorFields, log } from "@/modules/platform/log";
import { withImageUrls, type ItemRow } from "@/modules/wardrobe/service";
import type { Category } from "@/modules/wardrobe/taxonomy";
import { buildRuleOutfits, climateOf, closestOutfits, explainGap, filterCandidates, OCCASIONS, validOutfit, type Candidate, type Occasion, type OutfitPick } from "./rules";
import { harmonyScore, type Harmony } from "./harmony";
import { occasionFromText } from "./intent";
import { completeTheLook, lookFits, MOODS, shopScan, type ScanInput } from "./look";
import { describeTaste, learnTaste, neglected, tasteScore, type Taste, type TasteEvent } from "./taste";
import { STYLIST_JSON_SCHEMA, StylistOutputSchema, type StylistMessage } from "./schemas";
import { getForecast, type Weather } from "./weather";

export type StylistEvent =
  | { event: "status"; data: { step: string } }
  | { event: "message"; data: { text: string } }
  | {
      event: "preview";
      data: {
        outfitId: "preview";
        source: "rules";
        why: string;
        harmony: ReturnType<typeof harmonyScore>;
        items: { id: string; slot: string; label: string; thumbUrl: string | null }[];
      };
    }
  | {
      event: "outfit";
      data: {
        recommendationId: string;
        outfitId: string;
        source: "ai" | "rules";
        why: string;
        harmony: Harmony;
        items: { id: string; slot: Category; label: string; thumbUrl: string | null }[];
      };
    }
  | { event: "done"; data: { remainingToday: number } }
  | { event: "error"; data: { title: string; detail: string } };

const MAX_TOOL_ROUNDS = 3;
const MAX_PROMPT_CANDIDATES = 60;

export function todayIST(): string {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

function wornLabel(days: number | null) {
  if (days === null) return "never worn";
  return days === 0 ? "worn today" : `worn ${days}d ago`;
}

export type WardrobeState = { rows: ItemRow[]; candidates: Candidate[]; all: Candidate[] };

export async function loadWardrobe(ctx: AuthedContext, occasion: Occasion, weather: Weather | null): Promise<WardrobeState> {
  const rows = must(
    await ctx.supabase
      .from("wardrobe_items")
      .select("id,status,status_reason,lifecycle,category,subcategory,colors,pattern,seasons,fabric,formality,fit,brand,price_inr,notes,image_path,clean_path,thumb_path,phash,duplicate_of,ai_tags,ai_confidence,user_verified,created_at")
      .eq("status", "ready")
      .eq("lifecycle", "active")
      .is("deleted_at", null)
      .not("category", "is", null),
    "Load wardrobe",
  ) as unknown as ItemRow[];

  const worn = must(
    await ctx.supabase.from("wear_log_items").select("item_id, wear_log:wear_log_id(worn_on)"),
    "Load wear log",
  ) as unknown as { item_id: string; wear_log: { worn_on: string } | null }[];
  const lastWorn = new Map<string, string>();
  for (const w of worn) {
    const on = w.wear_log?.worn_on;
    if (on && (!lastWorn.has(w.item_id) || lastWorn.get(w.item_id)! < on)) lastWorn.set(w.item_id, on);
  }
  const today = new Date(todayIST()).getTime();
  const all: Candidate[] = rows.map((r) => ({
    id: r.id,
    category: r.category as Category,
    subcategory: r.subcategory,
    colors: r.colors,
    pattern: r.pattern,
    seasons: r.seasons,
    formality: r.formality,
    fabric: r.fabric,
    lastWornDaysAgo: lastWorn.has(r.id) ? Math.max(0, Math.round((today - new Date(lastWorn.get(r.id)!).getTime()) / 86400_000)) : null,
  }));
  return { rows, all, candidates: filterCandidates(all, occasion, climateOf(weather)) };
}

/**
 * The user's taste, learned from likes, dislikes and saves on suggestions, saved outfits and what
 * they logged as worn. A few small indexed queries; RLS limits them to the user's own rows.
 */
export async function loadTaste(ctx: AuthedContext, state: WardrobeState): Promise<Taste> {
  const today = new Date(todayIST()).getTime();
  const daysAgo = (iso: string) => Math.max(0, Math.round((today - new Date(iso).getTime()) / 86400_000));
  const [fb, saved, worn] = await Promise.all([
    ctx.supabase.from("feedback").select("kind,created_at,recommendation:recommendation_id(outfit_id)").in("kind", ["like", "dislike", "saved"]).order("created_at", { ascending: false }).limit(200),
    ctx.supabase.from("outfits").select("id,created_at,outfit_items(item_id)").eq("saved", true).order("created_at", { ascending: false }).limit(100),
    ctx.supabase.from("wear_log").select("worn_on,wear_log_items(item_id)").order("worn_on", { ascending: false }).limit(200),
  ]);
  const feedback = (fb.data ?? []) as unknown as { kind: "like" | "dislike" | "saved"; created_at: string; recommendation: { outfit_id: string } | null }[];
  const outfitIds = [...new Set(feedback.map((f) => f.recommendation?.outfit_id).filter((x): x is string => Boolean(x)))];
  const itemsByOutfit = new Map<string, string[]>();
  if (outfitIds.length) {
    const { data } = await ctx.supabase.from("outfit_items").select("outfit_id,item_id").in("outfit_id", outfitIds);
    for (const r of (data ?? []) as { outfit_id: string; item_id: string }[]) itemsByOutfit.set(r.outfit_id, [...(itemsByOutfit.get(r.outfit_id) ?? []), r.item_id]);
  }
  const events: TasteEvent[] = [
    ...feedback.map((f) => ({ kind: f.kind, itemIds: itemsByOutfit.get(f.recommendation?.outfit_id ?? "") ?? [], daysAgo: daysAgo(f.created_at) })),
    ...((saved.data ?? []) as unknown as { created_at: string; outfit_items: { item_id: string }[] }[]).map((o) => ({
      kind: "saved" as const, itemIds: o.outfit_items.map((i) => i.item_id), daysAgo: daysAgo(o.created_at),
    })),
    ...((worn.data ?? []) as unknown as { worn_on: string; wear_log_items: { item_id: string }[] }[]).map((w) => ({
      kind: "worn" as const, itemIds: w.wear_log_items.map((i) => i.item_id), daysAgo: daysAgo(w.worn_on),
    })),
  ];
  return learnTaste(events, new Map(state.all.map((c) => [c.id, c])));
}

/** Short ids ("i1", "i2") in prompts: cheaper than UUIDs and easy to validate. */
class IdMap {
  private toShort = new Map<string, string>();
  private toLong = new Map<string, string>();
  short(id: string) {
    let s = this.toShort.get(id);
    if (!s) {
      s = `i${this.toShort.size + 1}`;
      this.toShort.set(id, s);
      this.toLong.set(s, id);
    }
    return s;
  }
  long(short: string) {
    return this.toLong.get(short.trim());
  }
}

function compact(c: Candidate, ids: IdMap) {
  return {
    id: ids.short(c.id),
    category: c.category,
    type: c.subcategory,
    colors: c.colors,
    pattern: c.pattern,
    formality: c.formality,
    fabric: c.fabric,
    last_worn: wornLabel(c.lastWornDaysAgo),
  };
}

const SEARCH_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "search_wardrobe",
    description: "Search all of the user's available items (not only the candidates) by category, colour or words.",
    parameters: {
      type: "object",
      properties: {
        category: { type: "string", enum: ["top", "bottom", "one_piece", "outer", "shoes", "accessory"] },
        color: { type: "string" },
        text: { type: "string", description: "Words to match in the item type, e.g. 'kurta' or 'blazer'" },
      },
    },
  },
};

function searchWardrobe(all: Candidate[], args: { category?: string; color?: string; text?: string }, ids: IdMap) {
  const text = args.text?.toLowerCase();
  return all
    .filter((c) => !args.category || c.category === args.category)
    .filter((c) => !args.color || c.colors.includes(args.color.toLowerCase()))
    .filter((c) => !text || (c.subcategory ?? "").includes(text))
    .slice(0, 15)
    .map((c) => compact(c, ids));
}

type AiAnswer = { message: string; outfits: OutfitPick[]; interactionId?: string };

async function askAi(
  ctx: AuthedContext,
  input: StylistMessage,
  weather: Weather | null,
  profile: { style_prefs: unknown; body_profile: unknown },
  history: ChatCompletionMessageParam[],
  state: WardrobeState,
  taste: Taste | null = null,
): Promise<AiAnswer> {
  const ids = new IdMap();
  const allowed = new Map<string, Candidate>(state.candidates.map((c) => [c.id, c]));
  const context = {
    occasion: OCCASIONS[input.occasion].label,
    date: input.eventDate ?? todayIST(),
    weather: weather
      ? `${weather.city}: ${weather.tempMinC}–${weather.tempMaxC}°C, ${weather.rainChancePct}% chance of rain`
      : "forecast unavailable",
    mood: input.mood === "any" ? undefined : MOODS[input.mood],
    must_include_colour: input.color,
    style_profile: profile.style_prefs,
    learned_taste: describeTaste(taste) ?? undefined,
    body_profile: profile.body_profile,
    candidates: state.candidates.slice(0, MAX_PROMPT_CANDIDATES).map((c) => compact(c, ids)),
  };

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: loadPrompt("stylist", jobPromptVersion("stylist")) },
    ...history,
    { role: "user", content: `CONTEXT:\n${JSON.stringify(context)}\n\nREQUEST:\n${input.text}` },
  ];

  let interactionId: string | undefined;
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const finalRound = round === MAX_TOOL_ROUNDS;
    const res = await aiChat({
      job: "stylist",
      messages,
      tools: finalRound ? undefined : [SEARCH_TOOL],
      json: { name: "outfits", schema: STYLIST_JSON_SCHEMA as unknown as Record<string, unknown> },
      userId: ctx.userId,
      requestId: ctx.requestId,
    });
    interactionId = res.interactionId;
    const calls = res.message.tool_calls ?? [];
    if (calls.length && !finalRound) {
      messages.push({ role: "assistant", content: res.message.content ?? "", tool_calls: calls });
      for (const call of calls) {
        let result: unknown = { error: "unknown tool" };
        if (call.type === "function" && call.function.name === "search_wardrobe") {
          let args: { category?: string; color?: string; text?: string } = {};
          try {
            args = JSON.parse(call.function.arguments || "{}");
          } catch {
            /* treat as no filters */
          }
          const found = searchWardrobe(state.all, args, ids);
          for (const f of found) {
            const real = state.all.find((c) => c.id === ids.long(f.id));
            if (real) allowed.set(real.id, real);
          }
          result = found;
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
      continue;
    }

    const parsed = StylistOutputSchema.safeParse(extractJson(res.message.content));
    if (!parsed.success) {
      if (finalRound) break;
      messages.push({ role: "assistant", content: res.message.content ?? "" });
      messages.push({ role: "user", content: "That was not valid JSON in the required shape. Reply with the JSON object only." });
      round = MAX_TOOL_ROUNDS - 1; // one repair attempt, without tools
      continue;
    }
    const outfits: OutfitPick[] = parsed.data.outfits
      .map((o) => ({
        why: o.why,
        items: o.items
          .map((i) => ids.long(i.id))
          .filter((id): id is string => Boolean(id))
          .map((id) => ({ id, slot: allowed.get(id)?.category ?? ("top" as Category) })),
      }))
      .filter((o) => validOutfit(o, allowed));
    return { message: parsed.data.message, outfits, interactionId };
  }
  return { message: "", outfits: [], interactionId };
}

function itemLabel(r: ItemRow) {
  return [r.colors[0], r.subcategory ?? r.category].filter(Boolean).join(" ");
}

export async function createConversation(ctx: AuthedContext) {
  return must(
    await ctx.supabase.from("conversations").insert({ user_id: ctx.userId }).select("id").single(),
    "Create conversation",
  ) as { id: string };
}

/** Handles one stylist message end to end and yields the events streamed to the browser. */
export async function* handleStylistMessage(
  ctx: AuthedContext,
  conversationId: string,
  input: StylistMessage,
): AsyncGenerator<StylistEvent> {
  // An occasion named in the text beats the form field (API clients get the same rule as the app).
  input = { ...input, occasion: occasionFromText(input.text) ?? input.occasion };
  const { data: convo } = await ctx.supabase.from("conversations").select("id").eq("id", conversationId).maybeSingle();
  if (!convo) throw errors.notFound("Conversation");

  const profile = must(
    await ctx.supabase.from("profiles").select("home_city,style_prefs,body_profile,daily_stylist_cap").eq("id", ctx.userId).single(),
    "Load profile",
  ) as { home_city: string | null; style_prefs: unknown; body_profile: unknown; daily_stylist_cap: number };

  const { data: count, error: capError } = await ctx.supabase.rpc("take_usage", {
    p_kind: "stylist_calls",
    p_cap: profile.daily_stylist_cap,
  });
  if (capError) throw new Error(capError.message);
  if (count === -1) {
    yield { event: "error", data: { title: "Daily stylist limit reached", detail: "It resets at midnight IST. Your saved outfits are still here." } };
    return;
  }
  const remainingToday = Math.max(0, profile.daily_stylist_cap - (count as number));

  const history = must(
    await ctx.supabase
      .from("messages")
      .select("role,content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(6),
    "Load history",
  ) as { role: "user" | "assistant"; content: string }[];
  await ctx.supabase.from("messages").insert({ conversation_id: conversationId, user_id: ctx.userId, role: "user", content: input.text, meta: { occasion: input.occasion, eventDate: input.eventDate ?? null } });

  const city = input.city || profile.home_city || "";
  const date = input.eventDate ?? todayIST();
  let weather: Weather | null = null;
  if (city) {
    yield { event: "status", data: { step: "Checking the weather" } };
    weather = await getForecast(city, date);
  }

  yield { event: "status", data: { step: "Looking through your wardrobe" } };
  const state = await loadWardrobe(ctx, input.occasion, weather);
  const taste = await loadTaste(ctx, state).catch(() => null);
  const bias = (pieces: Candidate[]) => tasteScore(taste, pieces);
  if (state.all.length < 2) {
    const text = "Add a few more items to your wardrobe first; I need at least a top and a bottom, or a dress, to build an outfit.";
    await ctx.supabase.from("messages").insert({ conversation_id: conversationId, user_id: ctx.userId, role: "assistant", content: text });
    yield { event: "message", data: { text } };
    yield { event: "done", data: { remainingToday } };
    return;
  }

  // Show a rule-built look straight away (no AI, milliseconds) so the card area is never empty
  // while the model thinks. It's a preview only: the real, saved suggestions replace it.
  if (state.candidates.length >= 2) {
    const [quick] = buildRuleOutfits(state.candidates, input.occasion, climateOf(weather), 1, (p) => lookFits(p, input.mood, input.color), bias);
    if (quick) {
      const rowsById = new Map(state.rows.map((r) => [r.id, r]));
      const rows = quick.items.map((i) => rowsById.get(i.id)).filter((r): r is NonNullable<typeof r> => Boolean(r));
      const thumbs = new Map((await withImageUrls(ctx.supabase, rows)).map((d) => [d.id, d.thumbUrl]));
      const byId = new Map(state.all.map((c) => [c.id, c]));
      yield {
        event: "preview",
        data: {
          outfitId: "preview",
          source: "rules",
          why: "A quick pick from your wardrobe while the stylist looks for more.",
          harmony: harmonyScore(quick.items.map((i) => byId.get(i.id)).filter((c): c is Candidate => Boolean(c))),
          items: quick.items.map((i) => ({ id: i.id, slot: i.slot, label: rowsById.get(i.id) ? itemLabel(rowsById.get(i.id)!) : i.slot, thumbUrl: thumbs.get(i.id) ?? null })),
        },
      };
    }
  }

  yield { event: "status", data: { step: "Putting outfits together" } };
  let answer: AiAnswer = { message: "", outfits: [] };
  if (state.candidates.length >= 2) {
    try {
      answer = await askAi(ctx, input, weather, profile, [...history].reverse(), state, taste);
    } catch (err) {
      if (!(err instanceof AiUnavailableError)) log("error", "stylist ai failed", { requestId: ctx.requestId, ...errorFields(err) });
    }
  }

  const byId = new Map(state.all.map((c) => [c.id, c]));
  const piecesOf = (o: OutfitPick) => o.items.map((i) => byId.get(i.id)).filter((c): c is Candidate => Boolean(c));
  const fitsLook = (pieces: Candidate[]) => lookFits(pieces, input.mood, input.color);
  const lookWanted = [input.mood !== "any" ? MOODS[input.mood].toLowerCase() : "", input.color ? `with ${input.color}` : ""].filter(Boolean).join(", ");

  let source: "ai" | "rules" = "ai";
  let outfits = answer.outfits.filter((o) => fitsLook(piecesOf(o)));
  let message = answer.message;
  if (!outfits.length) {
    // The AI's words only count if it produced outfits; otherwise the rules explain.
    source = "rules";
    const climate = climateOf(weather);
    const label = OCCASIONS[input.occasion].label.toLowerCase();
    outfits = buildRuleOutfits(state.candidates, input.occasion, climate, 3, fitsLook, bias);
    if (outfits.length) {
      message = "Here are some combinations from your wardrobe.";
    } else if (lookWanted && (outfits = buildRuleOutfits(state.candidates, input.occasion, climate, 3, undefined, bias)).length) {
      message = `Nothing in your wardrobe is ${lookWanted} for ${label}, so here are the best matches without that filter.`;
    } else {
      const gap = explainGap(state.all, input.occasion, climate);
      outfits = closestOutfits(state.all, input.occasion, climate);
      message = outfits.length
        ? `Nothing is quite right for ${label}: ${gap}. These are the closest options; the Shop tab suggests what to add.`
        : `I couldn't build an outfit for ${label}: ${gap}. The Shop tab suggests what to add.`;
    }
  }
  if (weather) message = `${message} (${weather.city}: ${weather.tempMinC}–${weather.tempMaxC}°C, ${weather.rainChancePct}% rain)`.trim();
  yield { event: "message", data: { text: message } };

  const rowsById = new Map(state.rows.map((r) => [r.id, r]));
  const thumbs = new Map(
    (await withImageUrls(ctx.supabase, outfits.flatMap((o) => o.items.map((i) => rowsById.get(i.id)!)).filter(Boolean))).map((d) => [d.id, d.thumbUrl]),
  );

  const recommendationIds: string[] = [];
  for (const [rank, outfit] of outfits.entries()) {
    const saved = must(
      await ctx.supabase
        .from("outfits")
        .insert({ user_id: ctx.userId, occasion: input.occasion, source, name: `${OCCASIONS[input.occasion].label} look` })
        .select("id")
        .single(),
      "Save outfit",
    ) as { id: string };
    must(
      await ctx.supabase.from("outfit_items").insert(outfit.items.map((i) => ({ outfit_id: saved.id, item_id: i.id, slot: i.slot, user_id: ctx.userId }))),
      "Save outfit items",
    );
    const rec = must(
      await ctx.supabase
        .from("recommendations")
        .insert({
          user_id: ctx.userId,
          conversation_id: conversationId,
          outfit_id: saved.id,
          occasion: input.occasion,
          event_date: date,
          weather,
          rank: rank + 1,
          why: outfit.why,
          source,
          ai_interaction_id: source === "ai" ? answer.interactionId ?? null : null,
        })
        .select("id")
        .single(),
      "Save recommendation",
    ) as { id: string };
    recommendationIds.push(rec.id);
    yield {
      event: "outfit",
      data: {
        recommendationId: rec.id,
        outfitId: saved.id,
        source,
        why: outfit.why,
        harmony: harmonyScore(piecesOf(outfit)),
        items: outfit.items.map((i) => ({
          id: i.id,
          slot: i.slot,
          label: rowsById.get(i.id) ? itemLabel(rowsById.get(i.id)!) : i.slot,
          thumbUrl: thumbs.get(i.id) ?? null,
        })),
      },
    };
  }

  await ctx.supabase.from("messages").insert({
    conversation_id: conversationId,
    user_id: ctx.userId,
    role: "assistant",
    content: message,
    meta: { recommendationIds, source },
  });
  yield { event: "done", data: { remainingToday } };
}

export async function recordFeedback(ctx: AuthedContext, recommendationId: string, kind: string, reason?: string) {
  const { data: rec } = await ctx.supabase.from("recommendations").select("id,outfit_id").eq("id", recommendationId).maybeSingle();
  if (!rec) throw errors.notFound("Recommendation");
  must(await ctx.supabase.from("feedback").insert({ user_id: ctx.userId, recommendation_id: recommendationId, kind, reason: reason ?? null }), "Save feedback");
  // A like (a right swipe) keeps the outfit as a favourite; a save keeps it without the star.
  if (kind === "like") must(await ctx.supabase.from("outfits").update({ saved: true, is_favorite: true }).eq("id", rec.outfit_id), "Favourite outfit");
  if (kind === "saved") must(await ctx.supabase.from("outfits").update({ saved: true }).eq("id", rec.outfit_id), "Save outfit");
  return { outfitId: rec.outfit_id, saved: kind === "like" || kind === "saved", favorite: kind === "like" };
}

export type LookOutfit = {
  outfitId: string;
  why: string;
  harmony: Harmony;
  items: { id: string; slot: Category; label: string; thumbUrl: string | null }[];
};

/** Saves rule-built outfits (unsaved until the user taps Save) so Try on and "I wore this" work. */
/** Labels, thumbnails and harmony for outfits that are already saved. */
export async function describeOutfits(ctx: AuthedContext, state: WardrobeState, saved: { outfitId: string; pick: OutfitPick }[]): Promise<LookOutfit[]> {
  const byId = new Map(state.all.map((c) => [c.id, c]));
  const rowsById = new Map(state.rows.map((r) => [r.id, r]));
  const thumbs = new Map(
    (await withImageUrls(ctx.supabase, saved.flatMap((o) => o.pick.items.map((i) => rowsById.get(i.id)!)).filter(Boolean))).map((d) => [d.id, d.thumbUrl]),
  );
  return saved.map(({ outfitId, pick }) => ({
    outfitId,
    why: pick.why,
    harmony: harmonyScore(pick.items.map((i) => byId.get(i.id)!).filter(Boolean)),
    items: pick.items.map((i) => ({ id: i.id, slot: i.slot, label: rowsById.get(i.id) ? itemLabel(rowsById.get(i.id)!) : i.slot, thumbUrl: thumbs.get(i.id) ?? null })),
  }));
}

export async function persistOutfits(ctx: AuthedContext, state: WardrobeState, outfits: OutfitPick[], occasion: Occasion, name: string): Promise<LookOutfit[]> {
  const saved: { outfitId: string; pick: OutfitPick }[] = [];
  for (const pick of outfits) {
    const row = must(
      await ctx.supabase.from("outfits").insert({ user_id: ctx.userId, occasion, source: "rules", name }).select("id").single(),
      "Save outfit",
    ) as { id: string };
    must(
      await ctx.supabase.from("outfit_items").insert(pick.items.map((i) => ({ outfit_id: row.id, item_id: i.id, slot: i.slot, user_id: ctx.userId }))),
      "Save outfit items",
    );
    saved.push({ outfitId: row.id, pick });
  }
  return describeOutfits(ctx, state, saved);
}

/** "Complete the look": outfits built around one item the user picked. Rules only, so it is free. */
export async function completeLook(ctx: AuthedContext, itemId: string, occasion: Occasion, city?: string) {
  const profile = must(await ctx.supabase.from("profiles").select("home_city").eq("id", ctx.userId).single(), "Load profile") as { home_city: string | null };
  const where = city || profile.home_city || "";
  const weather = where ? await getForecast(where, todayIST()) : null;
  const state = await loadWardrobe(ctx, occasion, weather);
  const anchor = state.all.find((c) => c.id === itemId);
  if (!anchor) throw errors.notFound("Item");
  const taste = await loadTaste(ctx, state).catch(() => null);
  const picks = completeTheLook(state.all, itemId, occasion, climateOf(weather), 3, (p) => tasteScore(taste, p));
  const name = `Built around my ${anchor.colors[0] ?? ""} ${anchor.subcategory ?? anchor.category}`.replace(/\s+/g, " ");
  const outfits = await persistOutfits(ctx, state, picks, occasion, name);
  const message = outfits.length
    ? `${outfits.length} way${outfits.length === 1 ? "" : "s"} to wear it for ${OCCASIONS[occasion].label.toLowerCase()}.`
    : anchor.category === "top"
      ? "Add a bottom to your wardrobe to build a look around this."
      : anchor.category === "bottom"
        ? "Add a top to your wardrobe to build a look around this."
        : "Add a top and a bottom to build a look around this.";
  return { message, weather, outfits };
}

/** Shop Scan: GET IT / MAYBE / SKIP IT for a piece the user is thinking of buying. */
export async function scanPurchase(ctx: AuthedContext, input: ScanInput) {
  const state = await loadWardrobe(ctx, "other", null);
  const result = shopScan(state.all, input);
  const rowsById = new Map(state.rows.map((r) => [r.id, r]));
  const show = [...result.bestMatches.map((m) => m.id), ...result.similarOwned.slice(0, 3)];
  const thumbs = new Map((await withImageUrls(ctx.supabase, show.map((id) => rowsById.get(id)!).filter(Boolean))).map((d) => [d.id, d.thumbUrl]));
  const card = (id: string) => ({ id, label: rowsById.get(id) ? itemLabel(rowsById.get(id)!) : "", thumbUrl: thumbs.get(id) ?? null });
  return {
    ...result,
    bestMatches: result.bestMatches.map((m) => ({ ...card(m.id), score: m.score })),
    similarOwned: result.similarOwned.slice(0, 3).map(card),
    itemCount: state.all.length,
  };
}

const TODAY_LABEL = "Today's outfit";

/** Weekdays default to office, weekends to casual (IST). */
function defaultOccasion(): Occasion {
  const day = new Date(Date.now() + 5.5 * 3600_000).getUTCDay();
  return day === 0 || day === 6 ? "casual" : "office";
}

/**
 * "Today": one outfit for the day from the user's own clothes, the weather and their learned
 * taste. Rules only, so it's instant and free; kept for the day until they shuffle.
 */
export async function todayLook(ctx: AuthedContext, opts: { occasion?: Occasion; shuffle?: boolean } = {}) {
  const day = todayIST();
  const profile = must(await ctx.supabase.from("profiles").select("home_city,body_profile").eq("id", ctx.userId).single(), "Load profile") as {
    home_city: string | null;
    body_profile: { top_size?: string; waist_in?: number } | null;
  };
  const weather = profile.home_city ? await getForecast(profile.home_city, day) : null;
  const { count: avatarPhotos } = await ctx.supabase.from("avatar_photos").select("id", { count: "exact", head: true });
  const { data: planned } = await ctx.supabase.from("planned_outfits").select("outfit_id").eq("day", day).maybeSingle();
  const { data: picked } = await ctx.supabase.from("daily_picks").select("occasion,outfit_id,shuffles,why").eq("day", day).maybeSingle();
  // A planned outfit wins over the automatic pick, until the user shuffles or changes occasion.
  const existing = planned && !opts.shuffle && !opts.occasion
    ? { occasion: picked?.occasion ?? defaultOccasion(), outfit_id: planned.outfit_id, shuffles: picked?.shuffles ?? 0, why: "Planned for today." }
    : picked;
  const occasion = opts.occasion ?? (existing?.occasion as Occasion | undefined) ?? defaultOccasion();
  const state = await loadWardrobe(ctx, occasion, weather);
  const taste = await loadTaste(ctx, state).catch(() => null);
  const climate = climateOf(weather);

  let look: LookOutfit | null = null;
  let previous: string[] = [];
  let shuffles = existing?.shuffles ?? 0;
  const reuse = existing && !opts.shuffle && existing.occasion === occasion;
  if (reuse) {
    const { data: rows } = await ctx.supabase.from("outfit_items").select("item_id,slot").eq("outfit_id", existing.outfit_id);
    const items = ((rows ?? []) as { item_id: string; slot: Category }[]).filter((r) => state.all.some((c) => c.id === r.item_id));
    if (items.length) [look] = await describeOutfits(ctx, state, [{ outfitId: existing.outfit_id, pick: { items: items.map((r) => ({ id: r.item_id, slot: r.slot })), why: existing.why ?? "" } }]);
  }
  if (!look) {
    // A shuffle avoids the pieces just shown and adds a little randomness, so it really changes.
    let avoid = new Set<string>();
    if (opts.shuffle && existing) {
      const { data: rows } = await ctx.supabase.from("outfit_items").select("item_id").eq("outfit_id", existing.outfit_id);
      avoid = new Set(((rows ?? []) as { item_id: string }[]).map((r) => r.item_id));
      previous = [...avoid];
      shuffles += 1;
    }
    const jitter = opts.shuffle ? () => Math.random() * 1.5 : () => 0;
    const bias = (p: Candidate[]) => tasteScore(taste, p) + jitter();
    const fresh = (pool: Candidate[]) => {
      const main = pool.filter((c) => !avoid.has(c.id) || c.category === "shoes");
      return buildRuleOutfits(main.length >= 2 ? main : pool, occasion, climate, 1, undefined, bias);
    };
    let picks = fresh(state.candidates);
    if (!picks.length) picks = closestOutfits(state.all, occasion, climate).slice(0, 1);
    if (picks.length) {
      [look] = await persistOutfits(ctx, state, picks, occasion, TODAY_LABEL);
      must(
        await ctx.supabase.from("daily_picks").upsert({ user_id: ctx.userId, day, occasion, outfit_id: look.outfitId, shuffles, why: look.why }),
        "Save today's pick",
      );
    }
  }

  const forgotten = neglected(state.all).find((c) => !look?.items.some((i) => i.id === c.id));
  const forgottenRow = forgotten ? state.rows.find((r) => r.id === forgotten.id) : undefined;
  const [forgottenCard] = forgottenRow ? await withImageUrls(ctx.supabase, [forgottenRow]) : [];
  return {
    day,
    occasion,
    weather,
    outfit: look,
    shuffles,
    // A tiny wardrobe can only make one combination; say so instead of pretending to shuffle.
    sameAsBefore: Boolean(opts.shuffle && look && previous.length && look.items.every((i) => previous.includes(i.id))),
    itemCount: state.all.length,
    setup: {
      items: state.all.length,
      city: Boolean(profile.home_city),
      sizes: Boolean(profile.body_profile?.top_size || profile.body_profile?.waist_in),
      avatar: (avatarPhotos ?? 0) > 0,
    },
    taste: describeTaste(taste),
    explain: look ? null : explainGap(state.all, occasion, climate),
    forgotten: forgotten && forgottenCard
      ? { id: forgotten.id, label: itemLabel(forgottenRow!), thumbUrl: forgottenCard.thumbUrl, days: forgotten.lastWornDaysAgo }
      : null,
  };
}

/**
 * Shop Scan from a pasted product link: read the shop's page (allow-listed shops only), tag its
 * main photo with the same AI that tags the wardrobe, then judge it against what the user owns.
 */
export async function scanProductLink(ctx: AuthedContext, rawUrl: string) {
  const { IMAGE_HOSTS, SHOP_HOSTS, isAllowedUrl, parseProductMeta } = await import("@/modules/shopping/link");
  const { tagImage, TaggingRejected } = await import("@/modules/jobs/tagger");
  const sharp = (await import("sharp")).default;
  let url = isAllowedUrl(rawUrl, SHOP_HOSTS);
  if (!url) throw errors.badRequest("Paste a product link from a shop like Myntra, AJIO, Amazon, Flipkart, H&M or Zara.");

  // Follow redirects by hand so every hop is re-checked against the allow-list.
  let html = "";
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
      headers: { "user-agent": "Mozilla/5.0 (compatible; Warewise/1.0; +https://warewise.app)", accept: "text/html" },
    });
    if (res.status >= 300 && res.status < 400) {
      const next = isAllowedUrl(new URL(res.headers.get("location") ?? "", url).toString(), SHOP_HOSTS);
      if (!next) throw errors.badRequest("That link redirects outside the shop.");
      url = next;
      continue;
    }
    if (!res.ok) throw new AppError(422, "shop-blocked", "Couldn't read that page", "The shop didn't let us read the product page. Describe the item below instead.");
    html = (await res.text()).slice(0, 1_500_000);
    break;
  }
  const product = parseProductMeta(html, url.toString());
  const imageUrl = product.image ? isAllowedUrl(product.image, IMAGE_HOSTS) : null;
  if (!imageUrl) throw new AppError(422, "no-image", "No product photo found", "We couldn't find the product photo on that page. Describe the item below instead.");

  // The photo's redirects are re-checked too: a CDN may redirect, but only to another allowed host.
  let img = await fetch(imageUrl, { signal: AbortSignal.timeout(10_000), redirect: "manual" });
  for (let hop = 0; hop < 3 && img.status >= 300 && img.status < 400; hop++) {
    const next = isAllowedUrl(new URL(img.headers.get("location") ?? "", imageUrl).toString(), IMAGE_HOSTS);
    if (!next) throw errors.badRequest("The product photo redirects outside the shop.");
    img = await fetch(next, { signal: AbortSignal.timeout(10_000), redirect: "manual" });
  }
  if (!img.ok || !/^image\//.test(img.headers.get("content-type") ?? "")) throw new AppError(422, "no-image", "Couldn't load the product photo", "Describe the item below instead.");
  const raw = Buffer.from(await img.arrayBuffer());
  if (raw.length > 8 * 1024 * 1024) throw errors.badRequest("The product photo is too large.");
  const small = await sharp(raw, { limitInputPixels: 40_000_000 }).resize(768, 768, { fit: "inside" }).webp({ quality: 85 }).toBuffer();

  const { data: count } = await ctx.supabase.rpc("take_usage", { p_kind: "tag_calls", p_cap: 60 });
  if (count === -1) throw errors.quota("You've used today's photo tagging. Describe the item below instead.");
  let tags;
  try {
    tags = (await tagImage(small, { userId: ctx.userId, requestId: ctx.requestId })).tags;
  } catch (err) {
    if (err instanceof TaggingRejected) throw errors.badRequest(err.message);
    throw err;
  }
  const input = { category: tags.category, subcategory: tags.subcategory ?? null, colors: tags.colors.length ? tags.colors : ["multi"], pattern: tags.pattern, formality: tags.formality };
  return { product: { title: product.title, image: imageUrl.toString(), price: product.price, url: url.toString() }, tags: input, ...(await scanPurchase(ctx, input)) };
}
