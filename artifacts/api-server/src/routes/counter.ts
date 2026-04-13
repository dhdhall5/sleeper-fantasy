import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";

const router = Router();

router.post("/counter", async (req, res) => {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) { res.status(500).json({ error: "ANTHROPIC_API_KEY not set" }); return; }

  const {
    proposal = "",
    myTeamName = "My Team",
    theirTeamName = "Their Team",
    theirArchetype = "unknown",
    leagueName = "Dynasty League",
    myPickCapital = "",
    myRosterSnippet = "",
  } = req.body as {
    proposal: string;
    myTeamName: string;
    theirTeamName: string;
    theirArchetype: string;
    leagueName: string;
    myPickCapital?: string;
    myRosterSnippet?: string;
  };

  const pickLine = myPickCapital ? `\n${myTeamName}'s available picks to add: ${myPickCapital}` : "";
  const rosterLine = myRosterSnippet ? `\n${myTeamName}'s roster depth (for upgrade options): ${myRosterSnippet}` : "";

  const prompt = `Dynasty fantasy football trade analyst for ${leagueName}.

${myTeamName} proposed this trade to ${theirTeamName} (${theirArchetype} team):
${proposal}
${pickLine}${rosterLine}

They said no. Generate a SWEETENED counter offer that ${myTeamName} could send next.

STRICT RULES:
1. ${myTeamName} ADDS value to their side — either tack on one of their picks OR upgrade one player they're offering to a better one on their roster.
2. NEVER remove or reduce anything from ${theirTeamName}'s side. They keep everything they were already getting.
3. Keep it simple — one concrete adjustment only (one pick add OR one player upgrade, not both).
4. Name the exact player or pick being added/upgraded and its KTC value.
5. End with one sentence on whether this sweetened offer is worth sending or if ${myTeamName} should walk away.

Format: 3-4 tight sentences. No generic advice — name specific players and picks.`;

  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 350,
      messages: [{ role: "user", content: prompt }],
    });
    const text = message.content
      .filter(b => b.type === "text")
      .map(b => (b as { type: "text"; text: string }).text)
      .join("");
    res.json({ counter: text });
  } catch (err) {
    req.log.error({ err }, "Error in /api/counter");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
