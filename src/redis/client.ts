import { createClient } from "redis";
import logger from "../utils/logger.ts";

export const client = createClient({ url: Deno.env.get("REDIS_URL") });

client.on("connect", () => logger.info("Redis Client Connected"));
client.on("disconnect", () => logger.warn("Redis Client Disconnected"));
client.on("error", (err) => logger.error("Redis Client Error", err));

await client.connect();
