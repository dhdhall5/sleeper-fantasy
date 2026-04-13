import { Router } from "express";
import {
  buildServerTeams,
  buildTeamProfile,
  detectArchetypeMismatch,
} from "./find-trades.js";
import type { TeamProfile, AssetPlayer, AssetPick } from "./find-trades.js";

const router = Router();

// ── Types ─────────────────────────────────────────────────────────────────────

interface SurplusTeamEntry {
  teamName: string;
  ownerName: string;
  archetype: string;
  archetypeLabel: string;
  rank: number;
  avgStarterAge: number;
  totalValue: number;
  hasMismatch: boolean;
  mismatchNote: string;
  players: { name: string; position: string; value: number; age: number | null; nflTeam: string }[];
  picks: { label: string; value: number }[];
}

interface TradeMatrix {
  surplusMap: Record<string, SurplusTeamEntry[]>;
  needMap: Record<string, string[]>;
  computedAt: number;
}

// ── Cache (5-minute TTL — matches Sleeper + FC cache windows) ─────────────────

let matrixCache: { data: TradeMatrix; ts: number } | null = null;
const MATRIX_TTL = 300_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function teamToEntry(
  profile: TeamProfile,
  rank: number,
  pos: string,
): SurplusTeamEntry {
  const mm = detectArchetypeMismatch(profile);
  const players: SurplusTeamEntry["players"] =
    pos === "PICK"
      ? []
      : (profile.players as AssetPlayer[])
          .filter(p => p.position === pos)
          .sort((a, b) => b.value - a.value)
          .slice(0, 4)
          .map(p => ({
            name: p.name,
            position: p.position,
            value: p.value,
            age: p.age ?? null,
            nflTeam: p.nflTeam ?? "FA",
          }));

  const picks: SurplusTeamEntry["picks"] =
    pos === "PICK"
      ? (profile.picks as AssetPick[]).slice(0, 4).map(pk => ({ label: pk.label, value: pk.value }))
      : [];

  return {
    teamName:      profile.teamName,
    ownerName:     profile.ownerName,
    archetype:     profile.archetype,
    archetypeLabel: profile.archetypeLabel,
    rank,
    avgStarterAge: profile.avgStarterAge,
    totalValue:    profile.totalValue,
    hasMismatch:   mm.hasMismatch,
    mismatchNote:  mm.note,
    players,
    picks,
  };
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.get("/trade-matrix", async (req, res) => {
  const now = Date.now();
  if (matrixCache && now - matrixCache.ts < MATRIX_TTL) {
    res.json(matrixCache.data);
    return;
  }

  try {
    const serverTeams = await buildServerTeams();

    // Rank teams by total value
    const totals = serverTeams
      .map(t => ({
        teamName: t.teamName,
        total: t.players.reduce((s, p) => s + p.value, 0) + t.picks.reduce((s, p) => s + p.value, 0),
      }))
      .sort((a, b) => b.total - a.total);
    const rankMap: Record<string, number> = {};
    totals.forEach((t, i) => { rankMap[t.teamName] = i + 1; });

    // Build profiles for all teams
    const profiles = serverTeams.map(t => buildTeamProfile(t, rankMap[t.teamName] ?? 7));

    const SKILL_POSITIONS = ["QB", "RB", "WR", "TE"] as const;
    const surplusMap: Record<string, SurplusTeamEntry[]> = {};
    const needMap: Record<string, string[]> = {};

    // Skill-position surplus / need maps
    for (const pos of SKILL_POSITIONS) {
      surplusMap[pos] = profiles
        .filter(p => p.top2Surplus.includes(pos))
        .map(p => teamToEntry(p, rankMap[p.teamName] ?? 7, pos))
        .sort((a, b) => {
          // Mismatch teams first (more motivated to move assets), then by total value
          if (a.hasMismatch !== b.hasMismatch) return a.hasMismatch ? -1 : 1;
          return b.totalValue - a.totalValue;
        });

      needMap[pos] = profiles
        .filter(p => p.top2Needs.includes(pos))
        .map(p => p.teamName);
    }

    // PICK "surplus": teams holding 2+ picks (likely open to converting to players)
    surplusMap["PICK"] = profiles
      .filter(p => p.picks.length >= 2)
      .map(p => teamToEntry(p, rankMap[p.teamName] ?? 7, "PICK"))
      .sort((a, b) => b.picks.length - a.picks.length);

    const data: TradeMatrix = { surplusMap, needMap, computedAt: now };
    matrixCache = { data, ts: now };
    console.log(`[trade-matrix] computed — ${Object.keys(surplusMap).map(k => `${k}:${surplusMap[k].length}`).join(", ")}`);
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Error building trade matrix");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
