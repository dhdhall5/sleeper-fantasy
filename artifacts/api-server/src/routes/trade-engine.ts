/**
 * Trade Intelligence Engine
 *
 * Four data tables built at startup and cached (5-minute TTL):
 *   Table 1 — Player Classification: STARTER / FLEX / DEPTH per player per team
 *   Table 2 — Team Surplus/Need:     SURPLUS / NEED / NEUTRAL per position per team
 *   Table 3 — Fair Value Ranges:     archetype × position scarcity × trajectory multipliers
 *   Table 4 — Post-Trade Impact:     simulated roster after trade, critical warnings
 *
 * One core function: evaluateTrade() runs all four tables and returns a rich
 * evaluation struct that is injected into every AI prompt.
 *
 * All three trade routes (find-trades, analyze-trade, trade-matrix) import from here.
 * This file does NOT import from find-trades.ts — no circular dependencies.
 */

import { fetchCoreData, fetchPlayersData } from "./league.js";
import { fetchFcValues } from "./fantasycalc.js";

// ─────────────────────────────────────────────────────────────────────────────
// Shared types (canonical — find-trades.ts re-exports these for back-compat)
// ─────────────────────────────────────────────────────────────────────────────

export interface AssetPlayer {
  name: string;
  position: string;
  nflTeam: string;
  value: number;
  rank?: number | null;
  age?: number | null;
  yearsExp?: number | null;
  injuryStatus?: string | null;      // Sleeper injury_status: "IR", "PUP", "Out", "Questionable", null
  depthChartOrder?: number | null;   // Sleeper depth_chart_order: 1=starter, 2+=backup; null=unknown
  collegeDraftRound?: number | null; // Sleeper college_draft_round: 1-7 or null (UDFA)
  trend30Day?: number | null;        // FantasyCalc 30-day value trend
  ownerTeamName?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Trajectory — composite signal from age, Sleeper status, FC trend, pedigree
// ─────────────────────────────────────────────────────────────────────────────

export type Trajectory = "RISING" | "STABLE" | "DECLINING";

export function computeTrajectory(p: AssetPlayer): Trajectory {
  const age        = p.age ?? 25;
  const draftRound = p.collegeDraftRound ?? 7;   // 7 = UDFA / unknown
  const dco        = p.depthChartOrder;           // null = unknown depth
  const injSt      = (p.injuryStatus ?? "").toUpperCase();

  // Chronic injury signals (on IR or reserve list)
  const hasChronicInjury = injSt === "IR" || injSt === "PUP";
  // Short-term flags (Q/D) still count as "active" roster members
  const isCurrentlyActive = !hasChronicInjury;
  // NFL starting role: depth_chart_order 1 = starter; null = unknown (assume starter)
  const isNFLStarter = dco == null || dco === 1;
  const isNFLBackup  = dco != null && dco >= 2;
  // High draft pedigree: 1st or 2nd round college pick
  const highPedigree = draftRound <= 2;
  // FC trend: positive trend reinforces RISING, sharp negative trend reinforces DECLINING
  const trend = p.trend30Day ?? 0;

  // ── DECLINING ──────────────────────────────────────────────────────────────
  // Hard age floor
  if (age >= 31) return "DECLINING";
  // Lost starting role AND not young
  if (isNFLBackup && age >= 28) return "DECLINING";
  // Chronic injury AND not young (recurring flag)
  if (hasChronicInjury && age >= 28) return "DECLINING";
  // High-pedigree player whose value has collapsed by age 28 (bust trajectory)
  if (highPedigree && age >= 28 && p.value < 2500) return "DECLINING";
  // Strong negative FC trend for an aging player
  if (age >= 29 && trend < -300) return "DECLINING";

  // ── RISING ─────────────────────────────────────────────────────────────────
  // Classic young secure starter (covers "returning from injury with healthy status now"
  // for any age-27-or-under player currently showing active/healthy)
  if (age <= 27 && isNFLStarter && isCurrentlyActive) return "RISING";
  // Pedigree upside: elite draft pick still developing (early career, not yet started)
  if (highPedigree && age <= 25 && isCurrentlyActive) return "RISING";
  // Positive FC momentum reinforces RISING for players near the age boundary
  if (age <= 28 && isCurrentlyActive && isNFLStarter && trend > 200) return "RISING";

  // ── STABLE ─────────────────────────────────────────────────────────────────
  // Age 28-30 established starter, age ≤ 27 with injury ceiling concerns (hasChronicInjury),
  // or any other player not meeting RISING/DECLINING thresholds
  return "STABLE";
}

export interface AssetPick {
  label: string;
  value: number;
  ownerTeamName?: string;
}

export interface TeamSummary {
  teamName: string;
  ownerName: string;
  players: AssetPlayer[];
  picks: AssetPick[];
  rosterId?: number;   // Sleeper roster_id — populated by buildServerTeams()
}

export type ArchetypeKey =
  | "dynastycontender"
  | "winnow"
  | "agingcontender"
  | "risingcontender"
  | "middlepack"
  | "strategicrebuilder"
  | "accidentalrebuilder"
  | "transitioning";

// ─────────────────────────────────────────────────────────────────────────────
// Pick value helpers (also used by find-trades.ts — re-exported below)
// ─────────────────────────────────────────────────────────────────────────────

export const ADJUSTED_PICK_VALUES: Record<number, { early: number; mid: number; late: number }> = {
  1: { early: 8500, mid: 7000, late: 5500 },
  2: { early: 4000, mid: 3000, late: 2200 },
  3: { early: 1800, mid: 1400, late: 1000 },
  4: { early:  800, mid:  650, late:  500 },
};

export function pickSlotTier(slotNum: number | null | undefined): "early" | "mid" | "late" {
  if (slotNum == null) return "mid";
  if (slotNum <= 3) return "early";
  if (slotNum <= 7) return "mid";
  return "late";
}

export function adjustedPickValue(round: number, slotNum?: number | null): number {
  const r = Math.min(Math.max(round, 1), 4) as 1 | 2 | 3 | 4;
  const tier = pickSlotTier(slotNum ?? null);
  return ADJUSTED_PICK_VALUES[r][tier];
}

export function pickTierLabel(round: number, tier: "early" | "mid" | "late"): string {
  const ordinal = ["1st", "2nd", "3rd", "4th"][round - 1] || `${round}th`;
  const prefix  = tier === "early" ? "Early" : tier === "mid" ? "Mid" : "Late";
  return `${prefix} ${ordinal}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// buildServerTeams — authoritative roster builder (moved here from find-trades)
// ─────────────────────────────────────────────────────────────────────────────

export async function buildServerTeams(): Promise<TeamSummary[]> {
  const [coreData, playersData, fcData] = await Promise.all([
    fetchCoreData(),
    fetchPlayersData(),
    fetchFcValues(),
  ]);

  const fcMap: Record<string, { value: number; rank: number; position: string; trend30Day: number | null }> = {};
  for (const e of fcData.players) {
    const sid = e.player.sleeperId;
    if (sid && e.player.position !== "PICK") {
      fcMap[sid] = {
        value:      e.value,
        rank:       e.overallRank,
        position:   e.player.position || "—",
        trend30Day: typeof e.trend30Day === "number" ? e.trend30Day : null,
      };
    }
  }

  const rawPlayers = playersData.players as Record<string, Record<string, unknown>>;
  const plMap: Record<string, {
    name:              string;
    age?:              number;
    position:          string;
    team?:             string;
    yearsExp?:         number;
    injuryStatus?:     string;
    depthChartOrder?:  number;
    collegeDraftRound?: number;
  }> = {};
  for (const [id, raw] of Object.entries(rawPlayers)) {
    const fn = String(raw.first_name || "");
    const ln = String(raw.last_name  || "");
    plMap[id] = {
      name:              [fn, ln].filter(Boolean).join(" ") || id,
      age:               raw.age            as number | undefined,
      position:          String(raw.position || "—"),
      team:              raw.team           as string | undefined,
      yearsExp:          raw.years_exp      as number | undefined,
      injuryStatus:      raw.injury_status  as string | undefined,
      depthChartOrder:   raw.depth_chart_order as number | undefined,
      collegeDraftRound: raw.college_draft_round as number | undefined,
    };
  }

  const userMap: Record<string, Record<string, unknown>> = {};
  for (const raw of coreData.users as Record<string, unknown>[]) {
    const uid = raw.user_id as string;
    if (uid) userMap[uid] = raw;
  }

  return coreData.rosters.map(r => {
    const u    = userMap[r.owner_id] || {};
    const meta = u.metadata as Record<string, string> | undefined;
    const teamName  = meta?.team_name  || String(u.display_name || `Team ${r.roster_id}`);
    const ownerName = String(u.display_name || `Manager ${r.roster_id}`);

    const players: AssetPlayer[] = (r.players || []).flatMap((id: string) => {
      const fc  = fcMap[id];
      const pl  = plMap[id];
      const pos = fc?.position || pl?.position || "—";
      if (!["QB", "RB", "WR", "TE"].includes(pos)) return [];
      return [{
        name:              pl?.name || id,
        position:          pos,
        nflTeam:           pl?.team || "FA",
        value:             fc?.value || 200,
        rank:              fc?.rank  || null,
        age:               pl?.age   ?? null,
        yearsExp:          pl?.yearsExp          ?? null,
        injuryStatus:      pl?.injuryStatus      ?? null,
        depthChartOrder:   pl?.depthChartOrder   ?? null,
        collegeDraftRound: pl?.collegeDraftRound  ?? null,
        trend30Day:        fc?.trend30Day         ?? null,
      }];
    });

    const picks: AssetPick[] = (coreData.picksByRosterId[r.roster_id] || []).map(
      (pick: { round: number; slotNum?: number | null; season: string }) => {
        const tier  = pickSlotTier(pick.slotNum);
        const value = adjustedPickValue(pick.round, pick.slotNum);
        const label = pick.slotNum != null
          ? `${pick.season} ${pick.round}.${String(pick.slotNum).padStart(2, "0")} (${pickTierLabel(pick.round, tier)})`
          : `${pick.season} ${pickTierLabel(pick.round, "mid")}`;
        return { label, value };
      }
    );

    return { teamName, ownerName, players, picks, rosterId: r.roster_id };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const STARTER_SLOTS: Record<string, number> = { QB: 2, RB: 3, WR: 4, TE: 2 };
// Thresholds: a player at or above this value counts as "starter quality"
const WEAK_STARTER:  Record<string, number> = { QB: 3000, RB: 2500, WR: 2000, TE: 2500 };
// Surplus count thresholds (legacy compat — used in Table 2 SURPLUS gate)
const SURPLUS_COUNT: Record<string, number> = { QB: 3, RB: 6, WR: 8, TE: 3 };
const THIN_COUNT:    Record<string, number> = { QB: 2, RB: 4, WR: 5, TE: 1 };
// RULE 3: Minimum viable starters per position — trade is blocked only if traded position drops below these
const MIN_VIABLE_STARTERS: Record<string, number> = { QB: 2, RB: 2, WR: 3, TE: 1 };

// ─────────────────────────────────────────────────────────────────────────────
// Table 1 — Player Classification
// ─────────────────────────────────────────────────────────────────────────────

export type Classification = "STARTER" | "FLEX" | "DEPTH";

export interface PlayerClassEntry {
  classification: Classification;
  positionRank: number;  // 1 = best at position on this team
}

/** { teamName → { playerName → PlayerClassEntry } } */
export type ClassificationTable = Record<string, Record<string, PlayerClassEntry>>;

function buildClassificationTable(teams: TeamSummary[]): ClassificationTable {
  const table: ClassificationTable = {};

  for (const team of teams) {
    table[team.teamName] = {};
    const byPos: Record<string, AssetPlayer[]> = {};
    for (const p of team.players) {
      if (!["QB", "RB", "WR", "TE"].includes(p.position)) continue;
      (byPos[p.position] = byPos[p.position] || []).push(p);
    }

    for (const pos of ["QB", "RB", "WR", "TE"]) {
      const sorted = (byPos[pos] || []).sort((a, b) => b.value - a.value);
      const slots  = STARTER_SLOTS[pos];

      sorted.forEach((p, idx) => {
        let classification: Classification;
        // Special SuperFlex rule: top 2 QBs always STARTER regardless of value
        if (pos === "QB" && idx < 2) {
          classification = "STARTER";
        } else if (idx < slots) {
          classification = "STARTER";
        } else if (idx < slots + 2) {
          classification = "FLEX";
        } else {
          classification = "DEPTH";
        }

        table[team.teamName][p.name] = { classification, positionRank: idx + 1 };
      });
    }
  }

  return table;
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 2 — Team Surplus / Need
// ─────────────────────────────────────────────────────────────────────────────

export type PositionStatus = "SURPLUS" | "NEED" | "NEUTRAL";

/** { teamName → { QB: PositionStatus, RB: ..., WR: ..., TE: ... } } */
export type SurplusNeedTable = Record<string, Record<string, PositionStatus>>;

function buildSurplusNeedTable(
  teams: TeamSummary[],
  classTable: ClassificationTable,
): SurplusNeedTable {
  const table: SurplusNeedTable = {};

  for (const team of teams) {
    table[team.teamName] = {};
    const teamClass = classTable[team.teamName] || {};

    for (const pos of ["QB", "RB", "WR", "TE"]) {
      const playersAtPos = team.players.filter(p => p.position === pos);
      const slots = STARTER_SLOTS[pos];
      const count = playersAtPos.length;

      const sorted       = [...playersAtPos].sort((a, b) => b.value - a.value);
      const starterQ     = sorted.filter(p => (p.value || 0) >= WEAK_STARTER[pos]);
      const starterCount = starterQ.length;

      const depthTopVal = sorted[slots] ? sorted[slots].value : 0;

      const isNeed =
        count < THIN_COUNT[pos] ||
        (count <= slots && starterCount < slots);

      const countSurplus   = count >= SURPLUS_COUNT[pos] && depthTopVal >= 2000;
      const qualitySurplus =
        count >= slots + 2 &&
        starterCount >= slots + 1 &&
        depthTopVal >= 2500;
      const isSurplus = countSurplus || qualitySurplus;

      // NEUTRAL: exactly fills starters + has at least one FLEX
      const hasFlexAtPos = Object.entries(teamClass)
        .some(([name, info]) =>
          info.classification === "FLEX" &&
          (playersAtPos.find(p => p.name === name))
        );

      let status: PositionStatus;
      if (isSurplus) {
        status = "SURPLUS";
      } else if (isNeed) {
        status = "NEED";
      } else if (!isSurplus && !isNeed && hasFlexAtPos) {
        status = "NEUTRAL";
      } else {
        status = "NEUTRAL";
      }

      table[team.teamName][pos] = status;
    }
  }

  return table;
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 3 — Fair Value Range (computed per-trade)
// ─────────────────────────────────────────────────────────────────────────────

const POSITION_SCARCITY: Record<string, number> = {
  QB: 1.20,  // SuperFlex QB scarcity
  RB: 1.15,  // Elite RB premium
  WR: 1.00,
  TE: 1.10,
};

const CLASSIFICATION_VARIANCE: Record<Classification, number> = {
  STARTER: 0.10,  // never discount more than 10%
  FLEX:    0.15,  // can vary ±15%
  DEPTH:   0.20,  // can vary ±20%
};

interface FairValueRange {
  lowMultiplier:  number;
  highMultiplier: number;
  reason: string;
}

function computeFairValueRange(
  sendingArchetype: ArchetypeKey,
  receivingArchetype: ArchetypeKey,
  assetClassification: Classification,
  primaryPosition: string,
  assetIsAging: boolean,   // age >= 30
  assetIsRising: boolean,  // age <= 24 and value >= 4000
): FairValueRange {
  const rebuilders = new Set<ArchetypeKey>(["strategicrebuilder", "accidentalrebuilder"]);
  const contenders = new Set<ArchetypeKey>(["dynastycontender", "winnow", "risingcontender"]);
  const winNow     = new Set<ArchetypeKey>(["winnow", "agingcontender"]);

  let baseAdj = 0;
  let reason = "Standard trade";

  if (rebuilders.has(sendingArchetype) && contenders.has(receivingArchetype)) {
    if (assetIsAging) {
      // Rebuilder sends veteran to Contender = FC value ±10%
      baseAdj = 0; reason = "Rebuilder sends veteran to Contender: ±10%";
    } else if (assetIsRising) {
      // Rebuilder sends young stud = FC value +10% premium
      baseAdj = 0.10; reason = "Rebuilder sends young stud: +10% premium";
    }
  } else if (contenders.has(sendingArchetype) && rebuilders.has(receivingArchetype)) {
    // Contender sends picks to Rebuilder = FC value ±5%
    baseAdj = 0; reason = "Contender sends to Rebuilder: ±5%";
  } else if (sendingArchetype === "middlepack") {
    // Middle of Pack targeting starter = FC value +5-10% acceptable overpay
    baseAdj = 0.075; reason = "Middle of Pack targeting starter: +7.5% overpay acceptable";
  } else if (winNow.has(sendingArchetype) && assetIsAging) {
    // Contender sends aging starter = FC value -10% discount acceptable
    baseAdj = -0.10; reason = "Win-now team trades aging starter: -10% discount";
  } else if (sendingArchetype === receivingArchetype) {
    // Same archetype = FC value ±5%
    baseAdj = 0; reason = "Same archetype trades: ±5%";
  } else {
    baseAdj = 0; reason = "Cross-archetype trade: ±10%";
  }

  const variance  = CLASSIFICATION_VARIANCE[assetClassification];
  const posMult   = POSITION_SCARCITY[primaryPosition] ?? 1.0;

  return {
    lowMultiplier:  Math.max(0.80, (1 + baseAdj - variance) * posMult),
    highMultiplier: (1 + baseAdj + variance) * posMult,
    reason,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 4 — Post-Trade Impact
// ─────────────────────────────────────────────────────────────────────────────

export interface PostTradeImpact {
  criticalWarning:    boolean;
  criticalPositions:  string[];  // positions with 0 quality starters after trade
  addressesNeed:      boolean;   // incoming assets help at a NEED position
  losingOnlyStarter:  boolean;   // sending team gives away their only starter at a position
  probability:        "HIGH" | "MEDIUM" | "LOW";
  rosterHealthScore:  number;    // 0-100 — overall post-trade roster health
  blockedReason?:     string;    // set if this leg of the trade violates a hard constraint
  surplusWarnings:    string[];  // non-blocking surplus/need notes
}

function computePostTradeImpact(
  team: TeamSummary,
  classTable: ClassificationTable,
  snTable: SurplusNeedTable,
  assetsLeaving:  (AssetPlayer | AssetPick)[],
  assetsArriving: (AssetPlayer | AssetPick)[],
  isSendingTeam: boolean,   // true = check hard sending constraints; false = check receiving constraints
): PostTradeImpact {
  const teamClass      = classTable[team.teamName] || {};
  const teamSN         = snTable[team.teamName]    || {};
  const leavingPlayers = assetsLeaving.filter(a => "position" in a) as AssetPlayer[];
  const leavingNames   = new Set(leavingPlayers.map(a => a.name));
  const arrivingPlayers = assetsArriving.filter(a => "position" in a) as AssetPlayer[];

  // ── Simulate post-trade roster ──────────────────────────────────────────────
  const simulated = [
    ...team.players.filter(p => !leavingNames.has(p.name)),
    ...arrivingPlayers,
  ];

  const criticalPositions: string[] = [];
  let losingOnlyStarter = false;
  let blockedReason: string | undefined;
  let rosterHealthScore = 100;
  const surplusWarnings: string[] = [];

  // Position weights for health score (total = 100)
  const POS_WEIGHT: Record<string, number> = { QB: 25, RB: 25, WR: 30, TE: 20 };

  // RULE 1: only check positions DIRECTLY involved in the trade
  const tradedPositions = new Set([
    ...leavingPlayers.map(p => p.position),
    ...arrivingPlayers.map(p => p.position),
  ]);

  for (const pos of ["QB", "RB", "WR", "TE"]) {
    const slots = STARTER_SLOTS[pos];

    // ── Before-trade starters ──
    const beforeAtPos    = team.players.filter(p => p.position === pos);
    const beforeStarters = beforeAtPos.filter(p => teamClass[p.name]?.classification === "STARTER");

    // ── After-trade starters ──
    const afterAtPos        = simulated.filter(p => p.position === pos).sort((a, b) => b.value - a.value);
    const afterQuality      = afterAtPos.filter(p => (p.value || 0) >= WEAK_STARTER[pos]);
    const afterViableCount  = afterQuality.length;   // RULE 3: count viable starters (quality-gated)
    const afterStarterCount = Math.min(afterViableCount, slots);

    // ── Health deduction (runs for ALL positions, not just traded ones) ──
    if (afterStarterCount === 0) {
      criticalPositions.push(pos);
      rosterHealthScore -= POS_WEIGHT[pos];
    } else if (afterStarterCount < Math.ceil(slots / 2)) {
      rosterHealthScore -= Math.round(POS_WEIGHT[pos] * 0.5);
    }

    // ── Only-starter check ──
    const lostStartersHere = leavingPlayers
      .filter(p => p.position === pos)
      .filter(p => teamClass[p.name]?.classification === "STARTER");
    if (lostStartersHere.length > 0 && beforeStarters.length === 1) {
      losingOnlyStarter = true;
    }

    // ── RULE 1 + RULE 3: block only if a TRADED position drops below MIN_VIABLE_STARTERS ──
    if (isSendingTeam && tradedPositions.has(pos)) {
      const minViable = MIN_VIABLE_STARTERS[pos];
      if (afterViableCount < minViable) {
        blockedReason = blockedReason ||
          `BLOCKED: ${team.teamName} would have only ${afterViableCount} viable ${pos}(s) after this trade ` +
          `(minimum required: ${minViable})`;
      }
    }
  }

  // ── RULE 5 (converted from hard block to warning): note if receiving into a SURPLUS position ──
  // (Constraint C was previously a hard block — demoted per Rule 3 which limits blocks to minimum violations)
  if (!isSendingTeam && arrivingPlayers.length > 0) {
    const allArrivingAtSurplus = arrivingPlayers.every(p => teamSN[p.position] === "SURPLUS");
    if (allArrivingAtSurplus) {
      const positions = [...new Set(arrivingPlayers.map(p => p.position))].join("/");
      surplusWarnings.push(
        `Note: ${team.teamName} already has depth at ${positions} — incoming players are luxury additions`
      );
    }
  }

  // ── Does incoming package address a NEED position? ──
  const needPositions = Object.entries(teamSN).filter(([, st]) => st === "NEED").map(([pos]) => pos);
  const arrivingPositions = new Set(arrivingPlayers.map(p => p.position));
  const addressesNeed = needPositions.length === 0 || needPositions.some(pos => arrivingPositions.has(pos));
  if (!addressesNeed) rosterHealthScore -= 5;

  // Clamp health score
  rosterHealthScore = Math.max(0, Math.min(100, rosterHealthScore));

  const criticalWarning = criticalPositions.length > 0;

  const probability: PostTradeImpact["probability"] =
    (criticalWarning || losingOnlyStarter || !!blockedReason) ? "LOW" :
    addressesNeed ? "HIGH" : "LOW";

  return {
    criticalWarning, criticalPositions, addressesNeed,
    losingOnlyStarter, probability, rosterHealthScore, blockedReason,
    surplusWarnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tables cache
// ─────────────────────────────────────────────────────────────────────────────

export interface TradeIntelligenceTables {
  classificationTable: ClassificationTable;
  surplusNeedTable:    SurplusNeedTable;
  serverTeams:         TeamSummary[];
  builtAt:             number;
}

const TABLE_TTL = 300_000; // 5 minutes — matches other caches
let tablesCache: { tables: TradeIntelligenceTables; ts: number } | null = null;

export async function getTradeIntelligenceTables(): Promise<TradeIntelligenceTables> {
  const now = Date.now();
  if (tablesCache && now - tablesCache.ts < TABLE_TTL) return tablesCache.tables;

  const serverTeams = await buildServerTeams();
  const classificationTable = buildClassificationTable(serverTeams);
  const surplusNeedTable    = buildSurplusNeedTable(serverTeams, classificationTable);

  const tables: TradeIntelligenceTables = { classificationTable, surplusNeedTable, serverTeams, builtAt: now };
  tablesCache = { tables, ts: now };

  console.log(
    `[trade-engine] tables built — ${serverTeams.length} teams | ` +
    `Class entries: ${Object.values(classificationTable).reduce((s, m) => s + Object.keys(m).length, 0)} | ` +
    `Table2 built: ${Object.keys(surplusNeedTable).length} teams`
  );

  return tables;
}

// ─────────────────────────────────────────────────────────────────────────────
// evaluateTrade — the core function (CHANGE 2)
// ─────────────────────────────────────────────────────────────────────────────

export interface TradeEvaluationResult {
  blocked:    boolean;          // true if a hard roster constraint fires → proposal must be suppressed
  blockReason: string;          // empty string when not blocked
  fairnessScore:          number;  // 0–100 (hard-capped at 50 when sender health is damaged)
  valueBreakdown: {
    sendingValue:         number;
    receivingValue:       number;
    pctDiff:              number;   // + = receive more than send (percentage points)
    withinFairRange:      boolean;
    fairValueLow:         number;
    fairValueHigh:        number;
    fairRangeReason:      string;
    scarcityMultiplier:   number;
  };
  motivationAlignmentScore: number;  // 0–100
  trajectories: {
    offered:   Record<string, Trajectory>;   // name → trajectory for each offered player
    requested: Record<string, Trajectory>;   // name → trajectory for each requested player
  };
  postTradeImpact: {
    sender:   PostTradeImpact;
    receiver: PostTradeImpact;
  };
  acceptanceLikelihood: "HIGH" | "MEDIUM" | "LOW";
  explanation:          string;
  warnings:             string[];
}

export function evaluateTrade(
  sendingTeam:      TeamSummary,
  receivingTeam:    TeamSummary,
  assetsOffered:    (AssetPlayer | AssetPick)[],   // what sending team gives
  assetsRequested:  (AssetPlayer | AssetPick)[],   // what receiving team gives
  tables:           TradeIntelligenceTables,
  sendingArchetype:   ArchetypeKey = "middlepack",
  receivingArchetype: ArchetypeKey = "middlepack",
): TradeEvaluationResult {
  const { classificationTable, surplusNeedTable } = tables;
  const warnings: string[] = [];

  // ── Raw values ────────────────────────────────────────────────────────────
  const sendingValue   = assetsOffered.reduce((s, a)   => s + (a.value || 0), 0);
  const receivingValue = assetsRequested.reduce((s, a) => s + (a.value || 0), 0);
  const maxVal         = Math.max(sendingValue, receivingValue, 1);
  const pctDiff        = Math.round(((receivingValue - sendingValue) / maxVal) * 100);

  const offeredPlayers   = assetsOffered.filter(a   => "position" in a) as AssetPlayer[];
  const requestedPlayers = assetsRequested.filter(a => "position" in a) as AssetPlayer[];

  // ── FIX 1: Composite trajectory signals ───────────────────────────────────
  // Use computeTrajectory() — incorporates age, Sleeper injury status,
  // depth chart order, draft pedigree, and FC 30-day trend.
  const offeredTrajectories:   Record<string, Trajectory> = {};
  const requestedTrajectories: Record<string, Trajectory> = {};

  for (const p of offeredPlayers)   offeredTrajectories[p.name]   = computeTrajectory(p);
  for (const p of requestedPlayers) requestedTrajectories[p.name] = computeTrajectory(p);

  const isOfferRising    = offeredPlayers.some(p   => offeredTrajectories[p.name]   === "RISING");
  const isOfferDeclining = offeredPlayers.some(p   => offeredTrajectories[p.name]   === "DECLINING");
  const isRequestedRising    = requestedPlayers.some(p => requestedTrajectories[p.name] === "RISING");
  const isRequestedDeclining = requestedPlayers.some(p => requestedTrajectories[p.name] === "DECLINING");
  // Legacy alias for Table 3 fair value range (kept for backward compat)
  const isOfferAging = offeredPlayers.some(p => (p.age ?? 26) >= 30);

  // ── Table 1: classify primary offered asset ───────────────────────────────
  const sendingTeamClass = classificationTable[sendingTeam.teamName] || {};
  const primaryOffered   = [...offeredPlayers].sort((a, b) => b.value - a.value)[0];
  const offeredClass: Classification =
    primaryOffered
      ? (sendingTeamClass[primaryOffered.name]?.classification ?? "DEPTH")
      : "DEPTH";

  // ── Table 3: fair value range ─────────────────────────────────────────────
  const primaryPos = primaryOffered?.position || "WR";

  const fairRange = computeFairValueRange(
    sendingArchetype, receivingArchetype,
    offeredClass, primaryPos,
    isOfferAging, isOfferRising,
  );

  const fairValueLow    = Math.round(sendingValue * fairRange.lowMultiplier);
  const fairValueHigh   = Math.round(sendingValue * fairRange.highMultiplier);
  const withinFairRange = receivingValue >= fairValueLow && receivingValue <= fairValueHigh;

  if (!withinFairRange) {
    if (receivingValue < fairValueLow) {
      warnings.push(
        `Value concern: receiving ${receivingValue} is below fair floor of ${fairValueLow} ` +
        `(${fairRange.reason})`
      );
    } else {
      warnings.push(
        `Value bonus: receiving ${receivingValue} exceeds fair ceiling of ${fairValueHigh} ` +
        `(${fairRange.reason})`
      );
    }
  }

  // Trajectory mismatch warnings (composite, not age-only)
  if (isOfferRising && isRequestedDeclining) {
    const risingNames   = offeredPlayers.filter(p => offeredTrajectories[p.name] === "RISING").map(p => p.name);
    const decliningNames = requestedPlayers.filter(p => requestedTrajectories[p.name] === "DECLINING").map(p => p.name);
    warnings.push(
      `Trajectory mismatch: sending RISING asset(s) [${risingNames.join(", ")}] ` +
      `for DECLINING asset(s) [${decliningNames.join(", ")}] — ` +
      `unfavorable regardless of current FC values (composite signal: age+depth+injury+trend)`
    );
  }
  if (isOfferDeclining && isRequestedRising) {
    warnings.push(
      `Trajectory advantage: you are receiving RISING assets for DECLINING assets — ` +
      `favorable long-term trajectory shift`
    );
  }

  // STARTER protection: never accept >10% discount on a STARTER
  if (offeredClass === "STARTER" && receivingValue < sendingValue * 0.90) {
    warnings.push(
      `STARTER protection: you are trading a STARTER-tier asset (${primaryOffered?.name || "player"}) ` +
      `at a discount greater than 10% — re-evaluate`
    );
  }

  // ── FIX 2 / Table 4: post-trade simulation with hard constraints ──────────
  const senderImpact = computePostTradeImpact(
    sendingTeam,   classificationTable, surplusNeedTable,
    assetsOffered, assetsRequested, true,   // isSendingTeam = true
  );
  const receiverImpact = computePostTradeImpact(
    receivingTeam, classificationTable, surplusNeedTable,
    assetsRequested, assetsOffered, false,  // isSendingTeam = false
  );

  // ── Hard constraint resolution ────────────────────────────────────────────
  const blockReason = senderImpact.blockedReason || receiverImpact.blockedReason || "";
  const blocked     = blockReason !== "";

  if (blocked) {
    warnings.unshift(blockReason);   // put block reason first
  }

  if (senderImpact.criticalWarning) {
    warnings.push(
      `CRITICAL WARNING: ${sendingTeam.teamName} will have 0 starters at ` +
      `${senderImpact.criticalPositions.join(", ")} after this trade`
    );
  }
  if (receiverImpact.criticalWarning) {
    warnings.push(
      `CRITICAL WARNING: ${receivingTeam.teamName} will have 0 starters at ` +
      `${receiverImpact.criticalPositions.join(", ")} after this trade`
    );
  }
  if (!receiverImpact.addressesNeed) {
    warnings.push(
      `Low probability flag: this trade does not address ${receivingTeam.teamName}'s active roster needs`
    );
  }
  // Surface surplus warnings (non-blocking — converted from hard block per Rule 3)
  for (const w of receiverImpact.surplusWarnings) warnings.push(w);
  for (const w of senderImpact.surplusWarnings)   warnings.push(w);
  if (senderImpact.losingOnlyStarter) {
    warnings.push(
      `WARNING: ${sendingTeam.teamName} is trading away their only starter at a position — ` +
      `verify backup depth before accepting`
    );
  }

  // ── Motivation alignment (0–100) ─────────────────────────────────────────
  let motivationScore = 50;

  const sendingNeeds = Object.entries(surplusNeedTable[sendingTeam.teamName] || {})
    .filter(([, st]) => st === "NEED").map(([pos]) => pos);
  const sendingAddressesNeed = requestedPlayers.some(p => sendingNeeds.includes(p.position));
  if (sendingAddressesNeed)                              motivationScore += 20;
  if (receiverImpact.addressesNeed)                      motivationScore += 20;
  if (sendingAddressesNeed && receiverImpact.addressesNeed) motivationScore += 10;
  // Composite trajectory mismatch penalty
  if (isOfferRising && isRequestedDeclining)             motivationScore -= 20;
  if (blocked)                                           motivationScore  = Math.min(motivationScore, 20);

  motivationScore = Math.max(0, Math.min(100, motivationScore));

  // ── Fairness score (0–100) ────────────────────────────────────────────────
  // Weights: value fairness 40%, strategic benefit 35%, partner logic 25%
  const absGap = Math.abs(receivingValue - sendingValue);
  const valueFairnessRaw = withinFairRange
    ? Math.round(85 - (absGap / maxVal) * 50)
    : Math.max(20, Math.round(70 - (absGap / maxVal) * 100));

  const partnerLogicScore = receiverImpact.addressesNeed ? 80 : 40;

  let fairnessScore = Math.min(99, Math.max(10, Math.round(
    valueFairnessRaw * 0.40 +
    motivationScore  * 0.35 +
    partnerLogicScore * 0.25
  )));

  // FIX 2: Hard-cap fairness at 50 when the sender's roster health is damaged,
  // and at 15 for a fully blocked proposal — regardless of value parity.
  const senderHealthDamaged = senderImpact.rosterHealthScore < 70 || senderImpact.losingOnlyStarter;
  if (blocked)              fairnessScore = Math.min(fairnessScore, 15);
  else if (senderHealthDamaged) fairnessScore = Math.min(fairnessScore, 50);

  // ── Acceptance likelihood ─────────────────────────────────────────────────
  let acceptanceLikelihood: TradeEvaluationResult["acceptanceLikelihood"] = "MEDIUM";
  if (blocked) {
    acceptanceLikelihood = "LOW";
  } else if (
    receiverImpact.addressesNeed &&
    !receiverImpact.criticalWarning &&
    !receiverImpact.losingOnlyStarter &&
    withinFairRange &&
    !senderHealthDamaged
  ) {
    acceptanceLikelihood = "HIGH";
  } else if (
    receiverImpact.criticalWarning ||
    senderImpact.criticalWarning ||
    senderHealthDamaged ||
    (!receiverImpact.addressesNeed && motivationScore < 50)
  ) {
    acceptanceLikelihood = "LOW";
  }

  // ── Explanation paragraph ─────────────────────────────────────────────────
  const trajLabel = (tr: Trajectory) => tr === "RISING" ? "🟢" : tr === "DECLINING" ? "🔴" : "🟡";
  const offeredDesc   = offeredPlayers.map(p =>
    `${p.name}(${p.position},${trajLabel(offeredTrajectories[p.name])})`
  ).join(", ") || "picks";
  const requestedDesc = requestedPlayers.map(p =>
    `${p.name}(${p.position},${trajLabel(requestedTrajectories[p.name])})`
  ).join(", ") || "picks";

  const rangeLabel = withinFairRange
    ? `within fair value range (${fairValueLow.toLocaleString()}–${fairValueHigh.toLocaleString()})`
    : receivingValue < fairValueLow
    ? `below fair value floor of ${fairValueLow.toLocaleString()}`
    : `above fair value ceiling of ${fairValueHigh.toLocaleString()}`;

  const senderHealthLabel = `sender health=${senderImpact.rosterHealthScore}/100, receiver health=${receiverImpact.rosterHealthScore}/100`;
  const blockLabel = blocked ? ` ⛔ BLOCKED: ${blockReason}.` : "";

  const explanation =
    `${sendingTeam.teamName} offers ${offeredDesc} (FC value: ${sendingValue.toLocaleString()}) ` +
    `for ${requestedDesc} (FC value: ${receivingValue.toLocaleString()}) ` +
    `from ${receivingTeam.teamName}. ` +
    `Exchange is ${rangeLabel} based on ${fairRange.reason}. ` +
    `Roster health: ${senderHealthLabel}. ` +
    `Motivation alignment ${motivationScore}/100 — ` +
    (sendingAddressesNeed
      ? `${sendingTeam.teamName} addresses their ${sendingNeeds.slice(0, 2).join("/") || "positional"} need. `
      : `${sendingTeam.teamName} does not directly address a flagged need. `) +
    (receiverImpact.addressesNeed
      ? `${receivingTeam.teamName} gains at a position of need.`
      : `${receivingTeam.teamName} does not gain at a key need position — acceptance is uncertain.`) +
    blockLabel +
    (warnings.length ? ` Flags: ${warnings.slice(0, 3).join("; ")}.` : "");

  return {
    blocked,
    blockReason,
    fairnessScore,
    valueBreakdown: {
      sendingValue,
      receivingValue,
      pctDiff,
      withinFairRange,
      fairValueLow,
      fairValueHigh,
      fairRangeReason:    fairRange.reason,
      scarcityMultiplier: POSITION_SCARCITY[primaryPos] ?? 1.0,
    },
    motivationAlignmentScore: motivationScore,
    trajectories: { offered: offeredTrajectories, requested: requestedTrajectories },
    postTradeImpact: { sender: senderImpact, receiver: receiverImpact },
    acceptanceLikelihood,
    explanation,
    warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// analyzeAssets — single trade analysis entry point
// Accepts any mix of players/picks from any roster or position need strings.
// Does ALL math server-side; Claude only writes a 3-sentence summary.
// ─────────────────────────────────────────────────────────────────────────────

export interface SelectedAsset {
  name?: string;        // player name or pick label
  position: string;     // QB|RB|WR|TE|PICK
  value: number;
  age?: number | null;
  nflTeam?: string;
  rosterId: number;     // which Sleeper roster_id this asset belongs to
  isPick?: boolean;     // true for draft picks
}

export interface DepthStatus {
  count: number;        // TOTAL rostered players at this position (gaining any player = +1, giving = -1)
  qualityCount: number; // quality-starter count (value ≥ WEAK_STARTER threshold) — used for status/delta
  leagueAvg: number;    // average quality-count across all 14 teams
  delta: number;        // qualityCount − leagueAvg (signed)
  status: "thin" | "average" | "deep";
}

export interface TeamState {
  teamName: string;
  trajectory: "WIN_NOW" | "REBUILD" | "TRANSITIONING";
  trajectoryReason: string;   // human-readable reason for the classification
  avgStarterAge: number;
  avgStarterValue: number;
  depthVsLeague: Record<string, DepthStatus>;    // per position, starter-quality count vs 14-team avg
  surplusPositions: string[];                    // positions with genuine bench depth
  surplusDescriptions: string[];                 // e.g. "WR (8 rostered, bench top-val 4200)"
  needPositions: string[];                       // positions that are thin or low-quality
  needsDescriptions: string[];                   // e.g. "RB (3 rostered, starter avg 2100)"
  totalStarterValue: number;
  rosterHealthScore: number;                     // 0–100 composite health
}

export interface AssetAnalysisResult {
  myTeamName: string;
  theirTeamName: string;

  // ── Layer 1: pre-trade roster state for both teams ─────────────────────────
  preTrade: {
    myTeam: TeamState;
    theirTeam: TeamState;
  };

  // ── Layer 2: the proposed trade (assets + raw values) ─────────────────────
  proposedTrade: {
    myTeamGives: SelectedAsset[];
    theirTeamGives: SelectedAsset[];
    myGiveValue: number;
    theirGiveValue: number;
    valuePctDiff: number;    // positive = I receive more than I give (pct of max side)
    withinTenPct: boolean;
    fairValueLow: number;    // from evaluateTrade scarcity-adjusted range
    fairValueHigh: number;
    scarcityMultiplier: number;
    fairRangeReason: string;
  };

  // ── Layer 3: post-trade simulation for both rosters ────────────────────────
  postTrade: {
    myTeam: TeamState;
    theirTeam: TeamState;
    myTeamImproves: boolean;
    theirTeamImproves: boolean;
    bothTeamsImprove: boolean;
    lopsidedFlag: boolean;       // RULE 5: value differential > 15%
    lopsidedDetail: string;
    adjustmentSuggestion: string;
    mutualBenefitFlag: boolean;  // RULE 6: at least one team does not improve
    mutualBenefitDetail: string;
    // from evaluateTrade hard-block logic (FIX 2)
    blocked: boolean;
    blockReason: string;
    senderHealthScore: number;    // evaluateTrade post-trade health (sender = my team)
    receiverHealthScore: number;  // evaluateTrade post-trade health (receiver = their team)
    acceptanceLikelihood: "HIGH" | "MEDIUM" | "LOW";
  };

  // ── Layer 4: trajectory alignment (team-level + player-level) ─────────────
  trajectoryAlignment: {
    myTeamTrajectory: "WIN_NOW" | "REBUILD" | "TRANSITIONING";
    theirTeamTrajectory: "WIN_NOW" | "REBUILD" | "TRANSITIONING";
    aligned: boolean;
    mismatchFlag: string;
    detail: string;
    // player-level composite trajectories from computeTrajectory() (FIX 1)
    // age + injury + depth-chart + draft pedigree + FC 30-day trend
    playerTrajectoriesOffered:   Record<string, string>;  // name → RISING|STABLE|DECLINING
    playerTrajectoriesRequested: Record<string, string>;
    motivationAlignmentScore: number;  // 0–100 from evaluateTrade
  };

  // ── Layer 5: weighted scores in priority order ─────────────────────────────
  weightedScores: {
    w1_bothImprove:         { score: number; maxScore: number; detail: string };
    w2_valueFair:           { score: number; maxScore: number; detail: string };
    w3_trajectoryAlignment: { score: number; maxScore: number; detail: string };
    w4_positionalScarcity:  { score: number; maxScore: number; detail: string };
    w5_roleChangeImpact:    { score: number; maxScore: number; detail: string };
    overallScore: number;
    overallGrade: "A" | "B" | "C" | "D" | "F";
    fairnessScore: number;   // 0–100 from evaluateTrade (hard-capped when blocked/unhealthy)
  };

  flags: string[];
  engineWarnings: string[];  // evaluateTrade warning strings
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// RULE 4: Team-level trajectory classification:
//   WIN_NOW    = avg starter age < 27 AND avg starter FC value > 6000
//   REBUILD    = avg starter age > 28 OR avg starter FC value < 3000
//   TRANSITIONING = everything else
function _teamTrajectory(
  team: TeamSummary,
  classTable: Record<string, Record<string, { classification: string; positionRank: number }>>,
): { trajectory: "WIN_NOW" | "REBUILD" | "TRANSITIONING"; avgStarterAge: number; avgStarterValue: number; reason: string } {
  const tc = classTable[team.teamName] || {};
  const starters    = team.players.filter(p => tc[p.name]?.classification === "STARTER");
  const ages        = starters.filter(p => p.age != null).map(p => p.age as number);
  const avgStarterAge   = ages.length ? ages.reduce((s, a) => s + a, 0) / ages.length : 25;
  const avgStarterValue = starters.length ? starters.reduce((s, p) => s + p.value, 0) / starters.length : 0;

  let trajectory: "WIN_NOW" | "REBUILD" | "TRANSITIONING";
  let reason: string;

  // RULE 4 — FIX: was (<26, >27); corrected to (<27, >28)
  if (avgStarterAge < 27 && avgStarterValue > 6000) {
    trajectory = "WIN_NOW";
    reason = `avg starter age ${avgStarterAge.toFixed(1)} (<27) AND avg starter value ${Math.round(avgStarterValue)} (>6000)`;
  } else if (avgStarterAge > 28 || avgStarterValue < 3000) {
    trajectory = "REBUILD";
    reason = avgStarterAge > 28
      ? `avg starter age ${avgStarterAge.toFixed(1)} (>28)`
      : `avg starter value ${Math.round(avgStarterValue)} (<3000)`;
  } else {
    trajectory = "TRANSITIONING";
    reason = `avg starter age ${avgStarterAge.toFixed(1)}, avg value ${Math.round(avgStarterValue)} — between thresholds`;
  }
  return { trajectory, avgStarterAge, avgStarterValue, reason };
}

// Starter-quality count per position vs 14-team league average
function _depthVsLeague(
  team: TeamSummary,
  allTeams: TeamSummary[],
): Record<string, DepthStatus> {
  const result: Record<string, DepthStatus> = {};
  for (const pos of ["QB", "RB", "WR", "TE"]) {
    const threshold = WEAK_STARTER[pos];
    // TOTAL count: every player rostered at this position — gaining any player = +1, giving = -1
    const count        = team.players.filter(p => p.position === pos).length;
    // QUALITY count: only players meeting starter-quality threshold — used for status/delta
    const qualityCount = team.players.filter(p => p.position === pos && p.value >= threshold).length;
    const leagueAvg = allTeams.reduce(
      (s, t) => s + t.players.filter(p => p.position === pos && p.value >= threshold).length, 0
    ) / allTeams.length;
    const delta  = qualityCount - leagueAvg;
    const status: "thin" | "average" | "deep" = delta < -0.5 ? "thin" : delta > 0.5 ? "deep" : "average";
    result[pos] = { count, qualityCount, leagueAvg: Math.round(leagueAvg * 10) / 10, delta: Math.round(delta * 10) / 10, status };
  }
  return result;
}

// Detailed needs/surplus identification — mirrors the old computeNeedsSurplus() logic
// Uses THIN_COUNT / WEAK_STARTER / SURPLUS_COUNT / STARTER_SLOTS thresholds
function _detailedNeedsSurplus(players: AssetPlayer[]): {
  needPositions:      string[];
  needsDescriptions:  string[];
  surplusPositions:   string[];
  surplusDescriptions: string[];
} {
  const byPos: Record<string, number[]> = {};
  for (const p of players) {
    if (!["QB", "RB", "WR", "TE"].includes(p.position)) continue;
    (byPos[p.position] = byPos[p.position] || []).push(p.value);
  }

  const needPositions:      string[] = [];
  const needsDescriptions:  string[] = [];
  const surplusPositions:   string[] = [];
  const surplusDescriptions: string[] = [];
  const needScores:   Record<string, number> = {};
  const surplusScores: Record<string, number> = {};

  for (const pos of ["QB", "RB", "WR", "TE"]) {
    const vals       = (byPos[pos] || []).sort((a, b) => b - a);
    const count      = vals.length;
    const slots      = STARTER_SLOTS[pos];
    const starterV   = vals.slice(0, Math.min(count, slots));
    const benchV     = vals.slice(slots);
    const starterAvg = starterV.length ? starterV.reduce((s, v) => s + v, 0) / starterV.length : 0;
    const depthTopVal = benchV[0] ?? 0;
    const depthCount  = benchV.length;

    // NEED: not enough rostered OR poor starter quality
    const isNeed = count < THIN_COUNT[pos] || (count <= slots && starterAvg < WEAK_STARTER[pos]);
    if (isNeed) {
      needPositions.push(pos);
      needsDescriptions.push(`${pos} (${count} rostered, starter avg ${Math.round(starterAvg)})`);
      needScores[pos] = Math.round(starterAvg + count * 1000);
    }

    // SURPLUS: excess with real bench value
    const countSurplus   = count >= SURPLUS_COUNT[pos] && depthTopVal >= 2000;
    const qualitySurplus = count >= slots + 2 && starterAvg >= 5000 && depthTopVal >= 2500;
    if (countSurplus || qualitySurplus) {
      surplusPositions.push(pos);
      surplusDescriptions.push(`${pos} (${count} rostered, bench top-val ${Math.round(depthTopVal)})`);
      surplusScores[pos] = Math.round(depthTopVal + depthCount * 1000);
    }
  }

  needPositions.sort((a, b)    => (needScores[a]    || 0) - (needScores[b]    || 0));
  surplusPositions.sort((a, b) => (surplusScores[b] || 0) - (surplusScores[a] || 0));
  return { needPositions, needsDescriptions, surplusPositions, surplusDescriptions };
}

function _rosterHealth(players: AssetPlayer[]): number {
  let health = 100;
  const POS_WEIGHT: Record<string, number> = { QB: 25, RB: 25, WR: 30, TE: 20 };
  for (const pos of ["QB", "RB", "WR", "TE"]) {
    const slots   = STARTER_SLOTS[pos];
    const quality = players.filter(p => p.position === pos && p.value >= WEAK_STARTER[pos]);
    const filled  = Math.min(quality.length, slots);
    if (filled === 0)                        health -= POS_WEIGHT[pos];
    else if (filled < Math.ceil(slots / 2)) health -= Math.round(POS_WEIGHT[pos] * 0.5);
  }
  return Math.max(0, health);
}

// Build a full TeamState for any TeamSummary (pre- or post-trade)
function _buildTeamState(
  team: TeamSummary,
  allTeams: TeamSummary[],
  classTable: Record<string, Record<string, { classification: string; positionRank: number }>>,
): TeamState {
  const { trajectory, avgStarterAge, avgStarterValue, reason } = _teamTrajectory(team, classTable);
  const depthVsLeague = _depthVsLeague(team, allTeams);
  const { needPositions, needsDescriptions, surplusPositions, surplusDescriptions } = _detailedNeedsSurplus(team.players);
  const tc            = classTable[team.teamName] || {};
  const starters      = team.players.filter(p => tc[p.name]?.classification === "STARTER");
  const totalStarterValue = starters.reduce((s, p) => s + p.value, 0);
  const rosterHealthScore = _rosterHealth(team.players);

  return {
    teamName: team.teamName, trajectory, trajectoryReason: reason,
    avgStarterAge, avgStarterValue, depthVsLeague,
    surplusPositions, surplusDescriptions,
    needPositions, needsDescriptions,
    totalStarterValue, rosterHealthScore,
  };
}

// Map team trajectory to an ArchetypeKey so evaluateTrade() gets sensible context
function _trajectoryToArchetype(t: "WIN_NOW" | "REBUILD" | "TRANSITIONING"): ArchetypeKey {
  if (t === "WIN_NOW")  return "winnow";
  if (t === "REBUILD")  return "strategicrebuilder";
  return "middlepack";
}

// ─────────────────────────────────────────────────────────────────────────────
// analyzeAssets — full analysis pipeline
// All five analytical layers are computed here; Claude gets the result as
// a pre-built data block and writes exactly 3 summary sentences.
// ─────────────────────────────────────────────────────────────────────────────
export async function analyzeAssets(
  selectedAssets: (SelectedAsset | string)[],
  userRosterId: number,
): Promise<AssetAnalysisResult> {
  const tables = await getTradeIntelligenceTables();
  const { classificationTable, serverTeams } = tables;

  // ── Resolve both teams ────────────────────────────────────────────────────
  const myServerTeam = serverTeams.find(t => t.rosterId === userRosterId);
  if (!myServerTeam) throw new Error(`Roster ${userRosterId} not found in trade engine tables`);

  const myAssets    = selectedAssets.filter(a => typeof a !== "string" && (a as SelectedAsset).rosterId === userRosterId)  as SelectedAsset[];
  const theirAssets = selectedAssets.filter(a => typeof a !== "string" && (a as SelectedAsset).rosterId !== userRosterId) as SelectedAsset[];
  const posNeeds    = selectedAssets.filter(a => typeof a === "string") as string[];

  const counterpartyRosterId = theirAssets.length > 0 ? theirAssets[0].rosterId : null;
  const theirServerTeam = counterpartyRosterId ? serverTeams.find(t => t.rosterId === counterpartyRosterId) : null;
  if (!theirServerTeam) throw new Error("Could not determine trade counterparty from selected assets");

  // ── Resolve position-need strings → best available counterparty asset ────
  for (const posStr of posNeeds) {
    const pos = posStr.toUpperCase();
    if (pos === "PICKS") {
      const pick = theirServerTeam.picks[0];
      if (pick) theirAssets.push({ name: pick.label, position: "PICK", value: pick.value, rosterId: theirServerTeam.rosterId!, isPick: true });
    } else if (["QB", "RB", "WR", "TE"].includes(pos)) {
      const available = theirServerTeam.players
        .filter(p => p.position === pos && !theirAssets.some(a => a.name === p.name))
        .sort((a, b) => b.value - a.value)[0];
      if (available) theirAssets.push({ name: available.name, position: available.position, value: available.value, age: available.age, nflTeam: available.nflTeam, rosterId: theirServerTeam.rosterId! });
    }
  }

  const flags: string[] = [];

  // ── LAYER 1: Pre-trade roster states ─────────────────────────────────────
  const myPreState    = _buildTeamState(myServerTeam,    serverTeams, classificationTable);
  const theirPreState = _buildTeamState(theirServerTeam, serverTeams, classificationTable);

  // ── LAYER 2: Trade values ─────────────────────────────────────────────────
  const myGiveValue    = myAssets.reduce((s, a) => s + a.value, 0);
  const theirGiveValue = theirAssets.reduce((s, a) => s + a.value, 0);
  const maxVal         = Math.max(myGiveValue, theirGiveValue, 1);
  const valuePctDiff   = Math.round(((theirGiveValue - myGiveValue) / maxVal) * 100);
  const withinTenPct   = Math.abs(valuePctDiff) <= 10;

  // ── LAYER 3: evaluateTrade() — hard blocks, health, trajectories, fairness ─
  // Convert SelectedAssets to AssetPlayer/AssetPick for the engine
  const toEngineAssets = (assets: SelectedAsset[]): (AssetPlayer | AssetPick)[] =>
    assets.map(a => a.isPick
      ? ({ label: a.name || "Pick", value: a.value } as AssetPick)
      : ({ name: a.name || "Unknown", position: a.position, nflTeam: a.nflTeam || "FA", value: a.value, age: a.age ?? null } as AssetPlayer)
    );

  const myArch    = _trajectoryToArchetype(myPreState.trajectory);
  const theirArch = _trajectoryToArchetype(theirPreState.trajectory);

  const eng = evaluateTrade(
    myServerTeam, theirServerTeam,
    toEngineAssets(myAssets),
    toEngineAssets(theirAssets),
    tables,
    myArch, theirArch,
  );

  // Engine flags
  if (eng.blocked) {
    flags.push(`⛔ BLOCKED: ${eng.blockReason}`);
  }
  for (const w of eng.warnings) {
    flags.push(`⚠️ ENGINE: ${w}`);
  }

  // ── Post-trade simulation for both rosters ────────────────────────────────
  const myGivingNames    = new Set(myAssets.filter(a => !a.isPick).map(a => a.name!));
  const theirGivingNames = new Set(theirAssets.filter(a => !a.isPick).map(a => a.name!));

  const myPostPlayers: AssetPlayer[] = [
    ...myServerTeam.players.filter(p => !myGivingNames.has(p.name)),
    ...theirAssets.filter(a => !a.isPick).map(a => ({
      name: a.name!, position: a.position, nflTeam: a.nflTeam || "FA", value: a.value, age: a.age ?? null,
    })),
  ];
  const theirPostPlayers: AssetPlayer[] = [
    ...theirServerTeam.players.filter(p => !theirGivingNames.has(p.name)),
    ...myAssets.filter(a => !a.isPick).map(a => ({
      name: a.name!, position: a.position, nflTeam: a.nflTeam || "FA", value: a.value, age: a.age ?? null,
    })),
  ];

  const myPostTeam: TeamSummary    = { teamName: myServerTeam.teamName,    ownerName: myServerTeam.ownerName,    players: myPostPlayers,    picks: [...myServerTeam.picks.filter(pk => !myAssets.some(a => a.isPick && a.name === pk.label)),    ...theirAssets.filter(a => a.isPick).map(a => ({ label: a.name!, value: a.value }))], rosterId: myServerTeam.rosterId };
  const theirPostTeam: TeamSummary = { teamName: theirServerTeam.teamName, ownerName: theirServerTeam.ownerName, players: theirPostPlayers, picks: [...theirServerTeam.picks.filter(pk => !theirAssets.some(a => a.isPick && a.name === pk.label)), ...myAssets.filter(a => a.isPick).map(a => ({ label: a.name!, value: a.value }))], rosterId: theirServerTeam.rosterId };

  const myPostState    = _buildTeamState(myPostTeam,    serverTeams, classificationTable);
  const theirPostState = _buildTeamState(theirPostTeam, serverTeams, classificationTable);

  // RULE 6: A team "improves" if their biggest positional need is addressed OR their trajectory improves.
  // (No health-score requirement — trajectory shift alone counts as improvement.)
  const trajectoryImproves = (pre: TeamState, post: TeamState): boolean => {
    const order: Record<string, number> = { REBUILD: 0, TRANSITIONING: 1, WIN_NOW: 2 };
    return (order[post.trajectory] ?? 0) > (order[pre.trajectory] ?? 0);
  };

  const myBiggestNeed    = myPreState.needPositions[0];   // [0] = worst need (sorted ascending by score)
  const theirBiggestNeed = theirPreState.needPositions[0];

  const myTeamImproves = !eng.blocked && (
    (!myBiggestNeed || theirAssets.some(a => a.position === myBiggestNeed)) ||
    trajectoryImproves(myPreState, myPostState)
  );
  const theirTeamImproves = !eng.blocked && (
    (!theirBiggestNeed || myAssets.some(a => a.position === theirBiggestNeed)) ||
    trajectoryImproves(theirPreState, theirPostState)
  );
  const bothTeamsImprove = myTeamImproves && theirTeamImproves;

  // RULE 5: lopsidedFlag = value differential > 15% (not based on improvement)
  const absPctDiff = Math.abs(valuePctDiff);
  const lopsidedFlag = !eng.blocked && absPctDiff > 15;
  let lopsidedDetail = "", adjustmentSuggestion = "";
  if (lopsidedFlag) {
    const loser = valuePctDiff < 0 ? myServerTeam.teamName : theirServerTeam.teamName;
    lopsidedDetail = `Value differential is ${absPctDiff}% — ${loser} receives significantly less value`;
    adjustmentSuggestion = valuePctDiff < 0
      ? `Request an additional asset from ${theirServerTeam.teamName} at: ${myPreState.needPositions.join("/") || "any need position"}`
      : `Add a player or pick to sweeten the deal for ${theirServerTeam.teamName}`;
    flags.push(`⚠️ LOPSIDED: ${lopsidedDetail}`);
  }

  // RULE 6: mutualBenefitFlag — at least one team doesn't improve
  const mutualBenefitFlag = !eng.blocked && !bothTeamsImprove;
  let mutualBenefitDetail = "";
  if (mutualBenefitFlag) {
    if (!myTeamImproves && theirTeamImproves) {
      mutualBenefitDetail = `${myServerTeam.teamName} does not address their biggest need (${myBiggestNeed || "none"}) or improve trajectory`;
    } else if (myTeamImproves && !theirTeamImproves) {
      mutualBenefitDetail = `${theirServerTeam.teamName} does not address their biggest need (${theirBiggestNeed || "none"}) or improve trajectory — may decline trade`;
    } else {
      mutualBenefitDetail = "Neither team addresses its biggest positional need or improves trajectory";
    }
    flags.push(`⚠️ NOT MUTUALLY BENEFICIAL: ${mutualBenefitDetail}`);
  }

  // ── LAYER 4: Trajectory alignment ────────────────────────────────────────
  const myTraj    = myPreState.trajectory;
  const theirTraj = theirPreState.trajectory;

  const recvPlayers  = theirAssets.filter(a => !a.isPick);
  const recvPicks    = theirAssets.filter(a => a.isPick);
  const givePlayers  = myAssets.filter(a => !a.isPick);
  const avgRecvAge   = recvPlayers.length ? recvPlayers.reduce((s, p) => s + (p.age || 25), 0) / recvPlayers.length : 0;
  const avgRecvValue = recvPlayers.length ? recvPlayers.reduce((s, p) => s + p.value, 0) / recvPlayers.length : 0;
  const avgGiveAge   = givePlayers.length ? givePlayers.reduce((s, p) => s + (p.age || 25), 0) / givePlayers.length : 0;

  let trajectoryAligned = true, mismatchFlag = "", trajectoryDetail = "";

  // My team trajectory check
  if (myTraj === "WIN_NOW") {
    const recvQuality = recvPlayers.some(p => p.value >= 5000) || avgRecvValue >= 4000;
    if (!recvQuality && recvPicks.length === 0) {
      trajectoryAligned = false;
      mismatchFlag = `${myServerTeam.teamName} is WIN_NOW but receiving low-value assets (avg ${Math.round(avgRecvValue)})`;
    }
    trajectoryDetail = `WIN_NOW: receiving avg value ${Math.round(avgRecvValue)}, ${recvPicks.length} picks`;
  } else if (myTraj === "REBUILD") {
    const recvYouth = avgRecvAge < 26 || recvPicks.length > 0;
    if (!recvYouth && avgGiveAge < 27) {
      trajectoryAligned = false;
      mismatchFlag = `${myServerTeam.teamName} is REBUILD but giving away young players (avg age ${avgGiveAge.toFixed(1)}) without receiving youth or picks`;
    }
    trajectoryDetail = `REBUILD: receiving ${recvPicks.length} picks + avg age ${avgRecvAge.toFixed(1)} players`;
  } else {
    const recvAtNeed = myPreState.needPositions.some(pos => recvPlayers.some(p => p.position === pos));
    if (!recvAtNeed && myPreState.needPositions.length > 0) {
      trajectoryAligned = false;
      mismatchFlag = `${myServerTeam.teamName} is TRANSITIONING but not receiving at biggest need (${myPreState.needPositions.join("/")})`;
    }
    trajectoryDetail = `TRANSITIONING: top needs ${myPreState.needPositions.join("/") || "none flagged"}, receiving ${recvPlayers.length} players`;
  }

  // Counterparty trajectory check
  const avgGiveValue = givePlayers.length ? givePlayers.reduce((s, p) => s + p.value, 0) / givePlayers.length : 0;
  if (theirTraj === "WIN_NOW" && avgGiveValue < 4000 && !myAssets.some(a => a.value >= 5000) && givePlayers.length > 0) {
    flags.push(`⚠️ TRAJECTORY: ${theirServerTeam.teamName} is WIN_NOW but receiving low-value assets (avg ${Math.round(avgGiveValue)})`);
  } else if (theirTraj === "REBUILD" && !givePlayers.some(a => (a.age || 25) < 26) && !myAssets.some(a => a.isPick)) {
    flags.push(`ℹ️ TRAJECTORY: ${theirServerTeam.teamName} is REBUILD but receiving veteran players — verify this fits their strategy`);
  }

  if (!trajectoryAligned && mismatchFlag) flags.push(`⚠️ TRAJECTORY MISMATCH: ${mismatchFlag}`);

  // Player-level trajectory labels from the engine (FIX 1 composite signals)
  const trajLabel = (t: string) => t === "RISING" ? "🟢 RISING" : t === "DECLINING" ? "🔴 DECLINING" : "🟡 STABLE";
  const playerTrajectoriesOffered:   Record<string, string> = {};
  const playerTrajectoriesRequested: Record<string, string> = {};
  for (const [n, t] of Object.entries(eng.trajectories.offered))   playerTrajectoriesOffered[n]   = trajLabel(t);
  for (const [n, t] of Object.entries(eng.trajectories.requested)) playerTrajectoriesRequested[n] = trajLabel(t);

  // ── LAYER 5: Weighted scoring ─────────────────────────────────────────────
  // W1: Mutual improvement (max 30) — uses engine hard-block and actual health delta
  const senderHealthDelta   = eng.postTradeImpact.sender.rosterHealthScore   - myPreState.rosterHealthScore;
  const receiverHealthDelta = eng.postTradeImpact.receiver.rosterHealthScore - theirPreState.rosterHealthScore;
  const w1Raw = eng.blocked ? 0 : bothTeamsImprove ? 30 : (myTeamImproves || theirTeamImproves) ? 15 : 5;
  const w1Score  = w1Raw;
  const w1Detail = eng.blocked
    ? `BLOCKED — ${eng.blockReason}`
    : bothTeamsImprove
      ? `Both teams improve: sender health ${senderHealthDelta >= 0 ? "+" : ""}${senderHealthDelta}, receiver ${receiverHealthDelta >= 0 ? "+" : ""}${receiverHealthDelta}`
      : `Only ${myTeamImproves ? myServerTeam.teamName : theirTeamImproves ? theirServerTeam.teamName : "neither team"} clearly improves`;

  // W2: FC value parity with scarcity multiplier (max 25)
  const vb       = eng.valueBreakdown;
  const absPct   = Math.abs(valuePctDiff);
  const w2BaseScore = vb.withinFairRange ? 25 : absPct <= 20 ? 15 : absPct <= 30 ? 8 : 3;
  // Scarcity multiplier bonus: if receiving scarce position (QB/TE), value range opens up
  const w2Score  = Math.min(25, Math.round(w2BaseScore * Math.min(vb.scarcityMultiplier, 1.2)));
  const w2Detail = `Value diff: ${valuePctDiff > 0 ? "+" : ""}${valuePctDiff}% — you give ${myGiveValue.toLocaleString()}, receive ${theirGiveValue.toLocaleString()} | scarcity multiplier: ${vb.scarcityMultiplier.toFixed(2)}x | ${vb.withinFairRange ? "✓ within fair range" : "outside fair range"} (${vb.fairRangeReason})`;

  // W3: Trajectory alignment weighted by motivation alignment score (max 20)
  const motPct   = eng.motivationAlignmentScore / 100;  // 0–1
  const w3Score  = Math.round(trajectoryAligned ? 20 * (0.5 + 0.5 * motPct) : 10 * motPct);
  const w3Detail = `${trajectoryAligned ? "Aligned" : "Misaligned"} — motivation alignment ${eng.motivationAlignmentScore}/100 | ${mismatchFlag || trajectoryDetail}`;

  // W4: Positional scarcity in 14-team SuperFlex (QB/TE — max 15)
  // Also rewards filling a NEED position (from detailed needs analysis)
  const scarcePos    = ["QB", "TE"];
  const filledScarce = theirAssets.filter(a => scarcePos.includes(a.position)).length;
  const filledNeed   = theirAssets.filter(a => myPreState.needPositions.includes(a.position)).length;
  const w4Score  = Math.min(15, filledScarce * 6 + filledNeed * 3);
  const w4Detail = `Receiving ${filledScarce} scarce-pos (QB/TE) + ${filledNeed} need-pos asset(s) — surplus: ${myPreState.surplusDescriptions.join(", ") || "none"} | needs: ${myPreState.needsDescriptions.join(", ") || "none"}`;

  // W5: Role change impact — uses player-level classification (STARTER/FLEX/DEPTH) and
  //     player-level trajectory direction (FIX 1 composite signals)
  const myTC    = classificationTable[myServerTeam.teamName]    || {};
  const theirTC = classificationTable[theirServerTeam.teamName] || {};
  const sendingStarters       = myAssets.filter(a => a.name && myTC[a.name]?.classification === "STARTER").length;
  const receivingStarters     = theirAssets.filter(a => a.name && theirTC[a.name]?.classification === "STARTER").length;
  // Bonus if receiving RISING players, penalty if sending RISING for DECLINING
  const risingIn   = Object.values(eng.trajectories.requested).filter(t => t === "RISING").length;
  const decliningIn = Object.values(eng.trajectories.requested).filter(t => t === "DECLINING").length;
  const risingOut  = Object.values(eng.trajectories.offered).filter(t => t === "RISING").length;
  const w5BaseScore = receivingStarters >= sendingStarters ? 10 : sendingStarters > receivingStarters + 1 ? 3 : 6;
  const w5Score  = Math.max(0, Math.min(10, w5BaseScore + risingIn - decliningIn - risingOut));
  const w5Detail = `Sending ${sendingStarters} starters (${risingOut} RISING), receiving ${receivingStarters} starters (${risingIn} RISING, ${decliningIn} DECLINING)`;

  const overallScore = w1Score + w2Score + w3Score + w4Score + w5Score;
  const overallGrade: "A" | "B" | "C" | "D" | "F" =
    overallScore >= 85 ? "A" : overallScore >= 70 ? "B" : overallScore >= 55 ? "C" : overallScore >= 40 ? "D" : "F";

  console.log(`[analyzeAssets] ${myServerTeam.teamName} ↔ ${theirServerTeam.teamName} | grade=${overallGrade} (${overallScore}/100) | blocked=${eng.blocked} | fairness=${eng.fairnessScore} | acceptance=${eng.acceptanceLikelihood}`);

  return {
    myTeamName:    myServerTeam.teamName,
    theirTeamName: theirServerTeam.teamName,

    preTrade: { myTeam: myPreState, theirTeam: theirPreState },

    proposedTrade: {
      myTeamGives: myAssets, theirTeamGives: theirAssets,
      myGiveValue, theirGiveValue, valuePctDiff, withinTenPct,
      fairValueLow:        vb.fairValueLow,
      fairValueHigh:       vb.fairValueHigh,
      scarcityMultiplier:  vb.scarcityMultiplier,
      fairRangeReason:     vb.fairRangeReason,
    },

    postTrade: {
      myTeam: myPostState, theirTeam: theirPostState,
      myTeamImproves, theirTeamImproves, bothTeamsImprove,
      lopsidedFlag, lopsidedDetail, adjustmentSuggestion,
      mutualBenefitFlag, mutualBenefitDetail,
      blocked:              eng.blocked,
      blockReason:          eng.blockReason,
      senderHealthScore:    eng.postTradeImpact.sender.rosterHealthScore,
      receiverHealthScore:  eng.postTradeImpact.receiver.rosterHealthScore,
      acceptanceLikelihood: eng.acceptanceLikelihood,
    },

    trajectoryAlignment: {
      myTeamTrajectory:  myTraj,
      theirTeamTrajectory: theirTraj,
      aligned:           trajectoryAligned,
      mismatchFlag,      detail: trajectoryDetail,
      playerTrajectoriesOffered,
      playerTrajectoriesRequested,
      motivationAlignmentScore: eng.motivationAlignmentScore,
    },

    weightedScores: {
      w1_bothImprove:         { score: w1Score, maxScore: 30, detail: w1Detail },
      w2_valueFair:           { score: w2Score, maxScore: 25, detail: w2Detail },
      w3_trajectoryAlignment: { score: w3Score, maxScore: 20, detail: w3Detail },
      w4_positionalScarcity:  { score: w4Score, maxScore: 15, detail: w4Detail },
      w5_roleChangeImpact:    { score: w5Score, maxScore: 10, detail: w5Detail },
      overallScore,
      overallGrade,
      fairnessScore: eng.fairnessScore,
    },

    flags,
    engineWarnings: eng.warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup validation — confirm every player/pick on exactly one roster
// ─────────────────────────────────────────────────────────────────────────────

export async function validateRosterIntegrity(teams: TeamSummary[]): Promise<void> {
  const playerOwner: Record<string, string[]> = {};
  const pickOwner:   Record<string, string[]> = {};

  for (const team of teams) {
    for (const p of team.players) {
      const key = `${p.name}|${p.position}`;
      (playerOwner[key] = playerOwner[key] || []).push(team.teamName);
    }
    for (const pk of team.picks) {
      (pickOwner[pk.label] = pickOwner[pk.label] || []).push(team.teamName);
    }
  }

  let errors = 0;
  for (const [key, owners] of Object.entries(playerOwner)) {
    if (owners.length > 1) {
      console.error(`[roster-integrity] DUPLICATE PLAYER: ${key} on teams: ${owners.join(", ")}`);
      errors++;
    }
  }
  for (const [label, owners] of Object.entries(pickOwner)) {
    if (owners.length > 1) {
      console.error(`[roster-integrity] DUPLICATE PICK: ${label} on teams: ${owners.join(", ")}`);
      errors++;
    }
  }

  const totalPlayers = Object.keys(playerOwner).length;
  const totalPicks   = Object.keys(pickOwner).length;

  if (errors === 0) {
    console.log(
      `[roster-integrity] ✓ PASS — ${totalPlayers} unique players, ` +
      `${totalPicks} unique picks — each assigned to exactly one team`
    );
  } else {
    console.error(`[roster-integrity] ✗ FAIL — ${errors} duplicate assignment(s) found`);
  }
}
