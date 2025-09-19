import { randomUUID } from "node:crypto";
import { Server } from "socket.io";
import { type AnalyticType, THEMES } from "./config/themes.ts";
import {
	getWeeklyUniqueUsers,
	initializeLocalCache,
	localCache,
	logUserActivity,
	updateUsersCount,
} from "./redis/analytics.ts";

const activeSockets: Record<AnalyticType, Set<string>> = Object.keys(
	THEMES,
).reduce(
	(acc, t) => ({ ...acc, [t]: new Set<string>() }),
	{} as Record<AnalyticType, Set<string>>,
);

export async function initSockets(httpServer: any) {
	await initializeLocalCache();

	const io = new Server(httpServer, {
		cors: { origin: "*" },
		pingInterval: 30_000,
	});

	const publicNamespace = io.of("/ws/public");
	const privateNamespace = io.of("/ws/users");

	// --- Public namespace ---
	publicNamespace.on("connection", async (socket) => {
		const stats = {
			current: Object.fromEntries(
				Object.keys(THEMES).map((t) => [t, localCache[t as AnalyticType] || 0]),
			),
			unique: Object.fromEntries(
				await Promise.all(
					Object.keys(THEMES).map(async (t) => [
						t,
						await getWeeklyUniqueUsers(t as AnalyticType),
					]),
				),
			),
		};
		socket.emit("userStats", stats);
	});

	// --- Private namespace ---
	privateNamespace.on("connection", async (socket) => {
		const userType: AnalyticType =
			socket.handshake.auth?.type ?? "lyrics_extension";

		const userId: string = socket.handshake.auth?.userId ?? randomUUID();

		socket.emit("assignedUserId", { userId });

		activeSockets[userType].add(socket.id);
		await updateUsersCount(userType, "increment");
		await logUserActivity(userType, userId);

		socket.on("disconnect", async () => {
			activeSockets[userType].delete(socket.id);
			await updateUsersCount(userType, "decrement");
			await logUserActivity(userType, userId);
		});
	});

	// --- Broadcast user stats ---
	setInterval(async () => {
		const current = Object.fromEntries(
			Object.keys(THEMES).map((t) => [
				t,
				activeSockets[t as AnalyticType].size ||
					localCache[t as AnalyticType] ||
					0,
			]),
		);

		const unique = Object.fromEntries(
			await Promise.all(
				Object.keys(THEMES).map(async (t) => [
					t,
					await getWeeklyUniqueUsers(t as AnalyticType),
				]),
			),
		);

		publicNamespace.emit("userStats", {
			current,
			unique,
			timestamp: Date.now(),
		});
	}, 5000);

	// --- Periodic Redis sync ---
	setInterval(async () => {
		for (const type of Object.keys(THEMES) as AnalyticType[]) {
			const count = Number((await updateUsersCount(type, "get")) ?? 0);
			localCache[type] = count;
		}
	}, 3000);

	return io;
}
