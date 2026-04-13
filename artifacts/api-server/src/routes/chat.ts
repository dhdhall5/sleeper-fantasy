import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";

const router = Router();

interface ChatPlayer {
  name: string;
  position: string;
  nflTeam: string;
  value: number;
  rank?: number | null;
  age?: number | null;
  yearsExp?: number | null;
  isStarter?: boolean;
  injuryStatus?: string | null;
}

interface ChatPick {
  label: string;
  value: number;
}

interface ChatTeam {
  teamName: string;
  ownerName: string;
  record?: string;
  fpts?: string;
  isMyTeam?: boolean;
  players: ChatPlayer[];
  picks?: ChatPick[];
}

interface LeagueSettings {
  format: string;
  season: string;
  scoringFormat: string;
  rosterSlots: string;
  valueScale: string;
  leagueName?: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatRequest {
  messages: ChatMessage[];
  teamMode: string | null;
  userName?: string;
  teamName?: string;
  myRoster: ChatPlayer[];
  myPicks: ChatPick[];
  allTeams: ChatTeam[];
  waiverTop30?: ChatPlayer[];
  waiverTop20?: ChatPlayer[];   // legacy fallback
  leagueSettings?: LeagueSettings;
  myArchetype?: { key: string; label: string } | null;
}

function fmtPlayer(p: ChatPlayer): string {
  const starterTag = p.isStarter === true ? "[S]" : p.isStarter === false ? "[B]" : "";
  const injTag = p.injuryStatus ? ` ⚠${p.injuryStatus}` : "";
  const parts: string[] = [
    `${starterTag}${p.position} ${p.name}`,
    p.nflTeam,
    `val:${p.value}`,
  ];
  if (p.rank) parts.push(`#${p.rank}`);
  if (p.age) parts.push(`age:${p.age}`);
  if (p.yearsExp != null) parts.push(`exp:${p.yearsExp}yr`);
  if (injTag) parts.push(injTag);
  return parts.join(" | ");
}

function fmtWaiverPlayer(p: ChatPlayer): string {
  const parts: string[] = [
    `${p.position} ${p.name}`,
    p.nflTeam,
    `val:${p.value}`,
  ];
  if (p.rank) parts.push(`#${p.rank} overall`);
  if ((p as any).posRank) parts.push(`#${(p as any).posRank} ${p.position}`);
  if (p.age) parts.push(`age:${p.age}`);
  if (p.injuryStatus) parts.push(`⚠${p.injuryStatus}`);
  return parts.join(" | ");
}

router.post("/chat", async (req, res) => {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    res.status(500).json({ error: "ANTHROPIC_API_KEY is not configured" });
    return;
  }

  const {
    messages = [],
    teamMode,
    userName = "Unknown",
    teamName,
    myRoster = [],
    myPicks = [],
    allTeams = [],
    waiverTop30,
    waiverTop20,
    leagueSettings,
    myArchetype,
  } = req.body as ChatRequest;

  if (!messages.length) {
    res.status(400).json({ error: "No messages provided" });
    return;
  }

  const displayName = teamName || userName;
  const waiver = waiverTop30 || waiverTop20 || [];

  const modeLabel =
    teamMode === "WIN_NOW" ? "Win Now" :
    teamMode === "REBUILD" ? "Rebuild" : "Not set";

  const modeContext =
    teamMode === "WIN_NOW"
      ? "This owner is trying to WIN NOW. Prioritize proven starters, short-term production, and contention windows. Draft picks have less value; experienced veterans preferred."
      : teamMode === "REBUILD"
      ? "This owner is in REBUILD MODE. Prioritize youth, draft capital, and high-ceiling upside. Willing to trade aging veterans for future assets."
      : "Team mode not set — give balanced analysis.";

  // Separate my starters and bench for clarity
  const myStarters = myRoster.filter(p => p.isStarter);
  const myBench = myRoster.filter(p => !p.isStarter);

  // Format all 14 team rosters — full depth, no truncation
  const allTeamsBlock = allTeams
    .map(t => {
      const myMarker = t.isMyTeam ? " ← THIS USER'S TEAM" : "";
      const starters = t.players.filter(p => p.isStarter);
      const bench = t.players.filter(p => !p.isStarter);
      const picksStr = t.picks?.length
        ? `  Picks: ${t.picks.map(p => `${p.label}(val:${p.value})`).join(", ")}`
        : "";
      return (
        `**${t.teamName}** @${t.ownerName}${myMarker} | Record: ${t.record || "0-0"} | Pts: ${t.fpts || "0"}\n` +
        (starters.length
          ? `  STARTERS:\n` + starters.map(p => `    ${fmtPlayer(p)}`).join("\n") + "\n"
          : "") +
        (bench.length
          ? `  BENCH:\n` + bench.map(p => `    ${fmtPlayer(p)}`).join("\n") + "\n"
          : "") +
        picksStr
      );
    })
    .join("\n\n");

  const leagueName = leagueSettings?.leagueName || "your dynasty league";

  const systemPrompt = `You are a sharp, direct dynasty fantasy football analyst advising **${displayName}** (@${userName}) in ${leagueName}.

## League Settings
${leagueSettings
  ? `Format: ${leagueSettings.format}
Season: ${leagueSettings.season}
Scoring: ${leagueSettings.scoringFormat}
Roster: ${leagueSettings.rosterSlots}
Values: ${leagueSettings.valueScale}`
  : "14-team Dynasty SuperFlex Full PPR | Values on Fantasy Calc dynasty SuperFlex scale (0–10,000+)"}

## ${displayName}'s Team Mode: ${modeLabel}
${modeContext}

## ${displayName}'s Team Archetype: ${myArchetype?.label || "Unknown (auto-detect when values load)"}
${myArchetype?.key === "dynastycontender"    ? "Strategy: top-tier roster with young depth — protect core assets, look to trade surplus bench depth for elite upgrades."
  : myArchetype?.key === "winnow"            ? "Strategy: window open but closing — wants proven immediate starters; willing to give picks and youth to win now."
  : myArchetype?.key === "agingcontender"    ? "Strategy: SELL declining veterans NOW before value drops — prioritize getting picks and young players back."
  : myArchetype?.key === "risingcontender"   ? "Strategy: ascending rapidly — keep young talent and early picks while targeting one proven difference-maker."
  : myArchetype?.key === "middlepack"        ? "Strategy: needs 1-2 elite difference-makers to break out; willing to overpay slightly in picks."
  : myArchetype?.key === "strategicrebuilder" ? "Strategy: intentional rebuild — wants picks and young rising players; willing to move any aging or stable veteran."
  : myArchetype?.key === "accidentalrebuilder" ? "Strategy: no clear path forward — needs a full reset; should acquire any draft capital by moving aging vets."
  : myArchetype?.key === "transitioning"     ? "Strategy: identity unclear — needs to commit to a direction: sell aging vets or sell picks depending on ambition."
  // legacy keys
  : myArchetype?.key === "contender"         ? "Strategy: wants proven veteran starters; willing to give picks and youth to win now."
  : myArchetype?.key === "rebuilder"         ? "Strategy: prioritizes picks and young rising players; willing to move aging or stable vets."
  : "Archetype not yet determined — give balanced advice."
}
When discussing trades, always factor this archetype into recommendations. Reference whether a suggested move aligns or conflicts with this strategy.

## ${displayName}'s Full Roster
STARTERS (${myStarters.length}):
${myStarters.map(fmtPlayer).join("\n") || "  (none)"}

BENCH (${myBench.length}):
${myBench.map(fmtPlayer).join("\n") || "  (none)"}
${myPicks.length ? `\nDRAFT PICKS: ${myPicks.map(p => `${p.label}(val:${p.value})`).join(", ")}` : ""}

## All 14 Teams — Full Rosters & Draft Capital
([S] = Starter, [B] = Bench)
${allTeamsBlock}

## Waiver Wire — Top ${waiver.length} Available Players
${waiver.map(fmtWaiverPlayer).join("\n") || "(none)"}

---
## Response Rules
- Always name specific players from the rosters above — never give generic advice
- Reference FC values when comparing players (e.g. "Breece Hall at 3,700 outvalues your WR3")
- For waiver adds, compare to specific bench players the user could drop to make room
- For keeper/dynasty advice, emphasize age, value trajectory, and positional scarcity
- For start/sit, reference the specific players in their lineup and bench
- For playoff outlook, reference their current record and remaining schedule context
- Keep answers conversational and specific — 3–8 sentences unless more detail is requested
- This is a multi-turn chat — refer back to earlier context when relevant
- You have full visibility into every team's roster, picks, and the waiver wire
- **Do NOT suggest specific trades or trade targets.** If asked about trades, redirect the user to the Trade Analyzer tab where they can build and analyze trades with full AI support.
- Focus exclusively on: roster evaluation, start/sit decisions, waiver wire targets, keeper/dynasty recommendations, draft strategy, and playoff outlook`;

  req.log.info({ systemPromptLength: systemPrompt.length, turns: messages.length }, "chat prompt built");
  console.log(`[chat] system prompt: ${systemPrompt.length} chars | turns: ${messages.length}`);

  try {
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1200,
      system: systemPrompt,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
    });

    const text = response.content
      .filter(b => b.type === "text")
      .map(b => (b as { type: "text"; text: string }).text)
      .join("");

    res.json({ response: text });
  } catch (err) {
    req.log.error({ err }, "Error in /api/chat");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
