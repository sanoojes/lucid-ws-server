/// <reference lib="deno.ns" />

import { createServer } from "node:http";
import cors from "cors";
import express from "express";
import { createClient } from "redis";
import { Server } from "socket.io";
import logger from "./lib/logger.ts";

// ====================== CONFIG ======================
interface ThemeConfig {
  key: string;
  name: string;
}
const THEMES: Record<string, ThemeConfig> = {
  lucid_theme: { key: "lucid_theme:users", name: "Lucid Theme" },
  lyrics_extension: {
    key: "lucid_lyrics:users",
    name: "Lyrics Extension",
  },
  glassify_theme: {
    key: "glassify_theme:users",
    name: "Glassify Theme",
  },
  // new_theme: { key: "new_theme:users", name: "New Theme" },
};

const HISTORICAL_KEY_PREFIX = "lucid_activity";

type AnalyticType = keyof typeof THEMES;

// ====================== ENV ======================
const env = Deno.env.toObject();

if (!env.REDIS_URL || !env.JWT_SECRET) {
  logger.error("Missing env in environment.");
  Deno.exit(1);
}

// ====================== SERVER SETUP ======================
const app = express();
const httpServer = createServer(app);
const PORT = Number(env.PORT ?? 8989);

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

app.use(cors(CORS_OPTIONS));
app.use(express.json());

const io = new Server(httpServer, { cors: CORS_OPTIONS, pingInterval: 30_000 });

// ====================== REDIS ======================
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

// ====================== DATE CACHE ======================
function formatDateISO(d: Date) {
  return d.toISOString().split("T")[0];
}

let todayISO = formatDateISO(new Date());
let weekDates: string[] = getLast7Days(todayISO);

function getLast7Days(startISO: string): string[] {
  const base = new Date(startISO);
  const keys: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() - i);
    keys.push(formatDateISO(d));
  }
  return keys;
}

setInterval(() => {
  const nowISO = formatDateISO(new Date());
  if (nowISO !== todayISO) {
    todayISO = nowISO;
    weekDates = getLast7Days(todayISO);
    // logger.info("Rolled over daily ISO cache", todayISO);
  }
}, 60 * 1000);

// ====================== LOCAL CACHE ======================
const localCache: Record<AnalyticType, number> = Object.keys(THEMES).reduce(
  (acc, theme) => ({ ...acc, [theme]: 0 }),
  {} as Record<AnalyticType, number>
);

type CachedValue = { value: number; expiresAt: number };
const weeklyCache = new Map<AnalyticType, CachedValue>();

const incrementUsers = (type: AnalyticType) =>
  updateUsersCount(type, "increment");
const decrementUsers = (type: AnalyticType) =>
  updateUsersCount(type, "decrement");
const getUsers = (type: AnalyticType) => updateUsersCount(type, "get");

// ====================== PUBLIC NAMESPACE ======================
const publicNamespace = io.of("/ws/public");

publicNamespace.on("connection", async (socket) => {
  try {
    const stats = {
      current: Object.fromEntries(
        Object.keys(THEMES).map((t) => [t, localCache[t as AnalyticType]])
      ),
      weeklyAvg: Object.fromEntries(
        await Promise.all(
          Object.keys(THEMES).map(async (t) => [
            t,
            await cachedWeeklyAverage(t as AnalyticType),
          ])
        )
      ),
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
app.get("/", (_, res) => res.send("Welcome to Lucid Analytics Server !"));
app.get("/ping", (_, res) => res.status(200).send("pong!"));

app.get("/users/count", async (_, res) => {
  try {
    const current = Object.fromEntries(
      await Promise.all(
        Object.keys(THEMES).map(async (t) => [
          t,
          await getUsers(t as AnalyticType),
        ])
      )
    );

    const weeklyAvg = Object.fromEntries(
      await Promise.all(
        Object.keys(THEMES).map(async (t) => [
          t,
          await cachedWeeklyAverage(t as AnalyticType),
        ])
      )
    );

    res.status(200).json({ current, weeklyAvg });
  } catch (err) {
    logger.error("Failed to return users/count", err);
    res.status(500).json({ error: "Failed to get stats" });
  }
});

app.get("/users/weekly-unique", async (_, res) => {
  try {
    const weeklyUniqueAvg = Object.fromEntries(
      await Promise.all(
        Object.keys(THEMES).map(async (t) => [
          t,
          await getWeeklyUniqueUsers(t as AnalyticType),
        ])
      )
    );
    res.status(200).json({ weeklyUniqueAvg });
  } catch (err) {
    logger.error("Failed to return weekly unique users", err);
    res.status(500).json({ error: "Failed to get weekly unique users" });
  }
});

// ====================== BROADCAST ======================
async function broadcastStats() {
  try {
    const current = Object.fromEntries(
      await Promise.all(
        Object.keys(THEMES).map(async (t) => [
          t,
          await getUsers(t as AnalyticType),
        ])
      )
    );

    const weeklyAvg = Object.fromEntries(
      await Promise.all(
        Object.keys(THEMES).map(async (t) => [
          t,
          await cachedWeeklyAverage(t as AnalyticType),
        ])
      )
    );

    publicNamespace.emit("userStats", {
      current,
      weeklyAvg,
      timestamp: Date.now(),
    });
  } catch (err) {
    logger.error("Failed to broadcast stats", err);
  }
}

const BROADCAST_INTERVAL_MS = 5_000;
setInterval(broadcastStats, BROADCAST_INTERVAL_MS);
broadcastStats().catch((err) =>
  logger.error("Initial broadcastStats failed", err)
);

httpServer.listen(PORT, () =>
  logger.info(`Server running on https://localhost:${PORT}`)
);

// ====================== REDIS / USERS ======================
type CountOperation = "increment" | "decrement" | "get";

export async function updateUsersCount(
  type: AnalyticType,
  operation: CountOperation = "get"
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
          await client.set(key, "0");
          count = 0;
        }
        break;
      default:
        count = Number((await client.get(key)) ?? 0);
    }

    localCache[type] = count;
    if (operation !== "get") publicNamespace.emit(type, count);
    return count;
  } catch (err) {
    logger.error(`Failed to ${operation} ${type} active users`, err);
    return localCache[type];
  }
}

export async function logUserActivity(type: AnalyticType, userId?: string) {
  const timestamp = Date.now();
  const zKey = `${HISTORICAL_KEY_PREFIX}:${type}`;
  const dailyKey = `${HISTORICAL_KEY_PREFIX}:${type}:daily:${todayISO}`;
  const dayUniqueKey = `${HISTORICAL_KEY_PREFIX}:${type}:unique:${todayISO}`;

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

export async function getWeeklyAverage(type: AnalyticType) {
  const keys = weekDates.map(
    (date) => `${HISTORICAL_KEY_PREFIX}:${type}:daily:${date}`
  );
  try {
    const values = await client.mGet(keys);
    return values.reduce((sum, v) => sum + Number(v ?? 0), 0) / 7;
  } catch (err) {
    logger.error("Failed to get weekly average", err);
    return 0;
  }
}

export async function getWeeklyUniqueUsers(type: AnalyticType) {
  const keys = weekDates.map(
    (date) => `${HISTORICAL_KEY_PREFIX}:${type}:unique:${date}`
  );
  try {
    const uniqueUsers = await client.sUnion(keys);
    return uniqueUsers.length;
  } catch (err) {
    logger.error("Failed to get weekly unique users", err);
    return 0;
  }
}

async function cachedWeeklyAverage(type: AnalyticType) {
  const now = Date.now();
  const cached = weeklyCache.get(type);
  if (cached && cached.expiresAt > now) return cached.value;
  const avg = await getWeeklyAverage(type);
  weeklyCache.set(type, { value: avg, expiresAt: now + 60_000 });
  return avg;
}
