import { Router } from "express";

const router = Router();

const LEAGUE_ID = "1312890569210478592";
const BASE = "https://api.sleeper.app/v1";

const CORE_TTL_MS    = 30 * 60 * 1000; // 30 minutes
const PLAYERS_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ── Types ──────────────────────────────────────────────────────────────────

interface TradedPick {
  season: string;
  round: number;
  roster_id: number;
  owner_id: number;
  previous_owner_id: number;
}

interface Draft {
  draft_id: string;
  season: string;
  status: string;
  type?: string;
  settings?: { rounds?: number; teams?: number };
  slot_to_roster_id?: Record<string, number>;
  draft_order?: Record<string, number>;
}

interface Roster {
  roster_id: number;
  owner_id: string;
  players?: string[];
  starters?: string[];
  settings?: Record<string, number>;
}

interface PickAsset {
  pickId: string;
  season: string;
  round: number;
  originalRosterId: number;
  currentRosterId: number;
  isOwn: boolean;
  slotNum: number | null;
}

// ── Caches ─────────────────────────────────────────────────────────────────

interface CoreData {
  league: Record<string, unknown>;
  rosters: Roster[];
  users: unknown[];
  tradedPicks: TradedPick[];
  drafts: Draft[];
  picksByRosterId: Record<number, PickAsset[]>;
  rounds: number;
  season: string;
  rosterIdToSlot: Record<number, number>;
}

interface PlayersData {
  players: Record<string, unknown>;
}

let coreCache:    { data: CoreData;    fetchedAt: number } | null = null;
let playersCache: { data: PlayersData; fetchedAt: number } | null = null;

// ── Pick ownership logic ───────────────────────────────────────────────────

function computePickOwnership(
  rosters: Roster[],
  tradedPicks: TradedPick[],
  drafts: Draft[]
): {
  picksByRosterId: Record<number, PickAsset[]>;
  rounds: number;
  season: string;
  rosterIdToSlot: Record<number, number>;
} {
  const upcomingDraft =
    drafts.find((d) => d.status === "pre_draft") ||
    drafts.find((d) => d.status === "drafting") ||
    drafts[0];

  const rounds = upcomingDraft?.settings?.rounds ?? 4;
  const season = upcomingDraft?.season ?? new Date().getFullYear().toString();

  const rosterIdToSlot: Record<number, number> = {};
  if (upcomingDraft?.slot_to_roster_id) {
    Object.entries(upcomingDraft.slot_to_roster_id).forEach(([slot, rosterId]) => {
      rosterIdToSlot[Number(rosterId)] = Number(slot);
    });
  }

  const pickMap: Record<string, number> = {};
  rosters.forEach((r) => {
    for (let rd = 1; rd <= rounds; rd++) {
      pickMap[`${season}_${rd}_${r.roster_id}`] = r.roster_id;
    }
  });

  tradedPicks.forEach((pick) => {
    if (pick.season < season) return;
    const key = `${pick.season}_${pick.round}_${pick.roster_id}`;
    pickMap[key] = pick.owner_id;
  });

  const picksByRosterId: Record<number, PickAsset[]> = {};
  rosters.forEach((r) => {
    picksByRosterId[r.roster_id] = [];
  });

  Object.entries(pickMap).forEach(([key, currentRosterId]) => {
    const parts = key.split("_");
    const pickSeason = parts[0];
    const round = parseInt(parts[1], 10);
    const originalRosterId = parseInt(parts[2], 10);
    const slotNum = rosterIdToSlot[originalRosterId] ?? null;

    if (!picksByRosterId[currentRosterId]) {
      picksByRosterId[currentRosterId] = [];
    }
    picksByRosterId[currentRosterId].push({
      pickId: `pick__${pickSeason}_${round}_${originalRosterId}`,
      season: pickSeason,
      round,
      originalRosterId,
      currentRosterId,
      isOwn: originalRosterId === currentRosterId,
      slotNum,
    });
  });

  Object.values(picksByRosterId).forEach((picks) => {
    picks.sort(
      (a, b) =>
        a.season.localeCompare(b.season) ||
        a.round - b.round ||
        (a.slotNum ?? 99) - (b.slotNum ?? 99)
    );
  });

  return { picksByRosterId, rounds, season, rosterIdToSlot };
}

// ── Cache fetch helpers ────────────────────────────────────────────────────

export async function fetchCoreData(): Promise<CoreData> {
  if (coreCache && Date.now() - coreCache.fetchedAt < CORE_TTL_MS) {
    return coreCache.data;
  }

  const [leagueRes, rostersRes, usersRes, tradedPicksRes, draftsRes] = await Promise.all([
    fetch(`${BASE}/league/${LEAGUE_ID}`),
    fetch(`${BASE}/league/${LEAGUE_ID}/rosters`),
    fetch(`${BASE}/league/${LEAGUE_ID}/users`),
    fetch(`${BASE}/league/${LEAGUE_ID}/traded_picks`),
    fetch(`${BASE}/league/${LEAGUE_ID}/drafts`),
  ]);

  if (!leagueRes.ok || !rostersRes.ok || !usersRes.ok || !tradedPicksRes.ok || !draftsRes.ok) {
    throw new Error("Failed to fetch core Sleeper data");
  }

  const [league, rosters, users, tradedPicks, drafts] = await Promise.all([
    leagueRes.json() as Promise<Record<string, unknown>>,
    rostersRes.json() as Promise<Roster[]>,
    usersRes.json() as Promise<unknown[]>,
    tradedPicksRes.json() as Promise<TradedPick[]>,
    draftsRes.json() as Promise<Draft[]>,
  ]);

  // Fetch draft detail for slot_to_roster_id
  const upcomingDraft =
    drafts.find((d) => d.status === "pre_draft") ||
    drafts.find((d) => d.status === "drafting") ||
    drafts[0];

  if (upcomingDraft?.draft_id) {
    const draftRes = await fetch(`${BASE}/draft/${upcomingDraft.draft_id}`);
    if (draftRes.ok) {
      const draftDetail = await draftRes.json() as Draft;
      const idx = drafts.findIndex((d) => d.draft_id === upcomingDraft.draft_id);
      if (idx >= 0 && draftDetail?.slot_to_roster_id) {
        drafts[idx] = { ...drafts[idx], ...draftDetail };
      }
    }
  }

  const { picksByRosterId, rounds, season, rosterIdToSlot } = computePickOwnership(
    rosters,
    tradedPicks,
    drafts
  );

  const data: CoreData = {
    league,
    rosters,
    users,
    tradedPicks,
    drafts,
    picksByRosterId,
    rounds,
    season,
    rosterIdToSlot,
  };

  coreCache = { data, fetchedAt: Date.now() };
  return data;
}

export async function fetchPlayersData(): Promise<PlayersData> {
  if (playersCache && Date.now() - playersCache.fetchedAt < PLAYERS_TTL_MS) {
    return playersCache.data;
  }

  const res = await fetch(`${BASE}/players/nfl`);
  if (!res.ok) throw new Error(`Sleeper players API returned ${res.status}`);

  const players = await res.json() as Record<string, unknown>;
  const data: PlayersData = { players };
  playersCache = { data, fetchedAt: Date.now() };
  return data;
}

// ── Routes ─────────────────────────────────────────────────────────────────

// Fast core data endpoint — no player dict, cached 30 min
router.get("/league", async (req, res) => {
  try {
    const data = await fetchCoreData();
    res.json({ ...data, cachedAt: coreCache?.fetchedAt });
  } catch (err) {
    req.log.error({ err }, "Error fetching core league data");
    res.status(502).json({ error: "Failed to fetch league data" });
  }
});

// Heavy players dict — cached separately for 30 min
router.get("/players", async (req, res) => {
  try {
    const data = await fetchPlayersData();
    res.json({ ...data, cachedAt: playersCache?.fetchedAt });
  } catch (err) {
    req.log.error({ err }, "Error fetching players data");
    res.status(502).json({ error: "Failed to fetch players data" });
  }
});

export default router;
