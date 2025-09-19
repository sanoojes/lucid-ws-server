import { Router } from "express";

const router = Router();
router.get("/ping", (_, res) => res.send("pong!"));

export default router;
