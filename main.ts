/// <reference lib="deno.ns" />

import { createServer } from "node:http";
import cors from "cors";
import express from "express";
import { createClient } from "redis";
import { Server } from "socket.io";
import { signToken, verifyToken } from "./lib/jwt.ts";
import logger from "./lib/logger.ts";

type AnalyticType = "theme" | "lyrics_extension" | "glassify_theme";

const env = Deno.env.toObject();

if (!env.REDIS_URL || !env.JWT_SECRET) {
	logger.error("Missing env in environment.");
	Deno.exit(1);
}

// Redis keys mapping
const KEYS: Record<AnalyticType, string> = {
	theme: "lucid_theme_active_users",
	lyrics_extension: "lucid_lyrics_active_users",
	glassify_theme: "glassify_theme_active_users",
};

const CORS_OPTIONS = {
	origin: [
		"https://lyrics.lucid.sanooj.is-a.dev",
		"https://lucid.sanooj.is-a.dev",
	],
	methods: ["GET", "POST"],
	allowedHeaders: ["Content-Type", "Authorization"],
	credentials: true,
	maxAge: 60 * 60,
};

const app = express();
const httpServer = createServer(app);

app.use(cors(CORS_OPTIONS));
app.use(express.json());

const PORT = Number(env.PORT ?? 8989);

const io = new Server(httpServer, {
	cors: CORS_OPTIONS,
	pingInterval: 1000 * 30,
});

// Redis client
export const client = createClient({ url: env.REDIS_URL });
client.on("connect", () => logger.info("Redis Client Connected"));
client.on("disconnect", () => logger.error("Redis Client Disconnected"));
client.on("error", (err) => logger.error("Redis Client Error", err));

try {
	await client.connect();
} catch (err) {
	logger.error("Redis Client Connection Failed", err);
	Deno.exit(1);
}

// ====================== PUBLIC NAMESPACE ======================
const publicNamespace = io.of("/ws/public");

publicNamespace.on("connection", (socket) => {
	logger.info(`Public user connected: ${socket.id}`);

	(async () => {
		const themeCount = await getUsers("theme");
		const extensionCount = await getUsers("lyrics_extension");
		const glassifyCount = await getUsers("glassify_theme");

		socket.emit("userCount", {
			theme: themeCount,
			extension: extensionCount,
			glassify_theme: glassifyCount,
		});

		logger.info(
			`Sent current counts to public user ${socket.id}: theme=${themeCount}, extension=${extensionCount}, glassify=${glassifyCount}`,
		);
	})();

	socket.on("disconnect", () => {
		logger.info(`Public user disconnected: ${socket.id}`);
	});
});

// ====================== PRIVATE NAMESPACE ======================
const privateNamespace = io.of("/ws/users");

privateNamespace.use((socket, next) => {
	try {
		const token = socket.handshake.auth?.token;
		if (!token) {
			return next(new Error("Authentication token missing."));
		}

		const payload = verifyToken(token);
		if (!payload) {
			return next(new Error("Authentication error"));
		}

		socket.data.user = payload;
		next();
	} catch (err) {
		next(new Error("Authentication error"));
	}
});

privateNamespace.on("connection", async (socket) => {
	const userType: AnalyticType =
		socket.handshake.auth?.type ?? "lyrics_extension";

	await incrementUsers(userType);
	logger.info(`User connected: ${socket.id}, Type=${userType}}`);

	socket.on("disconnect", async () => {
		if (userType) await decrementUsers(userType);

		logger.info(`User disconnected: ${socket.id}`);
	});
});

app.get("/", (_, res) => {
	res.send("Welcome to Lucid Analytics Server !");
});
app.get("/ping", (_, res) => {
	res.status(200).send("pong!");
});

app.get("/token", async (req, res) => {
	const authHeader = req.headers.authorization;

	if (!authHeader?.startsWith("Bearer ")) {
		return res.status(400).json({ error: "Spotify token missing" });
	}

	const spotifyToken = authHeader.split(" ")[1];

	try {
		const response = await fetch("https://api.spotify.com/v1/me", {
			headers: { Authorization: `Bearer ${spotifyToken}` },
		});

		if (!response.ok) {
			return res.status(401).json({ error: "Invalid Spotify token" });
		}

		const spotifyUser: { id?: string; email?: string } =
			(await response.json()) as any;

		if (!spotifyUser.id || !spotifyUser.email)
			return res.status(501).json({ error: "Failed to verify user" });

		const token = await signToken(
			{
				userId: spotifyUser.id,
				email: spotifyUser.email,
			},
			"1d",
		);

		const expiresAt = Date.now() + 23 * 60 * 60 * 1000; // expires in 23h

		logger.info(`Generated JWT for Spotify user ${spotifyUser.id}`);

		res.status(200).json({ token, expiresAt });
	} catch (err) {
		logger.error("Failed to generate token from Spotify", err);
		res.status(500).json({ error: "Failed to generate token" });
	}
});

app.get("/users/count", async (_, res) => {
	const themeCount = await getUsers("theme");
	const extensionCount = await getUsers("lyrics_extension");
	const glassifyCount = await getUsers("glassify_theme");

	res.status(200).json({
		theme: themeCount,
		extension: extensionCount,
		glassify_theme: glassifyCount,
	});

	logger.info(
		`Returned active users count: theme=${themeCount}, extension=${extensionCount}, glassify=${glassifyCount}`,
	);
});

httpServer.listen(PORT, () => {
	logger.info(`Server running on https://localhost:${PORT}`);
});

async function initializeUserCounts() {
	try {
		for (const type of Object.keys(KEYS) as AnalyticType[]) {
			await client.set(KEYS[type], 0);
			publicNamespace.emit(`${type}`, 0);
		}
	} catch (err) {
		logger.error("Failed to initialize user counts", err);
	}
}

await initializeUserCounts();
type CountOperation = "increment" | "decrement" | "get";

async function updateUsersCount(
	type: AnalyticType,
	operation: CountOperation = "get",
) {
	const key = KEYS[type];

	try {
		let count: number;

		switch (operation) {
			case "increment":
				count = await client.incr(key);
				break;

			case "decrement":
				count = Number((await client.get(key)) ?? 0);
				if (count > 0) {
					count = await client.decr(key);
				} else {
					count = 0; // prevent underflow
					await client.set(key, 0);
				}
				break;

			default:
				count = Number((await client.get(key)) ?? 0);
				break;
		}

		if (operation !== "get") publicNamespace.emit(type, count);

		return count;
	} catch (err) {
		logger.error(`Failed to ${operation} ${type} active users`, err);
		return 0;
	}
}

const incrementUsers = (type: AnalyticType) =>
	updateUsersCount(type, "increment");
const decrementUsers = (type: AnalyticType) =>
	updateUsersCount(type, "decrement");
const getUsers = (type: AnalyticType) => updateUsersCount(type, "get");
