import { Router } from "express";

const router = Router();
router.get("/", (_, res) => res.send("Welcome to Lucid Analytics Server!"));
router.get("/ping", (_, res) => res.send("pong!"));

export default router;
