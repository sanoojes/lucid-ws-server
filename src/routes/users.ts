import { Router } from "express";
import { updateUsersCount, getWeeklyUniqueUsers } from "../redis/analytics.ts";
import { THEMES, AnalyticType } from "../config/themes.ts";

const router = Router();

router.get("/count", async (_, res) => {
  try {
    const currentEntries = await Promise.all(
      Object.keys(THEMES).map(async (t) => [
        t,
        await updateUsersCount(t as AnalyticType, "get"),
      ])
    );

    const current = Object.fromEntries(currentEntries);
    res.json({ current });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to get stats" });
  }
});

router.get("/unique", async (_, res) => {
  try {
    const uniqueEntries = await Promise.all(
      Object.keys(THEMES).map(async (t) => [
        t,
        await getWeeklyUniqueUsers(t as AnalyticType),
      ])
    );

    const uniqueCounts = Object.fromEntries(uniqueEntries);
    res.json({ uniqueCounts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to get unique users" });
  }
});

export default router;
