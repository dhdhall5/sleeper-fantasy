import { Router } from "express";

const router = Router();

// Primary: FC with pick values included
const FC_URL =
  "https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=2&ppr=1&includePickValues=true";

// KTC fallback (best-effort JSON endpoint)
const KTC_URL =
  "https://api.keeptradecut.com/dynasty-rankings?format=2&leagueSize=14&QB=2";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// ── Types ────────────────────────────────────────────────────────────────────

export interface FcEntry {
  player: {
    sleeperId?: string;
    name?: string;
    position?: string;
    maybeTeam?: string;
  };
  value: number;
  overallRank: number;
  positionRank: number;
  trend30Day?: number;
}

interface KtcPlayer {
  playerName?: string;
  slug?: string;
  position?: string;
  team?: string;
  superflexValues?: { value?: number; rank?: number };
  value?: number;            // some KTC formats use top-level value
  sleeperId?: string;
}

export interface ValuesPayload {
  players: FcEntry[];
  /** FC pick values keyed by season → round → average value */
  pickValues: Record<string, Record<number, number>>;
  source: "FantasyCalc" | "KeepTradeCut" | "estimated";
  fetchedAt: number;
}

let cache: ValuesPayload | null = null;

// ── Pick-name parser ─────────────────────────────────────────────────────────
// FC pick names look like "2026 1st", "2027 2nd", "2028 1st"
// Pick entries have position === "PICK" and sleeperId like "FP_2027_1"
function parsePickEntry(entry: FcEntry): { season: string; round: number } | null {
  const name = entry.player.name || "";
  const pos  = entry.player.position || "";
  const sid  = entry.player.sleeperId || "";
  // Only process pick entries
  if (pos !== "PICK" && !sid.startsWith("FP_")) return null;
  const yearM  = name.match(/\b(20\d\d)\b/);
  const roundM = name.match(/\b(1st|2nd|3rd|4th|1|2|3|4)\b/i);
  if (!yearM || !roundM) return null;
  const season = yearM[1];
  const rs     = roundM[1].toLowerCase();
  const round  = (rs === "1st" || rs === "1") ? 1
               : (rs === "2nd" || rs === "2") ? 2
               : (rs === "3rd" || rs === "3") ? 3 : 4;
  return { season, round };
}

function buildPickValues(fcData: FcEntry[]): Record<string, Record<number, number>> {
  const acc: Record<string, Record<number, number[]>> = {};
  for (const e of fcData) {
    const parsed = parsePickEntry(e);
    if (!parsed) continue;
    const { season, round } = parsed;
    if (!acc[season]) acc[season] = {};
    if (!acc[season][round]) acc[season][round] = [];
    acc[season][round].push(e.value);
  }
  const out: Record<string, Record<number, number>> = {};
  for (const [season, rounds] of Object.entries(acc)) {
    out[season] = {};
    for (const [r, vals] of Object.entries(rounds)) {
      out[season][Number(r)] = Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
    }
  }
  return out;
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function tryFetchFc(): Promise<ValuesPayload | null> {
  try {
    const res = await fetch(FC_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; dynasty-dashboard/1.0)",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`FC ${res.status}`);
    const data = (await res.json()) as FcEntry[];
    if (!Array.isArray(data) || data.length === 0) throw new Error("FC empty");

    console.log(`[fantasycalc] FC OK — ${data.length} entries`);
    return {
      players:    data,
      pickValues: buildPickValues(data),
      source:     "FantasyCalc",
      fetchedAt:  Date.now(),
    };
  } catch (err) {
    console.warn("[fantasycalc] FC failed:", (err as Error).message);
    return null;
  }
}

async function tryFetchKtc(): Promise<ValuesPayload | null> {
  try {
    const res = await fetch(KTC_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; dynasty-dashboard/1.0)",
        Accept: "application/json",
        Referer: "https://keeptradecut.com/",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`KTC ${res.status}`);
    const data = (await res.json()) as KtcPlayer[];
    if (!Array.isArray(data) || data.length === 0) throw new Error("KTC empty");

    console.log(`[fantasycalc] KTC OK — ${data.length} entries`);

    // Normalise KTC format to FcEntry shape so the frontend can use the same buildFcMap
    const players: FcEntry[] = data
      .filter(p => p.sleeperId)
      .map((p, i) => {
        const val = p.superflexValues?.value ?? p.value ?? 0;
        return {
          player: {
            sleeperId: p.sleeperId,
            name: p.playerName,
            position: p.position,
            maybeTeam: p.team,
          },
          value: val,
          overallRank: i + 1,
          positionRank: 0,
        };
      });

    return {
      players,
      pickValues: {}, // KTC doesn't give clean pick values via this endpoint
      source:     "KeepTradeCut",
      fetchedAt:  Date.now(),
    };
  } catch (err) {
    console.warn("[fantasycalc] KTC failed:", (err as Error).message);
    return null;
  }
}

async function getValues(): Promise<ValuesPayload> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache;

  const fc = await tryFetchFc();
  if (fc) { cache = fc; return cache; }

  const ktc = await tryFetchKtc();
  if (ktc) { cache = ktc; return cache; }

  // Both failed — return empty (frontend uses hardcoded fallback values)
  console.warn("[fantasycalc] all sources failed, returning empty payload");
  cache = { players: [], pickValues: {}, source: "estimated", fetchedAt: Date.now() };
  return cache;
}

// Exported so app.ts can pre-warm on startup
export async function warmFcCache(): Promise<void> {
  await getValues();
}

// Exported so other routes can access the authoritative FC cache
export async function fetchFcValues(): Promise<ValuesPayload> {
  return getValues();
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.get("/fc-values", async (req, res) => {
  try {
    const data = await getValues();
    res.json({
      players:    data.players,
      pickValues: data.pickValues,
      source:     data.source,
      cachedAt:   data.fetchedAt,
      count:      data.players.length,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch values");
    res.status(502).json({ error: "Failed to fetch player values" });
  }
});

export default router;
