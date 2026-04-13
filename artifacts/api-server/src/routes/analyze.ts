import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";

const router = Router();

const LEAGUE_ID = "1312890569210478592";
const BASE = "https://api.sleeper.app/v1";

const POS_ORDER = ["QB", "RB", "WR", "TE", "FLEX", "REC_FLEX", "K", "DEF", "BN", "IR"];

function posRank(pos: string) {
  const idx = POS_ORDER.indexOf(pos);
  return idx === -1 ? POS_ORDER.length : idx;
}

router.get("/analyze", async (req, res) => {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    res.status(500).json({ error: "ANTHROPIC_API_KEY is not configured" });
    return;
  }

  // Dynamic: caller passes ?owner=DisplayName so any league member can use this
  const ownerQuery = ((req.query.owner as string) || "").toLowerCase().trim();

  try {
    const [leagueRes, rostersRes, usersRes, playersRes] = await Promise.all([
      fetch(`${BASE}/league/${LEAGUE_ID}`),
      fetch(`${BASE}/league/${LEAGUE_ID}/rosters`),
      fetch(`${BASE}/league/${LEAGUE_ID}/users`),
      fetch(`${BASE}/players/nfl`),
    ]);

    if (!leagueRes.ok || !rostersRes.ok || !usersRes.ok || !playersRes.ok) {
      res.status(502).json({ error: "Failed to fetch data from Sleeper API" });
      return;
    }

    const [league, rosters, users, players] = await Promise.all([
      leagueRes.json() as Promise<Record<string, unknown>>,
      rostersRes.json() as Promise<Array<{
        owner_id: string;
        players: string[];
        starters: string[];
        settings?: Record<string, number>;
        roster_id: number;
      }>>,
      usersRes.json() as Promise<Array<{
        user_id: string;
        display_name: string;
        username?: string;
        metadata?: { team_name?: string };
      }>>,
      playersRes.json() as Promise<Record<string, {
        full_name?: string;
        first_name?: string;
        last_name?: string;
        position?: string;
        team?: string;
        age?: number;
        years_exp?: number;
        injury_status?: string;
      }>>,
    ]);

    const userMap: Record<string, typeof users[number]> = {};
    for (const u of users) userMap[u.user_id] = u;

    const enrichedRosters = rosters.map((roster) => {
      const user = userMap[roster.owner_id] || { display_name: "Unknown", user_id: roster.owner_id };
      const starterSet = new Set(roster.starters || []);

      const enrichedPlayers = (roster.players || [])
        .map((id) => {
          const p = players[id] || {};
          const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || `Player ${id}`;
          return {
            id,
            name,
            position: p.position || "UNK",
            nflTeam: p.team || "FA",
            age: p.age,
            yearsExp: p.years_exp,
            injuryStatus: p.injury_status || null,
            isStarter: starterSet.has(id),
          };
        })
        .sort((a, b) => {
          if (a.isStarter !== b.isStarter) return a.isStarter ? -1 : 1;
          return posRank(a.position) - posRank(b.position);
        });

      const wins = roster.settings?.wins ?? 0;
      const losses = roster.settings?.losses ?? 0;
      const ties = roster.settings?.ties ?? 0;
      const fpts = (roster.settings?.fpts ?? 0) + (roster.settings?.fpts_decimal ?? 0) / 100;

      return {
        ownerId: roster.owner_id,
        teamName: user.metadata?.team_name || user.display_name,
        ownerDisplayName: user.display_name,
        ownerUsername: user.username || user.display_name,
        record: `${wins}-${losses}${ties ? `-${ties}` : ""}`,
        pointsFor: fpts,
        starters: enrichedPlayers.filter((p) => p.isStarter),
        bench: enrichedPlayers.filter((p) => !p.isStarter),
      };
    });

    enrichedRosters.sort((a, b) => {
      const [aw] = a.record.split("-").map(Number);
      const [bw] = b.record.split("-").map(Number);
      if (bw !== aw) return bw - aw;
      return b.pointsFor - a.pointsFor;
    });

    // Find the requesting owner dynamically — match display_name or username, case-insensitive
    const myTeam = ownerQuery
      ? enrichedRosters.find(
          (r) =>
            r.ownerDisplayName.toLowerCase() === ownerQuery ||
            r.ownerUsername.toLowerCase() === ownerQuery ||
            r.teamName.toLowerCase() === ownerQuery
        ) || enrichedRosters[0]
      : enrichedRosters[0];

    const myOwnerLabel = myTeam?.ownerDisplayName || ownerQuery || "Unknown";
    const leagueSettings = league as Record<string, unknown>;
    const scoringSettings = (leagueSettings.scoring_settings as Record<string, number>) || {};
    const rosterPositions = (leagueSettings.roster_positions as string[]) || [];

    const prompt = `You are an expert fantasy football analyst. Analyze the following dynasty fantasy football league data and provide specific, actionable recommendations for the team owned by **${myOwnerLabel}**.

## League Info
- Name: ${leagueSettings.name}
- Season: ${leagueSettings.season}
- Scoring: ${scoringSettings.rec ? `PPR (${scoringSettings.rec} pts/reception)` : "Standard"}
- Roster Positions: ${rosterPositions.join(", ")}
- Total Teams: ${enrichedRosters.length}
- Format: Dynasty SuperFlex

## Current Standings (sorted by record, then points)
${enrichedRosters
  .map(
    (r, i) =>
      `${i + 1}. ${r.teamName} (@${r.ownerDisplayName}) — ${r.record} — ${r.pointsFor.toFixed(2)} pts`
  )
  .join("\n")}

## All Team Rosters

${enrichedRosters
  .map(
    (r) => `### ${r.teamName} (@${r.ownerDisplayName}) — ${r.record}
Starters: ${r.starters.map((p) => `${p.name} (${p.position}${p.nflTeam ? ", " + p.nflTeam : ""}${p.injuryStatus ? ", ⚠️ " + p.injuryStatus : ""})`).join(", ")}
Bench: ${r.bench.map((p) => `${p.name} (${p.position}${p.nflTeam ? ", " + p.nflTeam : ""}${p.injuryStatus ? ", ⚠️ " + p.injuryStatus : ""})`).join(", ") || "None"}`
  )
  .join("\n\n")}

## Focus Team: ${myTeam?.teamName || myOwnerLabel} (@${myOwnerLabel}) — ${myTeam?.record || "N/A"}
${
  myTeam
    ? `Starters: ${myTeam.starters.map((p) => `${p.name} (${p.position}, ${p.nflTeam}${p.age ? ", age " + p.age : ""}${p.yearsExp !== undefined ? ", " + p.yearsExp + " yrs exp" : ""}${p.injuryStatus ? ", ⚠️ " + p.injuryStatus : ""})`).join("; ")}
Bench: ${myTeam.bench.map((p) => `${p.name} (${p.position}, ${p.nflTeam}${p.age ? ", age " + p.age : ""}${p.injuryStatus ? ", ⚠️ " + p.injuryStatus : ""})`).join("; ") || "None"}`
    : "Team not found in roster data."
}

---

Please provide a thorough analysis in the following JSON format (respond ONLY with valid JSON, no markdown fences, no extra text).
Do NOT include trade suggestions — focus only on roster evaluation, start/sit decisions, waiver wire, keeper/dynasty value, and playoff outlook.

{
  "teamSummary": "2-3 sentence overview of ${myOwnerLabel}'s team strength, weaknesses, and current standing",
  "strengthsAndWeaknesses": {
    "strengths": ["list of 2-4 specific strengths based on actual roster players"],
    "weaknesses": ["list of 2-4 specific weaknesses based on actual roster players"]
  },
  "startSitRecommendations": [
    {
      "player": "player name",
      "recommendation": "START or SIT or FLEX",
      "reason": "specific reason based on matchup, usage, or situation"
    }
  ],
  "keeperRecommendations": [
    {
      "player": "player name",
      "reason": "why they are a core keeper / high dynasty value"
    }
  ],
  "waiversAndDrops": {
    "addRecommendations": ["specific free agents or waiver targets worth adding — name them"],
    "dropCandidates": ["players on ${myOwnerLabel}'s bench that could be cut to make room"]
  },
  "playoffOutlook": "honest assessment of playoff chances and what needs to happen",
  "weeklyPriority": "single most important non-trade action ${myOwnerLabel} should take this week"
}`;

    req.log.info({ promptLength: prompt.length }, "analyze prompt built");
    console.log(`[analyze] prompt length: ${prompt.length} chars`);

    const client = new Anthropic({ apiKey });

    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });

    const rawText = message.content
      .filter((block) => block.type === "text")
      .map((block) => (block as { type: "text"; text: string }).text)
      .join("");

    let analysis: unknown;
    try {
      analysis = JSON.parse(rawText);
    } catch {
      analysis = { raw: rawText };
    }

    res.json({
      team: myTeam?.teamName || myOwnerLabel,
      owner: myOwnerLabel,
      record: myTeam?.record || "N/A",
      analysis,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "Error in /api/analyze");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
