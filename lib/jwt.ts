import { jwtVerify, SignJWT } from "jose";

const SECRET = new TextEncoder().encode(
	Deno.env.get("JWT_SECRET") ?? "supersecretjwtkey",
);

export async function signToken(
	payload: Record<string, any>,
	expiresIn: string = "1h",
) {
	const token = await new SignJWT(payload)
		.setProtectedHeader({ alg: "HS256" })
		.setExpirationTime(expiresIn)
		.sign(SECRET);

	return token;
}

export async function verifyToken(token: string) {
	try {
		const { payload } = await jwtVerify(token, SECRET);
		return payload;
	} catch {
		return null;
	}
}
