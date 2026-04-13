import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { analyzeAssets } from "./trade-engine.js";
import type { SelectedAsset } from "./trade-engine.js";

const router = Router();

router.post("/analyze-trade", async (req, res) => {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    res.status(500).json({ error: "ANTHROPIC_API_KEY is not configured" });
    return;
  }

  const { selectedAssets, userRosterId } = req.body as {
    selectedAssets: (SelectedAsset | string)[];
    userRosterId: number;
  };

  if (!selectedAssets?.length || !userRosterId) {
    res.status(400).json({ error: "selectedAssets and userRosterId are required" });
    return;
  }

  const myAssets    = selectedAssets.filter(a => typeof a !== "string" && (a as SelectedAsset).rosterId === userRosterId);
  const theirAssets = selectedAssets.filter(a => typeof a === "string" || (a as SelectedAsset).rosterId !== userRosterId);
  if (!myAssets.length || !theirAssets.length) {
    res.status(400).json({ error: "Must select assets from both sides of the trade" });
    return;
  }

  let analysis;
  try {
    analysis = await analyzeAssets(selectedAssets, userRosterId);
  } catch (err) {
    console.error("[analyze-trade] analyzeAssets failed:", err);
    res.status(500).json({ error: `Trade analysis failed: ${String(err)}` });
    return;
  }

  const dataBlock = JSON.stringify(analysis, null, 2);
  const prompt = `Summarize this pre-calculated trade analysis in 3 sentences. Use only the data provided. Do not add outside knowledge: ${dataBlock}`;

  console.log(`[analyze-trade] calling Claude — overall grade: ${analysis.weightedScores.overallGrade} (${analysis.weightedScores.overallScore}/100)`);

  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });

    const summary = message.content
      .filter(b => b.type === "text")
      .map(b => (b as { type: "text"; text: string }).text)
      .join("")
      .trim();

    res.json({ analysis, summary });
  } catch (err) {
    console.error("[analyze-trade] Claude call failed:", err);
    res.status(500).json({ error: "Claude API error" });
  }
});

export default router;
