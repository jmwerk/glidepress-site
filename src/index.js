/**
 * GlidePress site Worker: serves the static showcase (from public/ via Workers
 * static assets — assets are matched before this code runs) and the private
 * Composer repository for glidepress/glidepress-slider.
 *
 * Composer routes (HTTP basic auth; the password is an access token):
 *   GET /packages.json                        Composer metadata for all published versions
 *   GET /dist/glidepress-slider-<ver>.zip     Dist archive for one version
 *
 * Admin API routes (Bearer auth with the ADMIN_KEY worker secret; the token
 * management UI itself is a static asset at public/admin/, served before this
 * code runs):
 *   GET    /admin/api/tokens                  List tokens
 *   POST   /admin/api/tokens {label}          Create a token
 *   DELETE /admin/api/tokens/<id>             Revoke a token (id from the list)
 *
 * KV schema (binding REPO):
 *   token:<sha256-hex-of-token> -> JSON { "label": "...", "created": "...", "prefix": "gp_1234567" }
 *   versions       -> JSON [ { "version", "sha1", "time" }, ... ]
 *   dist:<version> -> zip binary
 *
 * Legacy keys token:<plaintext-token> (pre-hashing) are still accepted by
 * authorize() and are migrated to the hashed form on first successful use.
 *
 * Rate limiting (binding AUTH_RATE_LIMITER, keyed on CF-Connecting-IP):
 * brute-force protection for both auth schemes. Composer routes consume one
 * unit per credentialed attempt *before* the KV token lookup, so over-limit
 * IPs are rejected with 429 without costing a KV read; admin API routes
 * consume one unit per failed Bearer attempt. See rateLimitExceeded().
 */

const PACKAGE = "glidepress/glidepress-slider";

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Consumes one unit from the per-IP limiter and reports whether the caller is
 * over the limit. The ratelimit binding has no read-only probe — limit() is
 * the whole API — so every call both counts and checks. Counters are per
 * Cloudflare location and eventually consistent (fine for brute-force
 * protection, not exact accounting). Fails open if the binding is missing
 * (e.g. local dev against an older config).
 */
async function rateLimitExceeded(request, env) {
	if (!env.AUTH_RATE_LIMITER) return false;
	// CF-Connecting-IP is always set on traffic that traverses Cloudflare;
	// the fallback only matters in local dev, where all requests share a bucket.
	const key = request.headers.get("CF-Connecting-IP") || "local";
	const { success } = await env.AUTH_RATE_LIMITER.limit({ key });
	return !success;
}

// Retry-After matches the limiter period configured in wrangler.toml.
const RATE_LIMIT_PERIOD = "60";

function tooManyRequests() {
	return new Response("Too many requests", {
		status: 429,
		headers: { "Retry-After": RATE_LIMIT_PERIOD },
	});
}

// ---------------------------------------------------------------------------
// Composer-facing routes
// ---------------------------------------------------------------------------

async function sha256Hex(text) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Extracts the token from the basic-auth header without touching KV, so the
// rate limiter can run between credential parsing and the token lookup.
function parseBasicToken(request) {
	const header = request.headers.get("Authorization") || "";
	const [scheme, encoded] = header.split(" ");
	if (scheme !== "Basic" || !encoded) return null;
	let decoded;
	try {
		decoded = atob(encoded);
	} catch {
		return null;
	}
	// Username is ignored; the token is the basic-auth password.
	const token = decoded.slice(decoded.indexOf(":") + 1);
	return token || null;
}

async function authorize(token, env) {
	const hash = await sha256Hex(token);
	const record = await env.REPO.get(`token:${hash}`, "json");
	if (record) return record;

	// Legacy plaintext key: migrate to the hashed form on first use.
	const legacy = await env.REPO.get(`token:${token}`, "json");
	if (!legacy) return null;
	const migrated = { ...legacy, prefix: token.slice(0, 10) };
	await env.REPO.put(`token:${hash}`, JSON.stringify(migrated));
	await env.REPO.delete(`token:${token}`);
	return migrated;
}

function unauthorized() {
	return new Response("Unauthorized", {
		status: 401,
		headers: { "WWW-Authenticate": 'Basic realm="glidepress-composer"' },
	});
}

async function handleComposer(request, env, url) {
	if (request.method !== "GET") {
		return new Response("Method not allowed", { status: 405 });
	}

	const isPackages = url.pathname === "/packages.json";
	const distMatch = url.pathname.match(/^\/dist\/glidepress-slider-([\w.-]+)\.zip$/);

	// Anything that isn't a Composer endpoint is a stray site URL — plain 404,
	// no basic-auth challenge (browsers would otherwise pop a login dialog).
	if (!isPackages && !distMatch) {
		return new Response("Not found", { status: 404 });
	}

	// No/malformed credentials: plain 401, no limiter unit and no KV read.
	const token = parseBasicToken(request);
	if (!token) return unauthorized();

	// One unit per credentialed attempt, consumed *before* the KV lookup so
	// over-limit IPs don't cost a read. The binding has no non-consuming
	// check, so requests with a valid token spend a unit too — the limit is
	// effectively "auth attempts per IP", sized well above legit Composer use.
	if (await rateLimitExceeded(request, env)) return tooManyRequests();

	const auth = await authorize(token, env);
	if (!auth) return unauthorized();

	if (isPackages) {
		const versions = (await env.REPO.get("versions", "json")) || [];
		const releases = versions.map((v) => ({
			name: PACKAGE,
			version: v.version,
			type: "wordpress-plugin",
			require: { php: ">=7.4" },
			dist: {
				type: "zip",
				url: `${url.origin}/dist/glidepress-slider-${v.version}.zip`,
				shasum: v.sha1,
			},
			time: v.time,
		}));
		return new Response(JSON.stringify({ packages: { [PACKAGE]: releases } }), {
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": "no-store",
			},
		});
	}

	const zip = await env.REPO.get(`dist:${distMatch[1]}`, "stream");
	if (!zip) return new Response("Not found", { status: 404 });
	return new Response(zip, {
		headers: {
			"Content-Type": "application/zip",
			"Cache-Control": "private, max-age=31536000, immutable",
		},
	});
}

// ---------------------------------------------------------------------------
// Admin routes
// ---------------------------------------------------------------------------

function timingSafeEqual(a, b) {
	const enc = new TextEncoder();
	const ab = enc.encode(a);
	const bb = enc.encode(b);
	if (ab.byteLength !== bb.byteLength) return false;
	return crypto.subtle.timingSafeEqual(ab, bb);
}

function adminAuthorized(request, env) {
	if (!env.ADMIN_KEY) return false; // secret not configured -> admin disabled
	const header = request.headers.get("Authorization") || "";
	const [scheme, key] = header.split(" ");
	return scheme === "Bearer" && key && timingSafeEqual(key, env.ADMIN_KEY);
}

function json(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
	});
}

async function handleAdmin(request, env, url) {
	if (!adminAuthorized(request, env)) {
		// Failed Bearer attempts consume a unit; once an IP is over the limit
		// it gets 429 instead of 401. (Valid-key requests never touch the
		// limiter, and no KV is read before this point on admin routes.)
		if (await rateLimitExceeded(request, env)) {
			const res = json({ error: "too many requests" }, 429);
			res.headers.set("Retry-After", RATE_LIMIT_PERIOD);
			return res;
		}
		return json({ error: "unauthorized" }, 401);
	}

	if (url.pathname === "/admin/api/tokens") {
		if (request.method === "GET") {
			const list = await env.REPO.list({ prefix: "token:" });
			const tokens = await Promise.all(
				list.keys.map(async (k) => {
					const id = k.name.slice("token:".length);
					const meta = (await env.REPO.get(k.name, "json")) || {};
					// Legacy (unmigrated) keys hold the plaintext token in the key
					// itself and have no stored prefix — derive it for display.
					return { id, prefix: meta.prefix || id.slice(0, 10), label: meta.label, created: meta.created };
				})
			);
			tokens.sort((a, b) => (a.created || "").localeCompare(b.created || ""));
			return json(tokens);
		}
		if (request.method === "POST") {
			let body;
			try {
				body = await request.json();
			} catch {
				return json({ error: "invalid JSON body" }, 400);
			}
			const label = (body.label || "").trim();
			if (!label || label.length > 64) {
				return json({ error: "label is required (max 64 chars)" }, 400);
			}
			const bytes = new Uint8Array(24);
			crypto.getRandomValues(bytes);
			const token = `gp_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
			const record = { label, created: new Date().toISOString(), prefix: token.slice(0, 10) };
			await env.REPO.put(`token:${await sha256Hex(token)}`, JSON.stringify(record));
			// The only response that ever contains the plaintext token.
			return json({ token, ...record }, 201);
		}
		return json({ error: "method not allowed" }, 405);
	}

	// Hash ids are 64 hex chars; legacy unmigrated ids are the gp_ token itself.
	const match = url.pathname.match(/^\/admin\/api\/tokens\/([0-9a-f]{64}|gp_[0-9a-f]+)$/);
	if (match && request.method === "DELETE") {
		await env.REPO.delete(`token:${match[1]}`);
		return json({ ok: true });
	}

	return json({ error: "not found" }, 404);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
			return handleAdmin(request, env, url);
		}
		return handleComposer(request, env, url);
	},
};
