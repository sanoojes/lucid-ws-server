// redis/analytics.ts
import {
	type AnalyticType,
	HISTORICAL_KEY_PREFIX,
	APP,
} from "../config/themes.ts";
import { formatDateISO, getLast7Days } from "../utils/date.ts";
import { client } from "./client.ts";

let todayISO = formatDateISO(new Date());
let weekDates = getLast7Days(todayISO);

setInterval(() => {
	const now = formatDateISO(new Date());
	if (now !== todayISO) {
		todayISO = now;
		weekDates = getLast7Days(todayISO);
	}
}, 60_000);

export const localCache: Record<AnalyticType, number> = Object.fromEntries(
	Object.keys(APP).map((t) => [t, 0]),
) as Record<AnalyticType, number>;

export async function initializeLocalCache() {
	for (const type in APP) {
		localCache[type as AnalyticType] = 0;
		await client.set(APP[type as AnalyticType].key, "0");
	}
}

export async function updateUsersCount(
	type: AnalyticType,
	op: "increment" | "decrement" | "get" = "get",
) {
	const key = APP[type].key;
	try {
		let count =
			op === "increment"
				? await client.incrBy(key, 1)
				: op === "decrement"
					? await client.decr(key)
					: await client.get(key);

		count = Math.max(Number(count ?? 0), 0);
		if (op === "decrement" && count === 0) await client.set(key, "0");

		localCache[type] = count;
		return count;
	} catch {
		return localCache[type];
	}
}

export async function logUserActivity(type: AnalyticType, userId?: string) {
	const now = Date.now();
	const zKey = `${HISTORICAL_KEY_PREFIX}:${type}`;
	const dailyKey = `${zKey}:daily:${todayISO}`;
	const uniqueKey = `${zKey}:unique:${todayISO}`;
	const allTimeKey = `${zKey}:unique:alltime`;

	const tx = client
		.multi()
		.zAdd(zKey, { score: now, value: String(now) })
		.incr(dailyKey)
		.expire(dailyKey, 7 * 86400)
		.zRemRangeByScore(zKey, 0, now - 7 * 86400 * 1000);

	if (userId) {
		tx.sAdd(uniqueKey, userId).expire(uniqueKey, 7 * 86400);
		tx.sAdd(allTimeKey, userId);
	}

	await tx.exec();
}

export const getAllTimeUniqueUsers = async (type: AnalyticType) =>
	client
		.sCard(`${HISTORICAL_KEY_PREFIX}:${type}:unique:alltime`)
		.catch(() => 0);

export async function getWeeklyUniqueUsers(type: AnalyticType) {
	if (!weekDates.length) return 0;
	const keys = weekDates.map(
		(d) => `${HISTORICAL_KEY_PREFIX}:${type}:unique:${d}`,
	);
	const tempKey = `${HISTORICAL_KEY_PREFIX}:${type}:unique:weekly:${todayISO}`;
	try {
		await client.sUnionStore(tempKey, keys);
		await client.expire(tempKey, 60);
		return client.sCard(tempKey);
	} catch {
		return 0;
	}
}
