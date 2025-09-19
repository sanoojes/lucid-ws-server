/// <reference lib="deno.ns" />

import { createServer } from "node:http";
import cors from "cors";
import express from "express";
import { createClient } from "redis";
import { Server } from "socket.io";
import logger from "./lib/logger.ts";

type AnalyticType = "lucid_theme" | "lyrics_extension" | "glassify_theme";

const env = Deno.env.toObject();

if (!env.REDIS_URL || !env.JWT_SECRET) {
  logger.error("Missing env in environment.");
  Deno.exit(1);
}

// Redis keys mapping
const KEYS: Record<AnalyticType, string> = {
  lucid_theme: "lucid_theme_active_users",
  lyrics_extension: "lucid_lyrics_active_users",
  glassify_theme: "glassify_theme_active_users",
};

const HISTORICAL_KEY_PREFIX = "lucid_activity";

const CORS_OPTIONS = {
  origin: [
    "https://xpui.app.spotify.com",
    "https://lyrics.lucid.sanooj.is-a.dev",
    "https://lucid.sanooj.is-a.dev",
    "https://spicetify.projects.sanooj.uk",
    "http://localhost:8787",
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

const localCache: Record<AnalyticType, number> = {
  lucid_theme: 0,
  lyrics_extension: 0,
  glassify_theme: 0,
};

type CachedValue = { value: number; expiresAt: number };
const weeklyCache = new Map<AnalyticType, CachedValue>();

const incrementUsers = (type: AnalyticType) =>
  updateUsersCount(type, "increment");
const decrementUsers = (type: AnalyticType) =>
  updateUsersCount(type, "decrement");
const getUsers = (type: AnalyticType) => updateUsersCount(type, "get");

publicNamespace.on("connection", async (socket) => {
  try {
    const stats = {
      current: {
        lucid_theme: localCache.lucid_theme ?? (await getUsers("lucid_theme")),
        lyrics_extension:
          localCache.lyrics_extension ?? (await getUsers("lyrics_extension")),
        glassify_theme:
          localCache.glassify_theme ?? (await getUsers("glassify_theme")),
      },
      weeklyAvg: {
        lucid_theme: await cachedWeeklyAverage("lucid_theme"),
        lyrics_extension: await cachedWeeklyAverage("lyrics_extension"),
        glassify_theme: await cachedWeeklyAverage("glassify_theme"),
      },
    };
    socket.emit("userStats", stats);
  } catch (err) {
    logger.error("Failed to send initial stats to public socket", err);
  }
});

// ====================== PRIVATE NAMESPACE ======================
const privateNamespace = io.of("/ws/users");

privateNamespace.on("connection", async (socket) => {
  const userType: AnalyticType =
    socket.handshake.auth?.type ?? "lyrics_extension";
  const userId: string | undefined = socket.handshake.auth?.userId;

  try {
    await incrementUsers(userType);
    await logUserActivity(userType, userId);
  } catch (err) {
    logger.error("Error handling new private connection", err);
  }

  socket.on("disconnect", async () => {
    try {
      await decrementUsers(userType);
      await logUserActivity(userType, userId);
    } catch (err) {
      logger.error("Error handling disconnect", err);
    }
  });
});

// ====================== HTTP ENDPOINTS ======================
app.get("/", (_, res) => {
  res.send("Welcome to Lucid Analytics Server !");
});
app.get("/ping", (_, res) => {
  res.status(200).send("pong!");
});

app.get("/users/count", async (_, res) => {
  try {
    const themeCount = await getUsers("lucid_theme");
    const extensionCount = await getUsers("lyrics_extension");
    const glassifyCount = await getUsers("glassify_theme");

    const themeAvg = await cachedWeeklyAverage("lucid_theme");
    const extensionAvg = await cachedWeeklyAverage("lyrics_extension");
    const glassifyAvg = await cachedWeeklyAverage("glassify_theme");

    res.status(200).json({
      current: {
        lucid_theme: themeCount,
        lyrics_extension: extensionCount,
        glassify_theme: glassifyCount,
      },
      weeklyAvg: {
        lucid_theme: themeAvg,
        lyrics_extension: extensionAvg,
        glassify_theme: glassifyAvg,
      },
    });
  } catch (err) {
    logger.error("Failed to return users/count", err);
    res.status(500).json({ error: "Failed to get stats" });
  }
});

app.get("/users/weekly-unique", async (_, res) => {
  try {
    const lucid = await getWeeklyUniqueUsers("lucid_theme");
    const lyrics = await getWeeklyUniqueUsers("lyrics_extension");
    const glass = await getWeeklyUniqueUsers("glassify_theme");

    res.status(200).json({
      weeklyUniqueAvg: {
        lucid_theme: lucid,
        lyrics_extension: lyrics,
        glassify_theme: glass,
      },
    });
  } catch (err) {
    logger.error("Failed to return weekly unique users", err);
    res.status(500).json({ error: "Failed to get weekly unique users" });
  }
});

async function broadcastStats() {
  try {
    const [themeCount, extensionCount, glassifyCount] = await Promise.all([
      getUsers("lucid_theme"),
      getUsers("lyrics_extension"),
      getUsers("glassify_theme"),
    ]);

    const [themeAvg, extensionAvg, glassifyAvg] = await Promise.all([
      cachedWeeklyAverage("lucid_theme"),
      cachedWeeklyAverage("lyrics_extension"),
      cachedWeeklyAverage("glassify_theme"),
    ]);

    const payload = {
      current: {
        lucid_theme: themeCount,
        lyrics_extension: extensionCount,
        glassify_theme: glassifyCount,
      },
      weeklyAvg: {
        lucid_theme: themeAvg,
        lyrics_extension: extensionAvg,
        glassify_theme: glassifyAvg,
      },
      timestamp: Date.now(),
    };

    publicNamespace.emit("userStats", payload);
  } catch (err) {
    logger.error("Failed to broadcast stats", err);
  }
}

const BROADCAST_INTERVAL_MS = 5_000;
setInterval(broadcastStats, BROADCAST_INTERVAL_MS);

broadcastStats().catch((err) =>
  logger.error("Initial broadcastStats failed", err)
);

httpServer.listen(PORT, () => {
  logger.info(`Server running on https://localhost:${PORT}`);
});

function formatDateISO(d: Date) {
  return d.toISOString().split("T")[0];
}

type CountOperation = "increment" | "decrement" | "get";

/**
 * updateUsersCount - uses atomic Redis commands (INCRBY / DECR)
 * and updates localCache as fallback.
 */
export async function updateUsersCount(
  type: AnalyticType,
  operation: CountOperation = "get"
) {
  const key = KEYS[type];

  try {
    let count: number;

    switch (operation) {
      case "increment": {
        const res = await client.incrBy(key, 1);
        count = Number(res ?? 0);
        break;
      }
      case "decrement": {
        const res = await client.decr(key);
        count = Number(res ?? 0);
        if (count < 0) {
          // correct to zero
          await client.set(key, "0");
          count = 0;
        }
        break;
      }
      default: {
        const value = await client.get(key);
        count = Number(value ?? 0);
        break;
      }
    }

    localCache[type] = count;

    if (operation !== "get") {
      publicNamespace.emit(type, count);
    }

    return count;
  } catch (err) {
    logger.error(`Failed to ${operation} ${type} active users`, err);
    return localCache[type];
  }
}

/**
 * logUserActivity - logs timestamp in a sorted set for retention,
 * increments a daily counter for fast weekly aggregation, and optionally
 * tracks unique user ids per-day (sAdd).
 */
export async function logUserActivity(type: AnalyticType, userId?: string) {
  const timestamp = Date.now();
  const zKey = `${HISTORICAL_KEY_PREFIX}:${type}`; // zset of timestamps
  const day = formatDateISO(new Date());
  const dailyKey = `${HISTORICAL_KEY_PREFIX}:${type}:daily:${day}`;
  const dayUniqueKey = `${HISTORICAL_KEY_PREFIX}:${type}:unique:${day}`;

  try {
    const tx = client.multi();

    tx.zAdd(zKey, { score: timestamp, value: String(timestamp) });

    tx.incr(dailyKey);
    tx.expire(dailyKey, 8 * 24 * 60 * 60);

    if (userId) {
      tx.sAdd(dayUniqueKey, userId);
      tx.expire(dayUniqueKey, 8 * 24 * 60 * 60);
    }

    const oneWeekAgo = timestamp - 7 * 24 * 60 * 60 * 1000;
    tx.zRemRangeByScore(zKey, 0, oneWeekAgo);

    await tx.exec();
  } catch (err) {
    logger.error("Failed to log user activity", err);
  }
}

/**
 * getWeeklyAverage - fast path: MGET last 7 daily counters and average
 */
export async function getWeeklyAverage(type: AnalyticType) {
  const today = new Date();
  const keys: string[] = [];

  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    keys.push(`${HISTORICAL_KEY_PREFIX}:${type}:daily:${formatDateISO(d)}`);
  }

  try {
    const values = await client.mGet(keys);
    const total = values.reduce((sum, v) => sum + Number(v ?? 0), 0);
    return total / 7;
  } catch (err) {
    logger.error("Failed to get weekly average", err);
    return 0;
  }
}

/**
 * getWeeklyUniqueUsers - compute daily unique users average for last 7 days
 */
export async function getWeeklyUniqueUsers(type: AnalyticType) {
  const today = new Date();
  const counts: number[] = [];

  try {
    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const dayKey = `${HISTORICAL_KEY_PREFIX}:${type}:unique:${formatDateISO(
        d
      )}`;
      const c = Number((await client.sCard(dayKey)) ?? 0);
      counts.push(c);
    }
    const total = counts.reduce((s, v) => s + v, 0);
    return total / 7;
  } catch (err) {
    logger.error("Failed to get weekly unique users", err);
    return 0;
  }
}

/**
 * cachedWeeklyAverage - in-memory 1-minute cache to reduce Redis load under high concurrency
 */
async function cachedWeeklyAverage(type: AnalyticType) {
  const now = Date.now();
  const cached = weeklyCache.get(type);
  if (cached && cached.expiresAt > now) return cached.value;

  const avg = await getWeeklyAverage(type);
  weeklyCache.set(type, { value: avg, expiresAt: now + 60 * 1000 });
  return avg;
}
