import { resolve } from "node:path";
import cors from "cors";
import express from "express";
import healthRoutes from "./routes/health.ts";
import userRoutes from "./routes/users.ts";

const app = express();

export const CORS_OPTIONS = {
	origin: [
		"https://xpui.app.spotify.com",
		"https://spicetify-projects.sanooj.uk",
		"https://analytics-spicetify-projects.sanooj.uk",
		"http://localhost:8787",
	],
	methods: ["GET", "POST"],
	allowedHeaders: ["Content-Type", "Authorization"],
	credentials: true,
	maxAge: 3600,
};

app.use(cors(CORS_OPTIONS));
app.use(express.json());
app.use(express.static("public"));

app.use("/", healthRoutes);
app.use("/users", userRoutes);

app.get("/", (_, res) =>
	res.status(404).sendFile(resolve("public/index.html")),
);

app.use((_, res) => {
	res.status(404).sendFile(resolve("public/404.html"));
});

export default app;
