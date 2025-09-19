import { Router } from "express";
import {
  updateUsersCount,
  getWeeklyUniqueUsers,
  getAllTimeUniqueUsers,
} from "../redis/analytics.ts";
import { THEMES, AnalyticType } from "../config/themes.ts";

const router = Router();

router.get("/count", async (_, res) => {
  try {
    const combinedEntries = await Promise.all(
      Object.keys(THEMES).map(async (t) => {
        const [weeklyUnique, allTimeUnique, count] = await Promise.all([
          getWeeklyUniqueUsers(t as AnalyticType),
          getAllTimeUniqueUsers(t as AnalyticType),
          updateUsersCount(t as AnalyticType, "get"),
        ]);
        return [t, { unique: weeklyUnique, allTimeUnique, count }];
      })
    );

    const combined = Object.fromEntries(combinedEntries);
    res.json({ stats: combined });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to get user stats" });
  }
});

export default router;
