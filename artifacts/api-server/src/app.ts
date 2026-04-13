import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import router from "./routes";
import { logger } from "./lib/logger";
import { fetchCoreData, fetchPlayersData } from "./routes/league";
import { warmFcCache } from "./routes/fantasycalc";
import { getTradeIntelligenceTables, validateRosterIntegrity } from "./routes/trade-engine";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(join(__dirname, "../public")));

app.use("/api", router);

// Serve index.html for /team/:username so bookmarked URLs work
app.get("/team/:username", (_req, res) => {
  res.sendFile(join(__dirname, "../public/index.html"));
});

// Pre-warm all caches on startup so the first visitor gets fast responses.
// Errors are swallowed — the routes will retry on first real request.
(async () => {
  logger.info("Pre-warming caches...");
  await Promise.allSettled([
    fetchCoreData().then(() => logger.info("Core league cache warm")),
    fetchPlayersData().then(() => logger.info("Players cache warm")),
    warmFcCache().then(() => logger.info("FC values cache warm")),
  ]);

  // Build trade intelligence tables and validate roster integrity
  try {
    const tables = await getTradeIntelligenceTables();
    logger.info("Trade intelligence tables warm");
    // Run data integrity check — logs any duplicate player/pick assignments
    await validateRosterIntegrity(tables.serverTeams);
  } catch (err) {
    logger.warn({ err }, "Trade engine warm failed — will retry on first request");
  }

  logger.info("Cache pre-warm complete");
})();

export default app;
