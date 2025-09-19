import { createServer } from "node:http";
import app from "./app.ts";
import { initSockets } from "./socket.ts";
import logger from "./utils/logger.ts";

if (!Deno.env.get("REDIS_URL")) {
  logger.error("Missing required environment variables: REDIS_URL");
  Deno.exit(1);
}

const PORT = Number(Deno.env.get("PORT") ?? 8989);
const httpServer = createServer(app);

initSockets(httpServer);

httpServer.listen(PORT, () =>
  logger.info(`Server running on http://localhost:${PORT}`)
);
