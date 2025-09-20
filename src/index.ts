import { createServer } from "node:http";
import app from "./app.ts";
import { initSockets } from "./socket.ts";
import logger from "./utils/logger.ts";

if (!process.env.REDIS_URL) {
	logger.error("Missing required environment variables: REDIS_URL");
	process.exit(1);
}

const PORT = Number(process.env.PORT ?? 3000);
const httpServer = createServer(app);

initSockets(httpServer);

httpServer.listen(PORT, () =>
	logger.info(`Server running on http://localhost:${PORT}`),
);
