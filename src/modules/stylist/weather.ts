import "server-only";
import { adminClient } from "@/lib/supabase/admin";
import { log } from "@/modules/platform/log";

export type Weather = {
  city: string;
  date: string;
  tempMaxC: number;
  tempMinC: number;
  rainChancePct: number;
};

const CACHE_HOURS = 3;
const TIMEOUT_MS = 5000;

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
}

// Holiday regions people type that aren't a single town in the geocoder: map to their main town.
const REGION_TOWN: Record<string, string> = {
  goa: "Panjim", kerala: "Kochi", kashmir: "Srinagar", ladakh: "Leh", rajasthan: "Jaipur", himachal: "Shimla",
  "himachal pradesh": "Shimla", sikkim: "Gangtok", andaman: "Port Blair", "andaman and nicobar": "Port Blair",
  coorg: "Madikeri", kodagu: "Madikeri", uttarakhand: "Dehradun", meghalaya: "Shillong", lakshadweep: "Kavaratti",
  pondicherry: "Puducherry", pondy: "Puducherry", "north east": "Guwahati", northeast: "Guwahati",
};

type GeoHit = { latitude: number; longitude: number; name: string; population?: number };

/** India first (Warewise is India-first): the most populous Indian match, else the best worldwide match. */
async function geocode(city: string): Promise<{ lat: number; lon: number; name: string } | null> {
  const name = REGION_TOWN[city.trim().toLowerCase()] ?? city.trim();
  const search = async (country: string) => {
    const url = `https://geocoding-api.open-meteo.com/v1/search?count=10&language=en&format=json&name=${encodeURIComponent(name)}${country}`;
    return ((await fetchJson(url)) as { results?: GeoHit[] }).results ?? [];
  };
  const indian = await search("&countryCode=IN");
  const pick = (hits: GeoHit[]) => [...hits].sort((a, b) => (b.population ?? 0) - (a.population ?? 0))[0];
  // An Indian place with people in it beats a same-named village; otherwise try the world.
  let hit = indian.find((h) => (h.population ?? 0) > 20_000) ? pick(indian) : undefined;
  if (!hit) hit = (await search(""))[0] ?? indian[0];
  return hit ? { lat: hit.latitude, lon: hit.longitude, name: hit.name } : null;
}

/**
 * Forecast for a city and date from Open-Meteo (free, no key), cached for 3 hours in Postgres.
 * Returns null when the date is out of forecast range or the service is down; the stylist then
 * falls back to season-only rules.
 */
export async function getForecast(city: string, date: string): Promise<Weather | null> {
  const key = city.trim().toLowerCase();
  if (!key) return null;
  const db = adminClient();

  const { data: cached } = await db
    .from("weather_cache")
    .select("forecast,fetched_at")
    .eq("location_key", key)
    .eq("date", date)
    .maybeSingle();
  if (cached && Date.now() - new Date(cached.fetched_at).getTime() < CACHE_HOURS * 3600_000) {
    return cached.forecast as Weather;
  }

  try {
    const place = await geocode(city);
    if (!place) return null;
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto` +
      `&start_date=${date}&end_date=${date}`;
    const data = (await fetchJson(url)) as {
      daily?: { temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_probability_max: (number | null)[] };
    };
    if (!data.daily?.temperature_2m_max?.length) return null;
    const weather: Weather = {
      city: place.name,
      date,
      tempMaxC: Math.round(data.daily.temperature_2m_max[0]),
      tempMinC: Math.round(data.daily.temperature_2m_min[0]),
      rainChancePct: data.daily.precipitation_probability_max[0] ?? 0,
    };
    await db.from("weather_cache").upsert({ location_key: key, date, forecast: weather, fetched_at: new Date().toISOString() });
    return weather;
  } catch (err) {
    log("warn", "weather unavailable", { city, date, error: err instanceof Error ? err.message : String(err) });
    return (cached?.forecast as Weather | undefined) ?? null;
  }
}
