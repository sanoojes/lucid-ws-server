import type { NextFunction, Request, Response } from "express";

export function requireAdminKey(
	req: Request,
	res: Response,
	next: NextFunction,
) {
	const authHeader = req.headers["authorization"];
	const adminKey = Deno.env.get("ADMIN_KEY");

	if (!adminKey) {
		return res
			.status(500)
			.json({ success: false, error: "ADMIN_KEY not configured" });
	}

	if (!authHeader || authHeader !== `Bearer ${adminKey}`) {
		return res
			.status(403)
			.json({ success: false, error: "Forbidden: Invalid admin key" });
	}

	next();
}
