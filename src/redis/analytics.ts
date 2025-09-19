import {
	type AnalyticType,
	HISTORICAL_KEY_PREFIX,
	THEMES,
} from "../config/themes.ts";
import { formatDateISO, getLast7Days } from "../utils/date.ts";
import { client } from "./client.ts";

let todayISO = formatDateISO(new Date());
let weekDates = getLast7Days(todayISO);

setInterval(() => {
	const nowISO = formatDateISO(new Date());
	if (nowISO !== todayISO) {
		todayISO = nowISO;
		weekDates = getLast7Days(todayISO);
	}
}, 60 * 1000);

export const localCache: Record<AnalyticType, number> = {} as Record<
	AnalyticType,
	number
>;
for (const type of Object.keys(THEMES) as AnalyticType[]) {
	localCache[type] = 0;
}

export async function initializeLocalCache() {
	for (const type of Object.keys(THEMES) as AnalyticType[]) {
		localCache[type] = 0;
		await client.set(THEMES[type].key, "0");
	}
}

export async function updateUsersCount(
	type: AnalyticType,
	operation: "increment" | "decrement" | "get" = "get",
) {
	const key = THEMES[type].key;

	try {
		let count: number;
		switch (operation) {
			case "increment":
				count = Number(await client.incrBy(key, 1));
				break;
			case "decrement":
				count = Number(await client.decr(key));
				if (count < 0) {
					count = 0;
					await client.set(key, "0");
				}
				break;
			default:
				count = Number((await client.get(key)) ?? 0);
		}

		localCache[type] = count;
		return count;
	} catch {
		return localCache[type];
	}
}

export async function logUserActivity(type: AnalyticType, userId?: string) {
	const timestamp = Date.now();
	const zKey = `${HISTORICAL_KEY_PREFIX}:${type}`;
	const dailyKey = `${HISTORICAL_KEY_PREFIX}:${type}:daily:${todayISO}`;
	const dayUniqueKey = `${HISTORICAL_KEY_PREFIX}:${type}:unique:${todayISO}`;
	const allTimeKey = `${HISTORICAL_KEY_PREFIX}:${type}:unique:alltime`;

	const tx = client.multi();
	tx.zAdd(zKey, { score: timestamp, value: String(timestamp) });
	tx.incr(dailyKey);
	tx.expire(dailyKey, 7 * 24 * 60 * 60);

	if (userId) {
		tx.sAdd(dayUniqueKey, userId);
		tx.expire(dayUniqueKey, 7 * 24 * 60 * 60);
		tx.sAdd(allTimeKey, userId);
	}

	const oneWeekAgo = timestamp - 7 * 24 * 60 * 60 * 1000;
	tx.zRemRangeByScore(zKey, 0, oneWeekAgo);

	await tx.exec();
}

export async function getAllTimeUniqueUsers(type: AnalyticType) {
	const allTimeKey = `${HISTORICAL_KEY_PREFIX}:${type}:unique:alltime`;
	try {
		return await client.sCard(allTimeKey);
	} catch {
		return 0;
	}
}

export async function getWeeklyUniqueUsers(type: AnalyticType) {
	const keys = weekDates.map(
		(date) => `${HISTORICAL_KEY_PREFIX}:${type}:unique:${date}`,
	);

	if (keys.length === 0) return 0;

	const tempKey = `${HISTORICAL_KEY_PREFIX}:${type}:unique:weekly:${todayISO}`;

	try {
		await client.sUnionStore(tempKey, keys);
		await client.expire(tempKey, 60);
		return await client.sCard(tempKey);
	} catch {
		return 0;
	}
}
