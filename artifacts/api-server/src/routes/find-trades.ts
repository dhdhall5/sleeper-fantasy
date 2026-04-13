import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";

// ── Trade Engine — single source of truth for shared types + evaluateTrade ───
import {
  buildServerTeams,
  getTradeIntelligenceTables,
  evaluateTrade,
} from "./trade-engine.js";
import type {
  AssetPlayer,
  AssetPick,
  TeamSummary,
  ArchetypeKey as _ArchetypeKey,
  TradeEvaluationResult,
} from "./trade-engine.js";

// Re-export shared types so trade-matrix.ts continues to import from here
export type { AssetPlayer, AssetPick, TeamSummary };
export { buildServerTeams };

const router = Router();

interface LeagueSettings {
  format: string;
  season: string;
  scoringFormat: string;
  rosterSlots: string;
  valueScale: string;
  leagueName?: string;
}

interface FindTradesRequest {
  myTeamName: string;
  mode: "give" | "get";
  myAssets: (AssetPlayer | AssetPick)[];
  targetAssets?: (AssetPlayer | AssetPick)[];
  // myRoster/myPicks from frontend kept for fallback + asset labelling
  myRoster: AssetPlayer[];
  myPicks: AssetPick[];
  allTeams: TeamSummary[];   // used only if server data unavailable
  teamMode: "WIN_NOW" | "REBUILD" | null;
  leagueSettings?: LeagueSettings;
  wantedPositions?: string[];  // "Get A Player" entry point — what positions the user wants back
}

// ── Step 1 & 2: Team profile engine ──────────────────────────────────────────

const STARTER_SLOTS: Record<string, number> = { QB: 2, RB: 3, WR: 4, TE: 2 };
const THIN_COUNT:    Record<string, number>  = { QB: 2, RB: 4, WR: 5, TE: 1 };
const WEAK_STARTER:  Record<string, number>  = { QB: 3000, RB: 2500, WR: 2000, TE: 2500 };
const SURPLUS_COUNT: Record<string, number>  = { QB: 3, RB: 6, WR: 8, TE: 3 };

interface PositionProfile {
  pos: string;
  count: number;
  starterAvg: number;
  depthCount: number;
  depthTopVal: number;
  quality: "elite" | "strong" | "adequate" | "weak" | "empty";
  isNeed: boolean;
  isSurplus: boolean;
  needScore: number;
  surplusScore: number;
}

// Re-export ArchetypeKey so trade-matrix.ts can still import it from here
export type { ArchetypeKey } from "./trade-engine.js";
// Local alias for use within this file
type ArchetypeKey = import("./trade-engine.js").ArchetypeKey;

export interface TeamProfile {
  teamName: string;
  ownerName: string;
  positions: Record<string, PositionProfile>;
  top2Needs: string[];
  top2Surplus: string[];
  timeline: "WIN_NOW" | "REBUILD" | "BALANCED";
  avgStarterAge: number;
  archetype: ArchetypeKey;
  archetypeLabel: string;
  picks: AssetPick[];
  players: AssetPlayer[];
  leagueRank: number;
  totalValue: number;
}

const ARCHETYPE_DEFAULTS: Record<string, ArchetypeKey> = {
  "The Derk Knights": "strategicrebuilder",
  "Vol_Hall_a":       "middlepack",
  "Deaunuts":         "dynastycontender",
};

const ARCHETYPE_LABELS: Record<ArchetypeKey, string> = {
  dynastycontender:    "🏆 Dynasty Contender",
  winnow:              "⚡ Win Now",
  agingcontender:      "⚠️ Aging Contender",
  risingcontender:     "🚀 Rising Contender",
  middlepack:          "📈 Middle of Pack",
  strategicrebuilder:  "🔨 Strategic Rebuilder",
  accidentalrebuilder: "😬 Accidental Rebuilder",
  transitioning:       "🔄 Transitioning",
};

// Complementary archetype pairs for trade prioritization (higher = better match)
const ARCHETYPE_COMPATIBILITY: Partial<Record<string, Partial<Record<string, number>>>> = {
  winnow:           { strategicrebuilder: 200, transitioning: 100, accidentalrebuilder: 80 },
  dynastycontender: { strategicrebuilder: 150, risingcontender: 80 },
  agingcontender:   { risingcontender: 200, strategicrebuilder: 150, transitioning: 100 },
  risingcontender:  { agingcontender: 200, winnow: 100 },
  transitioning:    { winnow: 100, strategicrebuilder: 80 },
  middlepack:       { strategicrebuilder: 80, agingcontender: 80 },
};

function archetypeCompatibilityBonus(myKey: ArchetypeKey, theirKey: ArchetypeKey): number {
  return ARCHETYPE_COMPATIBILITY[myKey]?.[theirKey] ?? 0;
}

function computeArchetype(
  teamName: string,
  avgStarterAge: number,
  totalValue: number,
  earlyPickCount: number,
  leagueRank: number,
  hasYoungDepth: boolean,
  hasTransitionProfile: boolean,
  hasDecliningKeyPlayers: boolean,
): { key: ArchetypeKey; label: string } {
  if (ARCHETYPE_DEFAULTS[teamName]) {
    const key = ARCHETYPE_DEFAULTS[teamName];
    return { key, label: ARCHETYPE_LABELS[key] };
  }

  // 1. Dynasty Contender: top 3 value + age 24-28 + young depth
  if (leagueRank <= 3 && avgStarterAge >= 24 && avgStarterAge <= 28 && hasYoungDepth)
    return { key: "dynastycontender", label: ARCHETYPE_LABELS.dynastycontender };

  // 2. Win Now: high value + age 29-31 + few picks
  if (leagueRank <= 5 && avgStarterAge >= 29 && avgStarterAge <= 31 && earlyPickCount <= 1)
    return { key: "winnow", label: ARCHETYPE_LABELS.winnow };

  // 3. Aging Contender: was top tier but age 30+ + declining key players
  if (leagueRank <= 7 && avgStarterAge >= 30 && hasDecliningKeyPlayers)
    return { key: "agingcontender", label: ARCHETYPE_LABELS.agingcontender };

  // 4. Rising Contender: young + early picks + decent value (rank ≤ 8)
  if (avgStarterAge <= 26 && earlyPickCount >= 2 && leagueRank <= 8)
    return { key: "risingcontender", label: ARCHETYPE_LABELS.risingcontender };

  // 5. Strategic Rebuilder: low value + multiple early picks + very young
  if (totalValue <= 50000 && earlyPickCount >= 2 && avgStarterAge <= 25)
    return { key: "strategicrebuilder", label: ARCHETYPE_LABELS.strategicrebuilder };

  // 6. Accidental Rebuilder: low value + older + no early picks
  if (totalValue <= 45000 && avgStarterAge >= 28 && earlyPickCount <= 1)
    return { key: "accidentalrebuilder", label: ARCHETYPE_LABELS.accidentalrebuilder };

  // 7. Transitioning: mixed young (≤26) and old (≥30) starters
  if (hasTransitionProfile)
    return { key: "transitioning", label: ARCHETYPE_LABELS.transitioning };

  // 8. Middle of Pack: everything else
  return { key: "middlepack", label: ARCHETYPE_LABELS.middlepack };
}

function posQuality(avg: number): PositionProfile["quality"] {
  return avg === 0 ? "empty" : avg >= 6500 ? "elite" : avg >= 4500 ? "strong" : avg >= 2500 ? "adequate" : "weak";
}

function buildPositionProfile(pos: string, players: AssetPlayer[]): PositionProfile {
  const vals = players
    .filter(p => p.position === pos)
    .map(p => p.value)
    .sort((a, b) => b - a);

  const slots       = STARTER_SLOTS[pos];
  const count       = vals.length;
  const starterV    = vals.slice(0, Math.min(count, slots));
  const benchV      = vals.slice(slots);
  const starterAvg  = starterV.length ? starterV.reduce((s, v) => s + v, 0) / starterV.length : 0;
  const depthCount  = benchV.length;
  const depthTopVal = benchV[0] ?? 0;

  const isNeed = count < THIN_COUNT[pos] || (count <= slots && starterAvg < WEAK_STARTER[pos]);

  const countSurplus    = count >= SURPLUS_COUNT[pos] && depthTopVal >= 2000;
  const qualitySurplus  = count >= slots + 2 && starterAvg >= 5000 && depthTopVal >= 2500;
  const isSurplus       = countSurplus || qualitySurplus;

  return {
    pos, count,
    starterAvg: Math.round(starterAvg), depthCount, depthTopVal,
    quality: posQuality(starterAvg), isNeed, isSurplus,
    needScore:    Math.round(starterAvg + count * 1000),
    surplusScore: Math.round(depthTopVal + depthCount * 1000),
  };
}

export function buildTeamProfile(team: TeamSummary, leagueRank = 7): TeamProfile {
  const positions: Record<string, PositionProfile> = {};
  for (const pos of ["QB","RB","WR","TE"]) {
    positions[pos] = buildPositionProfile(pos, team.players);
  }

  const top2Needs = (["QB","RB","WR","TE"] as const)
    .filter(p => positions[p].isNeed)
    .sort((a, b) => positions[a].needScore - positions[b].needScore)
    .slice(0, 2) as string[];

  const top2Surplus = (["QB","RB","WR","TE"] as const)
    .filter(p => positions[p].isSurplus)
    .sort((a, b) => positions[b].surplusScore - positions[a].surplusScore)
    .slice(0, 2) as string[];

  const top8 = [...team.players].sort((a, b) => b.value - a.value).slice(0, 8);
  const avgAge = top8.length ? Math.round(top8.reduce((s, p) => s + (p.age || 26), 0) / top8.length) : 26;
  const youngHighVal = team.players.filter(p => p.value >= 4000 && (p.age || 26) <= 24).length;
  const oldHighVal   = team.players.filter(p => p.value >= 4000 && (p.age || 26) >= 28).length;
  const timeline: TeamProfile["timeline"] =
    (avgAge >= 28 && oldHighVal >= 3) ? "WIN_NOW" :
    (avgAge <= 24 && youngHighVal >= 2) ? "REBUILD" : "BALANCED";

  // Starter ages
  const skillPos = ["QB","RB","WR","TE"] as const;
  const starterAges: number[] = [];
  const starters: AssetPlayer[] = [];
  for (const pos of skillPos) {
    const sorted = [...team.players].filter(p => p.position === pos).sort((a, b) => b.value - a.value);
    sorted.slice(0, STARTER_SLOTS[pos]).forEach(p => {
      starterAges.push(p.age || 26);
      starters.push(p);
    });
  }
  const avgStarterAge = starterAges.length
    ? Math.round(starterAges.reduce((s, a) => s + a, 0) / starterAges.length) : 26;

  const totalValue = team.players.reduce((s, p) => s + p.value, 0)
                   + team.picks.reduce((s, pk) => s + pk.value, 0);

  // Early picks: value >= 4500 (Early 2nd or better with adjusted values)
  const earlyPickCount = team.picks.filter(pk => pk.value >= 4500).length;

  // Young depth: bench players avg age ≤ 26 + combined bench value ≥ 8000
  const benchPlayers = [...team.players]
    .filter(p => skillPos.includes(p.position as typeof skillPos[number]))
    .sort((a, b) => b.value - a.value)
    .slice(starters.length);
  const youngBench = benchPlayers.filter(p => (p.age || 26) <= 26);
  const hasYoungDepth = youngBench.length >= 2
    && youngBench.reduce((s, p) => s + p.value, 0) >= 8000;

  // Transition profile: has ≥2 young starters (≤26) AND ≥2 old starters (≥30)
  const youngStarterCount = starters.filter(p => (p.age || 26) <= 26).length;
  const oldStarterCount   = starters.filter(p => (p.age || 26) >= 30).length;
  const hasTransitionProfile = youngStarterCount >= 2 && oldStarterCount >= 2;

  // Declining key players: ≥2 of top-5 starters by value are age ≥ 30
  const top5Starters = [...starters].sort((a, b) => b.value - a.value).slice(0, 5);
  const hasDecliningKeyPlayers = top5Starters.filter(p => (p.age || 26) >= 30).length >= 2;

  const arch = computeArchetype(
    team.teamName, avgStarterAge, totalValue, earlyPickCount,
    leagueRank, hasYoungDepth, hasTransitionProfile, hasDecliningKeyPlayers,
  );

  return {
    teamName: team.teamName, ownerName: team.ownerName,
    positions, top2Needs, top2Surplus, timeline, avgStarterAge,
    archetype: arch.key, archetypeLabel: arch.label,
    picks: team.picks, players: team.players,
    leagueRank, totalValue,
  };
}

// ── Step 3: 8-Category trade matching ────────────────────────────────────────

type TradeCategory =
  | "Veterans-for-Picks"    // Win Now / Aging Contender sells proven vet → Rebuilder gives picks
  | "Stars-for-Youth"       // Rebuilder gives young assets/picks ← Win Now gets proven starter
  | "Depth-Swap"            // Both teams trade positional surplus for a position they need
  | "Window-Extension"      // Rising/Middle of Pack buys proven piece from Win Now
  | "Dynasty-Upgrade"       // Dynasty Contender pays depth/picks for an elite upgrade
  | "Rebuild-Acceleration"  // Strategic Rebuilder sells stable vet for more picks/youth
  | "Identity-Commitment"   // Transitioning / AccidentalRebuilder / MiddlePack commits direction
  | "Value-Bridge";         // No clear archetype synergy — picks bridge the value gap

interface CategoryConfig {
  baseScore: number;
  matchTier: "PERFECT" | "ONE_WAY" | "VALUE";
  matchType: string;  // exact string Claude must use (maps to frontend badge)
  tradeHint: string;  // category-specific guidance injected into Claude prompt
}

const CATEGORY_CONFIG: Record<TradeCategory, CategoryConfig> = {
  "Veterans-for-Picks": {
    baseScore: 10, matchTier: "PERFECT", matchType: "Perfect Match",
    tradeHint: "Classic dynasty trade: MY_TEAM moves a proven veteran to a rebuilder who gets an established contributor; MY_TEAM receives early draft capital to accelerate their rebuild. Both teams advance their timelines simultaneously.",
  },
  "Stars-for-Youth": {
    baseScore: 9, matchTier: "PERFECT", matchType: "Perfect Match",
    tradeHint: "Rebuilder sends high-ceiling young talent or future picks in exchange for a proven difference-maker. The win-now team gets immediate production; the rebuilder gets high-upside assets that fit their timeline.",
  },
  "Depth-Swap": {
    baseScore: 8, matchTier: "PERFECT", matchType: "Perfect Match",
    tradeHint: "Both teams trade a position where they have too many good options for a position where they need more. Identify the specific positions being swapped — this should be a clean bilateral exchange where both rosters visibly improve.",
  },
  "Window-Extension": {
    baseScore: 7, matchTier: "ONE_WAY", matchType: "One Way Match",
    tradeHint: "Rising or middle-of-pack team buys a proven piece to extend or open their competitive window. They give picks or young depth; the other side benefits by acquiring future assets they value more than their aging star.",
  },
  "Dynasty-Upgrade": {
    baseScore: 7, matchTier: "ONE_WAY", matchType: "One Way Match",
    tradeHint: "Dynasty contender pays surplus bench depth or a future pick to lock in an elite player and cement their championship window. The trading partner consolidates depth into a single high-value asset.",
  },
  "Rebuild-Acceleration": {
    baseScore: 6, matchTier: "ONE_WAY", matchType: "One Way Match",
    tradeHint: "Strategic rebuilder converts a stable veteran (not their future cornerstone) into more picks and high-upside youth. The buying team gets a proven starter at a discount because the rebuilder values the timeline assets more.",
  },
  "Identity-Commitment": {
    baseScore: 4, matchTier: "ONE_WAY", matchType: "One Way Match",
    tradeHint: "Team without a clear direction must commit: either sell aging veterans for draft capital (lean rebuild) or sell picks for proven starters (lean contend). Propose a trade that forces and rewards a firm identity choice.",
  },
  "Value-Bridge": {
    baseScore: 2, matchTier: "VALUE", matchType: "Pick Balanced",
    tradeHint: "No direct archetype synergy — use picks on one or both sides to bridge the value gap to within 15%. Identify which team holds more draft capital and build a package around that. The trade still makes both rosters marginally better.",
  },
};

function detectTradeCategory(myKey: ArchetypeKey, theirKey: ArchetypeKey): TradeCategory {
  const winNow    = new Set<ArchetypeKey>(["winnow", "agingcontender"]);
  const rebuilder = new Set<ArchetypeKey>(["strategicrebuilder", "accidentalrebuilder"]);
  const contender = new Set<ArchetypeKey>(["dynastycontender", "risingcontender"]);

  // 1. Classic sell: Win Now / Aging Contender offloads vet to a rebuilder for picks
  if (winNow.has(myKey) && rebuilder.has(theirKey))
    return "Veterans-for-Picks";

  // 2. Rebuilder sends youth/picks to Win Now partner for a proven starter
  if (rebuilder.has(myKey) && winNow.has(theirKey))
    return "Stars-for-Youth";

  // 3. Bilateral positional swap — both contender-tier or middle-of-pack teams (not rebuilder partners)
  if ((contender.has(myKey) || myKey === "middlepack") &&
      (contender.has(theirKey) || theirKey === "middlepack"))
    return "Depth-Swap";

  // 4. Rising Contender / Middle of Pack buys a proven star from a Win Now team
  if ((myKey === "risingcontender" || myKey === "middlepack") && winNow.has(theirKey))
    return "Window-Extension";

  // 5. Dynasty Contender pays surplus depth or picks for an elite upgrade (any partner)
  if (myKey === "dynastycontender")
    return "Dynasty-Upgrade";

  // 6. Strategic Rebuilder sells stable veteran for picks/youth (any partner)
  if (myKey === "strategicrebuilder")
    return "Rebuild-Acceleration";

  // 7. Transitioning / Accidental Rebuilder / Middle of Pack needs identity clarity
  if (myKey === "transitioning" || myKey === "accidentalrebuilder" || myKey === "middlepack")
    return "Identity-Commitment";

  // 8. Fallback — picks bridge the value gap
  return "Value-Bridge";
}

interface TradeMatch {
  profile: TeamProfile;
  team: TeamSummary;
  bidirectionalScore: number;
  myFillsTheirNeeds: string[];
  theirFillsMyNeeds: string[];
  primaryOfferPos: string;
  primaryAskPos: string;
  matchTier: "PERFECT" | "ONE_WAY" | "VALUE";
  tradeCategory: TradeCategory;
  hasMismatch: boolean;
  mismatchNote: string;
}

export function detectArchetypeMismatch(profile: TeamProfile): { hasMismatch: boolean; note: string } {
  const { archetype, avgStarterAge, players, picks, totalValue } = profile;

  // Rebuilder sitting on aging veterans — they should be selling but aren't
  if ((archetype === "strategicrebuilder" || archetype === "accidentalrebuilder") && avgStarterAge >= 27) {
    return { hasMismatch: true, note: `Rebuilder with aging starters (avg ${avgStarterAge.toFixed(1)} yrs) — motivated to sell veterans` };
  }

  // Win-now team hoarding picks they can't convert to wins
  if ((archetype === "winnow" || archetype === "agingcontender") && picks.length >= 3) {
    return { hasMismatch: true, note: `Win-now team holding ${picks.length} picks — prefers converting to proven starters` };
  }

  // Contender sitting on unused high-value youth (roster space wasted)
  if (archetype === "dynastycontender" || archetype === "risingcontender") {
    const idleYouth = players.filter(p => (p.age ?? 26) <= 23 && p.value >= 3000).length;
    if (idleYouth >= 2) {
      return { hasMismatch: true, note: `Contender with ${idleYouth} high-value youth (≤23) on bench — may trade surplus youth for proven help` };
    }
  }

  // High-value team with a gaping positional hole (likely overloaded elsewhere)
  if (totalValue >= 60000) {
    const weakPos = Object.values(profile.positions).find(pp => pp.quality === "empty" || (pp.quality === "weak" && pp.count === 0));
    if (weakPos) {
      return { hasMismatch: true, note: `High-value team completely thin at ${weakPos.pos} — highly motivated to address this gap` };
    }
  }

  return { hasMismatch: false, note: "" };
}

function findBidirectionalMatches(myProfile: TeamProfile, allTeams: TeamSummary[], rankMap: Record<string, number>): TradeMatch[] {
  const results: TradeMatch[] = [];
  for (const team of allTeams) {
    if (team.teamName === myProfile.teamName) continue;
    const theirRank    = rankMap[team.teamName] ?? 7;
    const theirProfile = buildTeamProfile(team, theirRank);

    // PRIMARY SIGNAL: archetype-based trade category
    const tradeCategory = detectTradeCategory(myProfile.archetype, theirProfile.archetype);
    const cfg = CATEGORY_CONFIG[tradeCategory];

    // SECONDARY SIGNAL: positional surplus/need overlap boosts score
    const myFillsTheirNeeds = myProfile.top2Surplus.filter(pos => theirProfile.top2Needs.includes(pos));
    const theirFillsMyNeeds = theirProfile.top2Surplus.filter(pos => myProfile.top2Needs.includes(pos));
    const positionalOverlap = myFillsTheirNeeds.length + theirFillsMyNeeds.length;

    let score = cfg.baseScore + positionalOverlap;
    score += archetypeCompatibilityBonus(myProfile.archetype, theirProfile.archetype) / 50;

    const mismatch = detectArchetypeMismatch(theirProfile);
    if (mismatch.hasMismatch) score += 2; // surface mismatch teams within their tier

    const primaryOfferPos = myFillsTheirNeeds[0] || myProfile.top2Surplus[0] || "WR";
    const primaryAskPos   = theirFillsMyNeeds[0] || theirProfile.top2Surplus[0] || "RB";

    results.push({
      profile: theirProfile, team, bidirectionalScore: score,
      myFillsTheirNeeds, theirFillsMyNeeds,
      primaryOfferPos, primaryAskPos,
      matchTier: cfg.matchTier, tradeCategory,
      hasMismatch: mismatch.hasMismatch,
      mismatchNote: mismatch.note,
    });
  }

  // Sort: PERFECT → ONE_WAY → VALUE; within tier by score descending
  const tierOrder: Record<string, number> = { PERFECT: 3, ONE_WAY: 2, VALUE: 1 };
  return results.sort((a, b) => {
    const td = tierOrder[b.matchTier] - tierOrder[a.matchTier];
    return td !== 0 ? td : b.bidirectionalScore - a.bidirectionalScore;
  });
}

// ── Step 4: Specific player identification ────────────────────────────────────

interface PlayerSuggestion { name: string; value: number; age: number | null; position: string; }

function pickBestOffer(players: AssetPlayer[], pos: string): PlayerSuggestion | null {
  const atPos = [...players].filter(p => p.position === pos).sort((a, b) => b.value - a.value);
  const candidate = atPos.length >= 2 ? atPos[1] : atPos[0];
  if (!candidate) return null;
  return { name: candidate.name, value: candidate.value, age: candidate.age ?? null, position: pos };
}

function pickBestAsk(players: AssetPlayer[], pos: string): PlayerSuggestion | null {
  const atPos = [...players].filter(p => p.position === pos).sort((a, b) => b.value - a.value);
  const candidate = atPos[0];
  if (!candidate) return null;
  return { name: candidate.name, value: candidate.value, age: candidate.age ?? null, position: pos };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildRosterBlock(players: AssetPlayer[], picks: AssetPick[] = []): string {
  const byPos: Record<string, AssetPlayer[]> = {};
  players.forEach(p => { (byPos[p.position] = byPos[p.position] || []).push(p); });
  const lines = (["QB","RB","WR","TE"] as const).map(pos => {
    const ps = (byPos[pos] || []).sort((a, b) => b.value - a.value);
    return `  ${pos}: ${ps.length ? ps.map(p => `${p.name}(${p.value}${p.age ? `,age:${p.age}` : ""})`).join(", ") : "(none)"}`;
  });
  if (picks.length) lines.push(`  PICKS: ${picks.map(p => `${p.label}(${p.value})`).join(", ")}`);
  return lines.join("\n");
}

function profileSummary(profile: TeamProfile): string {
  const posLines = (["QB","RB","WR","TE"] as const).map(pos => {
    const pp = profile.positions[pos];
    return `  ${pos}: ${pp.count} rostered | starter avg ${pp.starterAvg} (${pp.quality}) | bench: ${pp.depthCount}${pp.isSurplus ? " ← SURPLUS" : ""}${pp.isNeed ? " ← NEED" : ""}`;
  });
  return [
    `Archetype: ${profile.archetypeLabel} | Timeline: ${profile.timeline} | Avg starter age: ${profile.avgStarterAge}`,
    `Top needs:   ${profile.top2Needs.join(", ") || "none identified"}`,
    `Top surplus: ${profile.top2Surplus.join(", ") || "none identified"}`,
    ...posLines,
  ].join("\n");
}

function extractJson(raw: string): unknown {
  const s = raw.trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```\s*$/,"").trim();
  try { return JSON.parse(s); } catch {}
  const i = raw.indexOf("{"), j = raw.lastIndexOf("}");
  if (i !== -1 && j > i) { try { return JSON.parse(raw.slice(i, j + 1)); } catch {} }
  return { parseError: "No JSON found", rawResponse: raw };
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.post("/find-trades", async (req, res) => {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) { res.status(500).json({ error: "ANTHROPIC_API_KEY not set" }); return; }

  const {
    myTeamName,
    mode        = "give",
    myAssets    = [],
    targetAssets = [],
    myRoster    = [],
    myPicks     = [],
    teamMode    = null,
    leagueSettings,
    wantedPositions = [],
  } = req.body as FindTradesRequest;

  const leagueName  = leagueSettings?.leagueName || "Dynasty League";
  const leagueBlock = leagueSettings
    ? `${leagueSettings.format} | ${leagueSettings.scoringFormat} | ${leagueSettings.rosterSlots}`
    : "14-team Dynasty SuperFlex Full PPR | QB, 2RB, 3WR, TE, FLEX, SuperFlex, 15 bench";
  const modeLabel =
    teamMode === "WIN_NOW" ? "WIN NOW — values immediate starters and proven vets" :
    teamMode === "REBUILD" ? "REBUILD — values youth, draft capital, and upside" :
    "BALANCED — weighs current value and future upside equally";

  // ── Fetch trade intelligence tables (includes all server team data) ──────────
  // Tables are cached 5 minutes and built from authoritative Sleeper + FC data.
  let serverTeams: TeamSummary[];
  let tables: import("./trade-engine.js").TradeIntelligenceTables | null = null;
  try {
    tables = await getTradeIntelligenceTables();
    serverTeams = tables.serverTeams;
    console.log(`[find-trades] trade engine tables ready — ${serverTeams.length} teams`);
  } catch (err) {
    req.log.warn({ err }, "Trade engine table build failed — falling back to buildServerTeams");
    try {
      serverTeams = await buildServerTeams();
    } catch {
      serverTeams = (req.body as FindTradesRequest).allTeams || [];
    }
  }

  // ── Compute league value ranks (two-pass) ───────────────────────────────────
  // Pass 1: compute raw total value for each team (players + picks)
  const teamTotals = serverTeams.map(t => ({
    teamName: t.teamName,
    total: t.players.reduce((s, p) => s + p.value, 0) + t.picks.reduce((s, p) => s + p.value, 0),
  })).sort((a, b) => b.total - a.total);
  const rankMap: Record<string, number> = {};
  teamTotals.forEach((t, i) => { rankMap[t.teamName] = i + 1; });

  // Identify my server-side team (match by team name)
  const myServerTeam: TeamSummary =
    serverTeams.find(t => t.teamName === myTeamName) || {
      teamName:  myTeamName,
      ownerName: myTeamName,
      players:   myRoster,   // last-resort fallback to frontend data
      picks:     myPicks,
    };

  let prompt: string;

  // ────────────────────────────────────────────────────────────────────────────
  // GIVE MODE
  // ────────────────────────────────────────────────────────────────────────────
  // Mismatch map populated in GIVE MODE — used to inject into proposals after Claude responds
  const mismatchMap: Record<string, { hasMismatch: boolean; mismatchNote: string }> = {};

  if (mode === "give") {
    if (!myAssets.length) { res.status(400).json({ error: "Select at least one asset" }); return; }

    const myProfile = buildTeamProfile(myServerTeam, rankMap[myTeamName] ?? 7);
    const matches   = findBidirectionalMatches(myProfile, serverTeams, rankMap);

    // Build mismatch map for post-processing
    for (const m of matches) {
      mismatchMap[m.team.teamName] = { hasMismatch: m.hasMismatch, mismatchNote: m.mismatchNote };
    }

    const offerTotalValue = myAssets.reduce((s, a) => s + (a.value || 0), 0);
    const assetsBlock = myAssets.map(a =>
      "position" in a && (a as AssetPlayer).position
        ? `  ${(a as AssetPlayer).position} ${(a as AssetPlayer).name} (val:${a.value}${(a as AssetPlayer).age ? `, age:${(a as AssetPlayer).age}` : ""})`
        : `  Pick: ${(a as AssetPick).label} (val:${a.value})`
    ).join("\n");

    // ── Build locked asset strings (these NEVER change — they are what the user selected) ──
    const lockedAssetNames = myAssets.map(a =>
      "position" in a && (a as AssetPlayer).position
        ? `${(a as AssetPlayer).position} ${(a as AssetPlayer).name}`
        : `Pick: ${(a as AssetPick).label}`
    );
    const lockedAssetsFull = myAssets.map(a =>
      "position" in a && (a as AssetPlayer).position
        ? `${(a as AssetPlayer).position} ${(a as AssetPlayer).name} (val:${a.value}${(a as AssetPlayer).age ? `, age:${(a as AssetPlayer).age}` : ""})`
        : `Pick: ${(a as AssetPick).label} (val:${a.value})`
    ).join(", ");

    const candidateBlocks = matches.slice(0, 8).map((m, i) => {
      const askPlayer    = pickBestAsk(m.team.players, m.primaryAskPos);
      const cfg          = CATEGORY_CONFIG[m.tradeCategory];
      const categoryLabel = `${m.tradeCategory.replace(/-/g, " ")} — ${cfg.matchType}`;

      // Pick capital for value bridging (never for the offer side — that is locked)
      const myPStr    = myServerTeam.picks.slice(0, 4).map(p => `${p.label}(${p.value})`).join(", ") || "none";
      const theirPStr = m.team.picks.slice(0, 4).map(p => `${p.label}(${p.value})`).join(", ") || "none";

      const hint = cfg.tradeHint.replace(/MY_TEAM/g, myTeamName);

      // ── Trade Engine pre-evaluation for this candidate ────────────────────
      let engineBlock = "";
      if (tables) {
        const askAsset = askPlayer
          ? [{ name: askPlayer.name, position: askPlayer.position, nflTeam: "", value: askPlayer.value, age: askPlayer.age }]
          : [];
        try {
          const eng = evaluateTrade(
            myServerTeam, m.team,
            myAssets, askAsset,
            tables,
            myProfile.archetype, m.profile.archetype,
          );
          const trajStr = (tr: Record<string, string>) =>
            Object.entries(tr).map(([n, t]) => `${n}:${t==="RISING"?"🟢":t==="DECLINING"?"🔴":"🟡"}`).join(", ");
          const warnStr = eng.warnings.slice(0, 3).join("; ") || "none";
          const blockPrefix = eng.blocked ? `⛔ BLOCKED — ${eng.blockReason}\n  ` : "";
          engineBlock =
            `Trade Engine Pre-evaluation:${eng.blocked ? " ⛔ PROPOSAL BLOCKED" : ""}\n` +
            `  ${blockPrefix}Fairness score:       ${eng.fairnessScore}/100${eng.blocked ? " (hard-capped — blocked proposal)" : ""}\n` +
            `  Value breakdown:      You give ${eng.valueBreakdown.sendingValue} → Fair range ${eng.valueBreakdown.fairValueLow}–${eng.valueBreakdown.fairValueHigh} (${eng.valueBreakdown.fairRangeReason}) — ${eng.valueBreakdown.withinFairRange ? "✓ WITHIN RANGE" : "⚠ OUTSIDE RANGE"}\n` +
            `  Trajectories given:   ${trajStr(eng.trajectories.offered) || "picks only"}\n` +
            `  Motivation alignment: ${eng.motivationAlignmentScore}/100\n` +
            `  Post-trade (sender):  health=${eng.postTradeImpact.sender.rosterHealthScore}/100 | ${eng.postTradeImpact.sender.criticalWarning ? `⛔ CRITICAL — ${eng.postTradeImpact.sender.criticalPositions.join(",")}` : "✓ no critical gaps"} | losingOnlyStarter:${eng.postTradeImpact.sender.losingOnlyStarter}\n` +
            `  Post-trade (receiver):health=${eng.postTradeImpact.receiver.rosterHealthScore}/100 | ${eng.postTradeImpact.receiver.criticalWarning ? `⛔ CRITICAL — ${eng.postTradeImpact.receiver.criticalPositions.join(",")}` : "✓ no critical gaps"} | addressesNeed:${eng.postTradeImpact.receiver.addressesNeed} — ${eng.postTradeImpact.receiver.probability}\n` +
            `  Acceptance likelihood:${eng.acceptanceLikelihood}\n` +
            `  Flags:                ${warnStr}\n` +
            `  Engine explanation:   ${eng.explanation}\n`;
        } catch (e) {
          engineBlock = `Trade Engine Pre-evaluation: (error — ${String(e)})\n`;
        }
      }

      return (
        `### Candidate #${i+1}: ${m.team.teamName} (@${m.profile.ownerName}) [${categoryLabel.toUpperCase()}]\n\n` +
        `Trade category: ${m.tradeCategory}\n` +
        `Category guidance: ${hint}\n\n` +
        `Their profile:\n${profileSummary(m.profile)}\n\n` +
        `Positional overlap:\n` +
        `  My surplus → their need: ${m.myFillsTheirNeeds.join(", ") || "none"}\n` +
        `  Their surplus → my need: ${m.theirFillsMyNeeds.join(", ") || "none"}\n\n` +
        `Best return target:\n` +
        `  Ask: ${askPlayer ? `${askPlayer.position} ${askPlayer.name} (val:${askPlayer.value}${askPlayer.age ? `, age:${askPlayer.age}` : ""})` : `best ${m.primaryAskPos} available`}\n` +
        `  Value gap vs locked offer (${offerTotalValue}): ${askPlayer ? Math.abs(offerTotalValue - askPlayer.value) : "unknown"} — balance with picks\n` +
        `  My pick capital (to sweeten offer if needed):    ${myPStr}\n` +
        `  Their pick capital (to add to their return):     ${theirPStr}\n\n` +
        (engineBlock ? engineBlock + "\n" : "") +
        `Their full roster:\n${buildRosterBlock(m.team.players, m.team.picks)}`
      );
    }).join("\n\n---\n\n");

    prompt = `You are an expert dynasty fantasy football trade analyst for ${leagueName}.

## League
${leagueBlock}

## ${myTeamName} — Mode: ${modeLabel}

## ${myTeamName}'s Profile (server-verified)
${profileSummary(myProfile)}
Roster:
${buildRosterBlock(myServerTeam.players, myServerTeam.picks)}

---

## 🔒 LOCKED ASSETS — MUST APPEAR IN EVERY PROPOSAL'S "YOU SEND" LINE
The user has selected these EXACT assets to trade away. You MUST include ALL of them in the "You send:" portion of EVERY proposal. Do NOT substitute any other player. Do NOT omit any of these assets. Do NOT move them to the "They send:" side.

LOCKED (YOU SEND): ${lockedAssetsFull}
Total locked value: ${offerTotalValue}

These assets are non-negotiable. Every proposal begins with: "You send: ${lockedAssetNames.join(" + ")} [+ picks if needed to balance]"

---

${wantedPositions.length > 0 ? `## 🎯 PREFERRED RETURN POSITIONS: ${wantedPositions.join(", ")}
The user specifically wants to acquire a ${wantedPositions.join(" or ")} player in this trade. When building return packages, strongly prefer including a player at one of these positions rather than just picks.

---

` : ""}## TRADE CANDIDATES — Ranked by 8-Category Archetype Match
Each candidate has a best return target and pick capital. Find the best return package for the locked assets above.

${candidateBlocks || "No candidates found across all 13 other teams."}

---

## TASK

Generate one trade proposal per candidate. MUST return 3–5 proposals total.

Rules:
- CRITICAL #1: Every "proposal" field MUST start with "You send: ${lockedAssetNames.join(", ")} ..." — the locked assets go first, always. Never replace them with other players.
- CRITICAL #2: Return AT LEAST 3 proposals. Fill remaining slots with lower-tier candidates if needed.
- "teamName" and "ownerName" EXACTLY as shown in each Candidate header
- Follow the category guidance — propose a trade that fits the stated archetype dynamic
- Balance picks when FC values differ >10%; use pick capital lines to choose which side adds picks
- "matchType" EXACTLY one of: "Perfect Match", "One Way Match", "Pick Balanced" — from the bracket label
- "tradeCategory" EXACTLY the trade category string (e.g. "Veterans-for-Picks")
- "demandFit": name the specific archetype motive — no generic text
- "sleeperMessage": ${myTeamName}'s voice, names ${lockedAssetNames.join(" and ")} specifically, explains mutual benefit
- "giveValue": total FC value of what ${myTeamName} sends (locked assets + any pick sweetener)
- "getValue": total FC value of what comes back

Respond with ONE raw JSON object only. No markdown.

{
  "proposals": [
    {
      "rank": 1,
      "teamName": "<exact name from Candidate header>",
      "ownerName": "<exact owner from Candidate header>",
      "matchType": "Perfect Match",
      "tradeCategory": "Veterans-for-Picks",
      "demandFit": "1-2 sentences naming the specific archetype motive or gap filled",
      "archetypeFit": "Archetype fit: This trade [makes sense / conflicts] with [teamName]'s [archetype] strategy — one reason",
      "proposal": "You send: ${lockedAssetNames.join(", ")} [+ picks if needed]. They send: [names + picks]. Real names from rosters.",
      "giveValue": 4800,
      "getValue": 5100,
      "valuePctDiff": "+6% in your favor",
      "fairnessMeter": 72,
      "valueFairnessNote": "FC values are within X% — [nearly even / slight overpay / significant overpay]. ${myTeamName} gives [giveValue] / [teamName] gives [getValue].",
      "strategicFairnessNote": "Both teams address a key need — [specific positional or archetype reason each side benefits].",
      "trajectoryFairnessNote": "You send [rising/stable/declining] assets for [rising/stable/declining] — [one sentence on long-term implication].",
      "acceptanceChance": "HIGH",
      "whyTheyAccept": "2 sentences: the archetype need your offer fills + what they move",
      "sleeperMessage": "3-5 friendly sentences for Sleeper chat"
    }
  ]
}`;

    // ── Asset-map verification log (one line per team before AI call) ───────────
    const myTop3Give = myServerTeam.players.slice().sort((a,b)=>b.value-a.value).slice(0,3)
      .map(p=>`${p.name}(${p.position},${p.value})`);
    const myPicksGive = myServerTeam.picks.slice(0,4).map(p=>`${p.label}(${p.value})`);
    console.log(`[asset-map/give] MY "${myTeamName}": top3=[${myTop3Give.join(", ")}] picks=[${myPicksGive.join(", ")||"none"}]`);
    matches.slice(0,8).forEach((m,i) => {
      const top3 = m.team.players.slice().sort((a,b)=>b.value-a.value).slice(0,3)
        .map(p=>`${p.name}(${p.position},${p.value})`);
      const picks = m.team.picks.slice(0,4).map(p=>`${p.label}(${p.value})`);
      console.log(`[asset-map/give] Cand#${i+1} "${m.team.teamName}": top3=[${top3.join(", ")}] picks=[${picks.join(", ")||"none"}]`);
    });

    req.log.info({ mode: "give", matches: matches.length, promptLen: prompt.length }, "find-trades give");
    console.log(`[find-trades/give] ${matches.length} matches for ${myTeamName} | ${prompt.length} chars`);

  // ────────────────────────────────────────────────────────────────────────────
  // GET MODE
  // ────────────────────────────────────────────────────────────────────────────
  } else {
    if (!targetAssets.length) { res.status(400).json({ error: "Select at least one target" }); return; }

    const myProfile = buildTeamProfile(myServerTeam, rankMap[myTeamName] ?? 7);

    // Group targets by owning team — match ownerTeamName against server team names
    const byTeam: Record<string, { assets: (AssetPlayer|AssetPick)[]; team?: TeamSummary }> = {};
    for (const asset of targetAssets) {
      const tn = asset.ownerTeamName || "Unknown";
      if (!byTeam[tn]) {
        // Match by exact name or by ownerName
        const serverMatch = serverTeams.find(t => t.teamName === tn || t.ownerName === tn);
        byTeam[tn] = { assets: [], team: serverMatch };
      }
      byTeam[tn].assets.push(asset);
    }

    const groups = Object.entries(byTeam)
      .filter(([, g]) => g.team)
      .map(([teamName, g]) => {
        const theirProfile  = buildTeamProfile(g.team!, rankMap[g.team!.teamName] ?? 7);
        const targetVal     = g.assets.reduce((s, a) => s + (a.value || 0), 0);
        const myCanOffer    = myProfile.top2Surplus.filter(pos => theirProfile.top2Needs.includes(pos));
        const tradeCategory = detectTradeCategory(myProfile.archetype, theirProfile.archetype);
        return { teamName: g.team!.teamName, ownerName: g.team!.ownerName, assets: g.assets, team: g.team!, theirProfile, targetVal, myCanOffer, tradeCategory };
      });

    const groupBlocks = groups.map((g, i) => {
      const targetsBlock = g.assets.map(a =>
        "position" in a
          ? `  ${(a as AssetPlayer).position} ${(a as AssetPlayer).name} (val:${a.value})`
          : `  Pick: ${(a as AssetPick).label} (val:${a.value})`
      ).join("\n");
      const offerSuggestion = g.myCanOffer.length > 0
        ? g.myCanOffer.map(pos => {
            const p = pickBestOffer(myServerTeam.players, pos);
            return p ? `${p.position} ${p.name} (val:${p.value})` : `best ${pos}`;
          }).join(" + ")
        : "No direct surplus/need overlap — picks may be needed to balance";

      const cfg  = CATEGORY_CONFIG[g.tradeCategory];
      const hint = cfg.tradeHint.replace(/MY_TEAM/g, myTeamName);
      const myPStr    = myServerTeam.picks.slice(0, 4).map(p => `${p.label}(${p.value})`).join(", ") || "none";
      const theirPStr = g.team.picks.slice(0, 4).map(p => `${p.label}(${p.value})`).join(", ") || "none";

      // ── Trade Engine pre-evaluation for this target ─────────────────────
      let engineBlock = "";
      if (tables) {
        // Use the suggested offer player as a proxy for what we'd give
        const suggestedOfferPlayer = g.myCanOffer.length > 0
          ? pickBestOffer(myServerTeam.players, g.myCanOffer[0])
          : null;
        const proxyOffer = suggestedOfferPlayer
          ? [{ name: suggestedOfferPlayer.name, position: suggestedOfferPlayer.position, nflTeam: "", value: suggestedOfferPlayer.value, age: suggestedOfferPlayer.age }]
          : myServerTeam.picks.slice(0, 1).map(pk => ({ label: pk.label, value: pk.value }));
        try {
          const eng = evaluateTrade(
            myServerTeam, g.team,
            proxyOffer, g.assets,
            tables,
            myProfile.archetype, g.theirProfile.archetype,
          );
          const trajStr2 = (tr: Record<string, string>) =>
            Object.entries(tr).map(([n, t]) => `${n}:${t==="RISING"?"🟢":t==="DECLINING"?"🔴":"🟡"}`).join(", ");
          const warnStr2 = eng.warnings.slice(0, 3).join("; ") || "none";
          const blockPrefix2 = eng.blocked ? `⛔ BLOCKED — ${eng.blockReason}\n  ` : "";
          engineBlock =
            `Trade Engine Pre-evaluation:${eng.blocked ? " ⛔ PROPOSAL BLOCKED" : ""}\n` +
            `  ${blockPrefix2}Fairness score:       ${eng.fairnessScore}/100${eng.blocked ? " (hard-capped — blocked)" : ""}\n` +
            `  Value breakdown:      Proxy offer ${eng.valueBreakdown.sendingValue} → Fair range ${eng.valueBreakdown.fairValueLow}–${eng.valueBreakdown.fairValueHigh} (${eng.valueBreakdown.fairRangeReason}) — ${eng.valueBreakdown.withinFairRange ? "✓ WITHIN RANGE" : "⚠ OUTSIDE RANGE"}\n` +
            `  Trajectories (target):${trajStr2(eng.trajectories.requested) || "picks only"}\n` +
            `  Motivation alignment: ${eng.motivationAlignmentScore}/100\n` +
            `  Post-trade (sender):  health=${eng.postTradeImpact.sender.rosterHealthScore}/100 | ${eng.postTradeImpact.sender.criticalWarning ? `⛔ CRITICAL — ${eng.postTradeImpact.sender.criticalPositions.join(",")}` : "✓ no critical gaps"} | losingOnlyStarter:${eng.postTradeImpact.sender.losingOnlyStarter}\n` +
            `  Post-trade (receiver):health=${eng.postTradeImpact.receiver.rosterHealthScore}/100 | ${eng.postTradeImpact.receiver.criticalWarning ? `⛔ CRITICAL — ${eng.postTradeImpact.receiver.criticalPositions.join(",")}` : "✓ no critical gaps"} | addressesNeed:${eng.postTradeImpact.receiver.addressesNeed} — ${eng.postTradeImpact.receiver.probability}\n` +
            `  Acceptance likelihood:${eng.acceptanceLikelihood}\n` +
            `  Flags:                ${warnStr2}\n` +
            `  Engine explanation:   ${eng.explanation}\n`;
        } catch (e) {
          engineBlock = `Trade Engine Pre-evaluation: (error — ${String(e)})\n`;
        }
      }

      return (
        `### Target Team #${i+1}: ${g.teamName} (@${g.ownerName}) [${g.tradeCategory.toUpperCase()}]\n` +
        `Trade category: ${g.tradeCategory}\n` +
        `Category guidance: ${hint}\n\n` +
        `I want from them:\n${targetsBlock}\n` +
        `Total target value: ${g.targetVal}\n\n` +
        `Their profile:\n${profileSummary(g.theirProfile)}\n\n` +
        `My surplus that fills their needs: ${g.myCanOffer.join(", ") || "none identified"}\n` +
        `Suggested give skeleton: ${offerSuggestion}\n` +
        `My pick capital:    ${myPStr}\n` +
        `Their pick capital: ${theirPStr}\n\n` +
        (engineBlock ? engineBlock + "\n" : "") +
        `Their full roster:\n${buildRosterBlock(g.team.players, g.team.picks)}`
      );
    }).join("\n\n---\n\n");

    prompt = `You are an expert dynasty fantasy football trade analyst for ${leagueName}.

## League
${leagueBlock}

## ${myTeamName} — Mode: ${modeLabel}

## ${myTeamName}'s Profile (server-verified)
${profileSummary(myProfile)}
Roster:
${buildRosterBlock(myServerTeam.players, myServerTeam.picks)}

---

## ASSETS ${myTeamName.toUpperCase()} WANTS TO ACQUIRE
Each target is labeled with the archetype-based trade category explaining why this deal makes sense.
Follow the "Category guidance" when building what ${myTeamName} must send.

${groupBlocks || "No valid target teams found."}

---

## TASK

For EACH target team, generate exactly THREE offer options ranked by aggressiveness.

OFFER TIERS (always output all three):
- Option A (LOWBALL): Start simple — the minimum you might get away with. Give ~75–85% of the target's KTC value. Prefer the fewest players possible (ideally 1 player, maybe 1 small pick). Acceptance chance LOW, but worth sending first to anchor the negotiation.
- Option B (FAIR): The realistic open — within 5–10% of KTC parity. Use 1–2 players + picks only when needed to reach parity. Acceptance chance MEDIUM to HIGH.
- Option C (OVERPAY): Add an extra piece to guarantee serious consideration if you really want this player. Give ~110–120% of target value. Acceptance chance HIGH.

PACKAGING RULES:
- Start with the fewest players that reach the value tier — do NOT bundle extra players before picks.
- Prefer picks over extra players as value fillers once you have a core 1–2 player offer.
- Never include more than 3 players total in a single offer option.
- Always show exact KTC value for what you give and what you get.

COUNTER-OFFER RULE (for the "What if they say no?" button shown to users):
- The counter is always a sweetened version of Option B FROM YOUR SIDE — add a small pick or upgrade one of your offered players. Never remove any asset from their side.

Rules:
- "teamName" and "ownerName" EXACTLY as shown in each Target Team header
- Follow the category guidance — build packages that fit the archetype dynamic
- "matchType": use "Perfect Match" for bidirectional archetype synergy, "One Way Match" if one-sided, "Pick Balanced" if picks are the primary bridge
- "tradeCategory" must be EXACTLY the trade category string from the Candidate

Respond with ONE raw JSON object only. No markdown.

{
  "proposals": [
    {
      "rank": 1,
      "teamName": "<exact name from Target Team header>",
      "ownerName": "<exact owner from Target Team header>",
      "matchType": "Perfect Match",
      "tradeCategory": "Depth-Swap",
      "demandFit": "1-2 sentences: the archetype motive driving this deal",
      "archetypeFit": "Archetype fit: This trade [makes sense / conflicts] with [teamName]'s [archetype] strategy — one reason",
      "whyTheyAccept": "2 sentences: archetype reason they move + need your offer fills",
      "options": [
        {
          "label": "A",
          "aggressiveness": "lowball",
          "title": "Option A — Lowball (Best Case)",
          "proposal": "You send: [1-2 players/picks, minimal]. They send: [targeted assets]. Real names only.",
          "giveValue": 4200,
          "getValue": 5000,
          "valuePctDiff": "-16% (you give less)",
          "ktcDiffNote": "You give 800 less KTC value — anchors negotiation in your favor",
          "acceptanceChance": "LOW",
          "sleeperMessage": "2-3 sentences for Sleeper chat, friendly tone"
        },
        {
          "label": "B",
          "aggressiveness": "fair",
          "title": "Option B — Fair Offer (Most Likely Accepted)",
          "proposal": "You send: [balanced package]. They send: [targeted assets]. Real names only.",
          "giveValue": 5100,
          "getValue": 5000,
          "valuePctDiff": "+2% in their favor",
          "ktcDiffNote": "Nearly even — within 5% of KTC parity, fair for both sides",
          "acceptanceChance": "HIGH",
          "sleeperMessage": "3-4 sentences for Sleeper chat, highlighting mutual benefit"
        },
        {
          "label": "C",
          "aggressiveness": "overpay",
          "title": "Option C — Overpay (If You Really Want Him)",
          "proposal": "You send: [upgraded package, extra pick or better player]. They send: [targeted assets]. Real names only.",
          "giveValue": 5800,
          "getValue": 5000,
          "valuePctDiff": "-14% (you overpay)",
          "ktcDiffNote": "You give 800 more KTC value — maximizes acceptance chance",
          "acceptanceChance": "HIGH",
          "sleeperMessage": "3-4 sentences for Sleeper chat, urgent win-now tone"
        }
      ]
    }
  ]
}`;

    // ── Asset-map verification log ────────────────────────────────────────────
    const myTop3Get = myServerTeam.players.slice().sort((a,b)=>b.value-a.value).slice(0,3)
      .map(p=>`${p.name}(${p.position},${p.value})`);
    const myPicksGet = myServerTeam.picks.slice(0,4).map(p=>`${p.label}(${p.value})`);
    console.log(`[asset-map/get] MY "${myTeamName}": top3=[${myTop3Get.join(", ")}] picks=[${myPicksGet.join(", ")||"none"}]`);
    groups.forEach((g,i) => {
      const top3 = g.team.players.slice().sort((a,b)=>b.value-a.value).slice(0,3)
        .map(p=>`${p.name}(${p.position},${p.value})`);
      const picks = g.team.picks.slice(0,4).map(p=>`${p.label}(${p.value})`);
      console.log(`[asset-map/get] Target#${i+1} "${g.teamName}": top3=[${top3.join(", ")}] picks=[${picks.join(", ")||"none"}]`);
    });

    req.log.info({ mode: "get", groups: groups.length, promptLen: prompt.length }, "find-trades get");
    console.log(`[find-trades/get] ${groups.length} target groups for ${myTeamName} | ${prompt.length} chars`);
  }

  // ── Call Claude ────────────────────────────────────────────────────────────
  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 3200,
      messages: [{ role: "user", content: prompt }],
    });

    const rawText = message.content
      .filter(b => b.type === "text")
      .map(b => (b as { type: "text"; text: string }).text)
      .join("");

    console.log(`[find-trades/${mode}] raw (first 300): ${rawText.slice(0, 300)}`);

    const result = extractJson(rawText) as { proposals?: { proposal?: string; teamName?: string; hasMismatch?: boolean; mismatchNote?: string }[] };
    const myNS   = buildTeamProfile(myServerTeam, rankMap[myTeamName] ?? 7);

    // Server-side proposal validation for GIVE MODE:
    // Reject any proposal where none of the locked asset names appear in the proposal text.
    const selectedAssetNames = mode === "give"
      ? myAssets.map(a => {
          if ("position" in a && (a as AssetPlayer).position) {
            const nm = (a as AssetPlayer).name;
            // Use last name for matching (more robust to "B. Hall" vs "Breece Hall")
            const parts = nm.trim().split(/\s+/);
            return parts[parts.length - 1].toLowerCase();
          }
          return (a as AssetPick).label.toLowerCase();
        })
      : [];

    if (mode === "give" && selectedAssetNames.length && Array.isArray(result?.proposals)) {
      const beforeCount = result.proposals.length;
      result.proposals = result.proposals.filter(p => {
        if (!p.proposal) return false;
        const text = p.proposal.toLowerCase();
        // At least one locked asset name must appear in the "You send:" portion
        const sendPart = text.split("they send:")[0] || text;
        return selectedAssetNames.some(name => sendPart.includes(name));
      });
      const filtered = beforeCount - result.proposals.length;
      if (filtered > 0) {
        console.warn(`[find-trades/give] VALIDATION: filtered ${filtered}/${beforeCount} proposals that did not include locked assets`);
      }
    }

    // Inject mismatch data from the pre-computed map (GIVE MODE only)
    if (mode === "give" && Object.keys(mismatchMap).length && Array.isArray(result?.proposals)) {
      for (const p of result.proposals) {
        const mm = p.teamName ? mismatchMap[p.teamName] : undefined;
        if (mm) { p.hasMismatch = mm.hasMismatch; p.mismatchNote = mm.mismatchNote; }
      }
    }

    res.json({
      findTradesResult: result,
      mode,
      selectedAssets: mode === "give"
        ? myAssets.map(a =>
            "position" in a && (a as AssetPlayer).position
              ? { name: (a as AssetPlayer).name, position: (a as AssetPlayer).position, value: a.value }
              : { name: (a as AssetPick).label, position: "PICK", value: a.value }
          )
        : [],
      myProfile: {
        top2Needs:   myNS.top2Needs,
        top2Surplus: myNS.top2Surplus,
        timeline:    myNS.timeline,
      },
    });
  } catch (err) {
    req.log.error({ err }, "Error in /api/find-trades");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
