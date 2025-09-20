import { randomUUID } from "node:crypto";
import { Server } from "socket.io";
import { type AnalyticType, APP } from "./config/themes.ts";
import {
	getWeeklyUniqueUsers,
	initializeLocalCache,
	localCache,
	logUserActivity,
	updateUsersCount,
} from "./redis/analytics.ts";

const KEYS = Object.keys(APP);

export async function initSockets(httpServer: any) {
	await initializeLocalCache();
	const io = new Server(httpServer, {
		cors: { origin: "*" },
		pingInterval: 30_000,
	});
	const publicNamespace = io.of("/ws/public");
	const privateNamespace = io.of("/ws/users");

	const active: Record<AnalyticType, Set<string>> = Object.fromEntries(
		KEYS.map((t) => [t, new Set()]),
	) as Record<AnalyticType, Set<string>>;

	publicNamespace.on("connection", (socket) => {
		const sendStats = async () => {
			const current = Object.fromEntries(
				KEYS.map((t) => [t, localCache[t as AnalyticType]]),
			);
			const unique = Object.fromEntries(
				await Promise.all(
					KEYS.map(async (t) => [
						t,
						await getWeeklyUniqueUsers(t as AnalyticType),
					]),
				),
			);
			return { current, unique, timestamp: Date.now() };
		};

		sendStats().then((stats) => socket.emit("userStats", stats));

		socket.on("getStats", async () => {
			const stats = await sendStats();
			socket.emit("userStats", stats);
		});
	});

	privateNamespace.on("connection", (socket) => {
		const type =
			(socket.handshake.auth?.type as AnalyticType) ?? "lyrics_extension";
		let userId: string | undefined;

		socket.on("getUserId", async (providedUserId: string) => {
			if (!userId) {
				userId = providedUserId || randomUUID();

				active[type].add(socket.id);

				await updateUsersCount(type, "increment");
				await logUserActivity(type, userId);
			}

			socket.emit("assignedUserId", { userId });
		});

		socket.on("disconnect", async () => {
			if (userId) {
				active[type].delete(socket.id);
				await updateUsersCount(type, "decrement");
			}
		});
	});

	setInterval(async () => {
		for (const t of KEYS as AnalyticType[]) {
			localCache[t] = await updateUsersCount(t, "get");
		}
	}, 10_000);

	return io;
}
