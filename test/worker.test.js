/**
 * Tests for the glidepress-site Worker. Runs inside workerd via
 * @cloudflare/vitest-pool-workers; `env` carries the real bindings from
 * wrangler.toml (REPO KV is isolated and reset between tests).
 *
 * The worker is invoked unit-style (imported default export) so each test can
 * shape `env`: adding/omitting the ADMIN_KEY secret, and stubbing
 * AUTH_RATE_LIMITER so the per-IP limiter never interferes with test volume.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker, { adminAuthorized } from "../src/index.js";

const ORIGIN = "https://glidepress.example.com";
const ADMIN_KEY = "test-admin-key";

// Every allowance granted: tests target auth/routing logic, not the limiter.
const openLimiter = { limit: async () => ({ success: true }) };

function testEnv(overrides = {}) {
	return { ...env, AUTH_RATE_LIMITER: openLimiter, ...overrides };
}

function fetchWorker(path, init = {}, envOverrides = {}) {
	return worker.fetch(new Request(`${ORIGIN}${path}`, init), testEnv(envOverrides));
}

function basicAuth(token) {
	// Composer sends the token as the basic-auth password; username is ignored.
	return { Authorization: `Basic ${btoa(`token:${token}`)}` };
}

async function sha256Hex(text) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const TOKEN = `gp_${"ab".repeat(24)}`; // gp_ + 48 hex chars, like real tokens

async function seedToken(token = TOKEN) {
	await env.REPO.put(
		`token:${await sha256Hex(token)}`,
		JSON.stringify({ label: "test", created: "2026-01-01T00:00:00.000Z", prefix: token.slice(0, 10) })
	);
	return token;
}

describe("Composer routes", () => {
	it("GET /packages.json without auth returns 401 with a Basic challenge", async () => {
		const res = await fetchWorker("/packages.json");
		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toBe('Basic realm="glidepress-composer"');
	});

	it("GET /packages.json with a valid token returns the Composer package shape", async () => {
		await seedToken();
		await env.REPO.put(
			"versions",
			JSON.stringify([
				{ version: "1.0.0", sha1: "da39a3ee5e6b4b0d3255bfef95601890afd80709", time: "2026-01-02T00:00:00+00:00" },
			])
		);

		const res = await fetchWorker("/packages.json", { headers: basicAuth(TOKEN) });
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/json");

		const body = await res.json();
		const releases = body.packages["glidepress/glidepress-slider"];
		expect(releases).toHaveLength(1);
		expect(releases[0]).toEqual({
			name: "glidepress/glidepress-slider",
			version: "1.0.0",
			type: "wordpress-plugin",
			require: { php: ">=7.4" },
			dist: {
				type: "zip",
				// dist URLs are built from the request origin, not a hardcoded host
				url: `${ORIGIN}/dist/glidepress-slider-1.0.0.zip`,
				shasum: "da39a3ee5e6b4b0d3255bfef95601890afd80709",
			},
			time: "2026-01-02T00:00:00+00:00",
		});
	});

	it("GET /dist/glidepress-slider-1.0.0.zip streams the KV blob with auth", async () => {
		await seedToken();
		const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]); // "PK.." + payload
		await env.REPO.put("dist:1.0.0", zipBytes);

		const res = await fetchWorker("/dist/glidepress-slider-1.0.0.zip", { headers: basicAuth(TOKEN) });
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/zip");
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(zipBytes);
	});

	it("GET /dist for a missing version returns 404", async () => {
		await seedToken();
		const res = await fetchWorker("/dist/glidepress-slider-9.9.9.zip", { headers: basicAuth(TOKEN) });
		expect(res.status).toBe(404);
	});

	it("non-Composer paths return 404 with NO Basic challenge", async () => {
		// A browser hitting a stray URL must not get a login popup.
		const res = await fetchWorker("/no-such-page");
		expect(res.status).toBe(404);
		expect(res.headers.get("WWW-Authenticate")).toBeNull();
	});
});

describe("Admin API", () => {
	const withAdmin = { ADMIN_KEY };
	const bearer = { Authorization: `Bearer ${ADMIN_KEY}` };

	function postTokens(body, headers = bearer, envOverrides = withAdmin) {
		return fetchWorker(
			"/admin/api/tokens",
			{
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify(body),
			},
			envOverrides
		);
	}

	it("POST /admin/api/tokens rejects a missing label", async () => {
		const res = await postTokens({});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/label/);
	});

	it("POST /admin/api/tokens rejects an oversized label", async () => {
		const res = await postTokens({ label: "x".repeat(65) });
		expect(res.status).toBe(400);
	});

	it("POST /admin/api/tokens creates a gp_-prefixed 48-hex-char token and stores its hash", async () => {
		const res = await postTokens({ label: "ci token" });
		expect(res.status).toBe(201);

		const body = await res.json();
		expect(body.token).toMatch(/^gp_[0-9a-f]{48}$/);
		expect(body.label).toBe("ci token");
		expect(body.prefix).toBe(body.token.slice(0, 10));

		// Only the SHA-256 hash lands in KV — never the plaintext token.
		const stored = await env.REPO.get(`token:${await sha256Hex(body.token)}`, "json");
		expect(stored).toMatchObject({ label: "ci token", prefix: body.token.slice(0, 10) });
		expect(await env.REPO.get(`token:${body.token}`)).toBeNull();
	});

	it("POST /admin/api/tokens requires the Bearer ADMIN_KEY", async () => {
		const noAuth = await postTokens({ label: "nope" }, {});
		expect(noAuth.status).toBe(401);

		const wrongKey = await postTokens({ label: "nope" }, { Authorization: "Bearer wrong-key" });
		expect(wrongKey.status).toBe(401);
	});

	it("DELETE /admin/api/tokens/<id> removes the KV key", async () => {
		await seedToken();
		const id = await sha256Hex(TOKEN);
		expect(await env.REPO.get(`token:${id}`)).not.toBeNull();

		const res = await fetchWorker(`/admin/api/tokens/${id}`, { method: "DELETE", headers: bearer }, withAdmin);
		expect(res.status).toBe(200);
		expect(await env.REPO.get(`token:${id}`)).toBeNull();
	});

	it("adminAuthorized returns false when ADMIN_KEY is unset", () => {
		const request = new Request(`${ORIGIN}/admin/api/tokens`, {
			headers: { Authorization: "Bearer anything" },
		});
		// No ADMIN_KEY in env -> admin is disabled, even with a Bearer header.
		expect(adminAuthorized(request, {})).toBe(false);
	});
});
