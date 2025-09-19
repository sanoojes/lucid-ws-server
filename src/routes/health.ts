import { Router } from "express";
import { type AnalyticType, THEMES } from "../config/themes.ts";
import { requireAdminKey } from "../middlewares/admin.ts";
import { localCache } from "../redis/analytics.ts";
import { client } from "../redis/client.ts";

const router = Router();
router.get("/ping", (_, res) => res.send("pong!"));

router.post("/admin/clear", requireAdminKey, async (_, res) => {
	try {
		await client.flushDb();
		for (const type of Object.keys(THEMES) as AnalyticType[]) {
			localCache[type] = 0;
		}
		res.json({ success: true, message: "Database cleared" });
	} catch (err) {
		res.status(500).json({ success: false, error: String(err) });
	}
});

export default router;
