/**
 * Shared security primitives: hashing, constant-time comparison, and the
 * per-IP rate limiter. Lives here rather than in index.js because src/demo.js
 * needs the same pieces to sign and verify its download URLs, and a
 * constant-time compare is not something to keep two copies of.
 */

export async function sha256Hex(text) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** HMAC-SHA256 of `message` under `key`, hex encoded. */
export async function hmacSha256Hex(key, message) {
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(key),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);
	const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
	return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a, b) {
	const enc = new TextEncoder();
	const ab = enc.encode(a);
	const bb = enc.encode(b);
	// Length is not secret here (both sides are fixed-width hex digests), and
	// timingSafeEqual throws on a mismatch, so it has to be checked first.
	if (ab.byteLength !== bb.byteLength) return false;
	return crypto.subtle.timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

// Matches the limiter period configured in wrangler.toml.
export const RATE_LIMIT_PERIOD = "60";

/**
 * Consumes one unit from the per-IP limiter and reports whether the caller is
 * over the limit. The ratelimit binding has no read-only probe — limit() is
 * the whole API — so every call both counts and checks. Counters are per
 * Cloudflare location and eventually consistent (fine for brute-force
 * protection, not exact accounting). Fails open if the binding is missing
 * (e.g. local dev against an older config).
 */
export async function rateLimitExceeded(request, env) {
	if (!env.AUTH_RATE_LIMITER) return false;
	// CF-Connecting-IP is always set on traffic that traverses Cloudflare;
	// the fallback only matters in local dev, where all requests share a bucket.
	const key = request.headers.get("CF-Connecting-IP") || "local";
	const { success } = await env.AUTH_RATE_LIMITER.limit({ key });
	return !success;
}

export function tooManyRequests() {
	return new Response("Too many requests", {
		status: 429,
		headers: { "Retry-After": RATE_LIMIT_PERIOD },
	});
}
