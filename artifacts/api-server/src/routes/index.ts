import { Router, type IRouter } from "express";
import healthRouter from "./health";
import leagueRouter from "./league";
import analyzeRouter from "./analyze";
import analyzeTradeRouter from "./analyze-trade";
import findTradesRouter from "./find-trades";
import fantasycalcRouter from "./fantasycalc";
import chatRouter from "./chat";
import counterRouter from "./counter";
import tradeMatrixRouter from "./trade-matrix";

const router: IRouter = Router();

router.use(healthRouter);
router.use(leagueRouter);
router.use(analyzeRouter);
router.use(analyzeTradeRouter);
router.use(findTradesRouter);
router.use(fantasycalcRouter);
router.use(chatRouter);
router.use(counterRouter);
router.use(tradeMatrixRouter);

export default router;
