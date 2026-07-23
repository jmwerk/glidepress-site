/**
 * Tests for the glidepress-site Worker. Runs inside workerd via
 * @cloudflare/vitest-pool-workers; `env` carries the real bindings from
 * wrangler.toml. REPO KV state persists across tests within a run, so tests
 * seed distinct keys (or overwrite) rather than assuming a clean namespace.
 *
 * The worker is invoked unit-style (imported default export) so each test can
 * shape `env`: adding/omitting the ADMIN_KEY secret, and stubbing
 * AUTH_RATE_LIMITER so the per-IP limiter never interferes with test volume.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker, { adminAuthorized } from "../src/index.js";

const ORIGIN = "https://glidepress.example.com";
const ADMIN_KEY = "test-admin-key";

// Every allowance granted: tests target auth/routing logic, not the limiter.
const openLimiter = { limit: async () => ({ success: true }) };

function testEnv(overrides = {}) {
	return { ...env, AUTH_RATE_LIMITER: openLimiter, ...overrides };
}

async function fetchWorker(path, init = {}, envOverrides = {}) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(`${ORIGIN}${path}`, init), testEnv(envOverrides), ctx);
	// Let waitUntil() work (usage recording) settle before assertions.
	await waitOnExecutionContext(ctx);
	return res;
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

	it("packages.json prefers per-version require/type/extra from KV over the fallbacks", async () => {
		await seedToken();
		await env.REPO.put(
			"versions",
			JSON.stringify([
				// Bare entry (pre-dates the optional fields) -> fallbacks.
				{ version: "1.0.0", sha1: "a".repeat(40), time: "2026-01-02T00:00:00+00:00" },
				// Entry with CI-published metadata -> used verbatim.
				{
					version: "2.0.0",
					sha1: "b".repeat(40),
					time: "2026-03-01T00:00:00+00:00",
					require: { php: ">=8.1", "composer/installers": "^2.0" },
					type: "wordpress-muplugin",
					extra: { "installer-name": "glidepress-slider" },
				},
			])
		);

		const res = await fetchWorker("/packages.json", { headers: basicAuth(TOKEN) });
		const releases = (await res.json()).packages["glidepress/glidepress-slider"];

		expect(releases[0]).toMatchObject({
			version: "1.0.0",
			type: "wordpress-plugin",
			require: { php: ">=7.4" },
		});
		expect(releases[0]).not.toHaveProperty("extra");
		expect(releases[1]).toMatchObject({
			version: "2.0.0",
			type: "wordpress-muplugin",
			require: { php: ">=8.1", "composer/installers": "^2.0" },
			extra: { "installer-name": "glidepress-slider" },
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

	it("dist responses carry an ETag from the version's sha1 and answer If-None-Match with 304", async () => {
		await seedToken();
		const sha1 = "c".repeat(40);
		await env.REPO.put(
			"versions",
			JSON.stringify([{ version: "2.5.0", sha1, time: "2026-04-01T00:00:00+00:00" }])
		);
		await env.REPO.put("dist:2.5.0", new Uint8Array([0x50, 0x4b, 0x03, 0x04]));

		const path = "/dist/glidepress-slider-2.5.0.zip";
		const full = await fetchWorker(path, { headers: basicAuth(TOKEN) });
		expect(full.status).toBe(200);
		expect(full.headers.get("ETag")).toBe(`"${sha1}"`);

		// Matching validator (strong or weak) -> 304 with no body.
		for (const ifNoneMatch of [`"${sha1}"`, `W/"${sha1}"`, `"other", "${sha1}"`]) {
			const res = await fetchWorker(path, {
				headers: { ...basicAuth(TOKEN), "If-None-Match": ifNoneMatch },
			});
			expect(res.status).toBe(304);
			expect(res.headers.get("ETag")).toBe(`"${sha1}"`);
			expect(await res.text()).toBe("");
		}

		// Stale validator -> full 200 body.
		const stale = await fetchWorker(path, {
			headers: { ...basicAuth(TOKEN), "If-None-Match": `"${"d".repeat(40)}"` },
		});
		expect(stale.status).toBe(200);
		expect(new Uint8Array(await stale.arrayBuffer())).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
	});

	it("dist for a version absent from the versions list has no ETag and ignores If-None-Match", async () => {
		await seedToken();
		await env.REPO.put("versions", JSON.stringify([]));
		await env.REPO.put("dist:0.9.9", new Uint8Array([0x50, 0x4b, 0x03, 0x04]));

		const res = await fetchWorker("/dist/glidepress-slider-0.9.9.zip", {
			headers: { ...basicAuth(TOKEN), "If-None-Match": "*" },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("ETag")).toBeNull();
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

describe("Changelog page", () => {
	it("lists published versions newest first with release dates, no auth required", async () => {
		await env.REPO.put(
			"versions",
			JSON.stringify([
				{ version: "4.0.0", sha1: "a".repeat(40), time: "2026-01-15T00:00:00+00:00" },
				{ version: "4.1.0", sha1: "b".repeat(40), time: "2026-05-20T00:00:00+00:00" },
			])
		);

		const res = await fetchWorker("/changelog");
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
		expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
		// _headers doesn't apply to Worker responses — the security headers the
		// static pages get must be set here explicitly.
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(res.headers.get("X-Frame-Options")).toBe("DENY");
		expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");

		const html = await res.text();
		expect(html).toContain("4.1.0");
		expect(html).toContain("4.0.0");
		expect(html.indexOf("4.1.0")).toBeLessThan(html.indexOf("4.0.0")); // newest first
		expect(html).toContain('datetime="2026-05-20"');
		expect(html).toContain('datetime="2026-01-15"');
	});

	it("never renders sha1 hashes or dist URLs", async () => {
		const sha1 = "e".repeat(40);
		await env.REPO.put(
			"versions",
			JSON.stringify([{ version: "4.2.0", sha1, time: "2026-06-01T00:00:00+00:00" }])
		);

		const html = await (await fetchWorker("/changelog")).text();
		expect(html).not.toContain(sha1);
		expect(html).not.toContain("/dist/");
	});

	it("renders notes as escaped paragraphs and bullet lists", async () => {
		await env.REPO.put(
			"versions",
			JSON.stringify([
				{
					version: "4.3.0",
					sha1: "f".repeat(40),
					time: "2026-07-01T00:00:00+00:00",
					notes:
						"Intro with <script>alert(1)</script> & a soft\nwrap.\n\n" +
						"- Added *a thing*\n* Fixed another\n\nClosing paragraph.",
				},
			])
		);

		const html = await (await fetchWorker("/changelog")).text();
		// Escaped, not executed; soft wrap joined into one paragraph.
		expect(html).toContain("<p>Intro with &lt;script&gt;alert(1)&lt;/script&gt; &amp; a soft wrap.</p>");
		expect(html).not.toContain("<script>alert(1)</script>");
		// "- " and "* " lines become one list; other markdown stays literal.
		expect(html).toContain("<ul><li>Added *a thing*</li><li>Fixed another</li></ul>");
		expect(html).toContain("<p>Closing paragraph.</p>");
	});

	it("shows an empty state when no versions are published", async () => {
		await env.REPO.put("versions", JSON.stringify([]));
		const html = await (await fetchWorker("/changelog")).text();
		expect(html).toContain("No releases have been published yet.");
	});

	it("answers HEAD with headers and no body", async () => {
		await env.REPO.put("versions", JSON.stringify([]));
		const res = await fetchWorker("/changelog", { method: "HEAD" });
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
	});

	it("rejects non-GET/HEAD methods with 405", async () => {
		const res = await fetchWorker("/changelog", { method: "POST" });
		expect(res.status).toBe(405);
	});
});

describe("Live demo", () => {
	// A published release plus its zip, newest last so ordering is exercised.
	async function seedReleases() {
		await env.REPO.put(
			"versions",
			JSON.stringify([
				{ version: "5.1.0", sha1: "1".repeat(40), time: "2026-06-01T00:00:00+00:00" },
				{ version: "5.0.0", sha1: "0".repeat(40), time: "2026-02-01T00:00:00+00:00" },
			])
		);
		await env.REPO.put("dist:5.1.0", "PK-newest");
		await env.REPO.put("dist:5.0.0", "PK-older");
	}

	it("serves the page without auth, framing only the Playground origin", async () => {
		await seedReleases();
		const res = await fetchWorker("/demo");
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
		// The one page that frames another origin — everything else stays 'self'.
		const csp = res.headers.get("Content-Security-Policy");
		expect(csp).toContain("frame-src https://playground.wordpress.net");
		expect(csp).toContain("script-src 'self'");

		const html = await res.text();
		expect(html).toContain('data-blueprint="https://glidepress.example.com/demo/blueprint.json"');
		// Tells the visitor what they're about to run.
		expect(html).toContain("5.1.0");
	});

	it("serves the newest release zip publicly, with CORS for the Playground origin", async () => {
		await seedReleases();
		const res = await fetchWorker("/demo/glidepress-slider.zip");
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/zip");
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
		// Decoded rather than .text()'d: the runtime warns about reading a
		// zip-typed body as text.
		expect(new TextDecoder().decode(await res.arrayBuffer())).toBe("PK-newest");
	});

	it("builds a blueprint that installs that zip and seeds the editor", async () => {
		await seedReleases();
		const res = await fetchWorker("/demo/blueprint.json");
		expect(res.status).toBe(200);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");

		const blueprint = await res.json();
		expect(blueprint.landingPage).toBe("/wp-admin/post-new.php");

		const install = blueprint.steps.find((s) => s.step === "installPlugin");
		// Zip URL follows the request origin rather than a hardcoded hostname.
		expect(install.pluginData.url).toBe("https://glidepress.example.com/demo/glidepress-slider.zip");
		expect(install.options.activate).toBe(true);

		const files = blueprint.steps.filter((s) => s.step === "writeFile");
		expect(files.map((f) => f.path)).toEqual([
			"/wordpress/wp-content/mu-plugins/glidepress-demo.js",
			"/wordpress/wp-content/mu-plugins/glidepress-demo.php",
		]);
		// The seed builds blocks from the registered types rather than pasting
		// saved markup — see the header comment in src/demo.js.
		expect(files[0].data).toContain("wp.blocks.createBlock");
		expect(files[0].data).toContain("glidepress/slider");
		expect(files[0].data).toContain("isCleanNewPost");
	});

	it("seeds a kitchen sink covering every slider feature", async () => {
		await seedReleases();
		const blueprint = await (await fetchWorker("/demo/blueprint.json")).json();
		const seed = blueprint.steps.find((s) => s.step === "writeFile" && s.path.endsWith(".js")).data;

		// Every effect, and the settings that are easy to forget to demo.
		for (const attribute of [
			"'fade'",
			"'flip'",
			"'creative'",
			"autoplayShowPauseButton",
			"overflow: true",
			"equalHeight",
			"arrowBorderRadius",
			"paginationColorInactive",
			"hideOnMobile",
			"hideOnTablet",
			"hideOnDesktop",
			"align: 'full'",
			"slidesPerViewDesktop",
		]) {
			expect(seed, `seed is missing ${attribute}`).toContain(attribute);
		}
	});

	it("keeps seeded values inside the ranges the block sanitiser enforces", async () => {
		await seedReleases();
		const blueprint = await (await fetchWorker("/demo/blueprint.json")).json();
		const seed = blueprint.steps.find((s) => s.step === "writeFile" && s.path.endsWith(".js")).data;

		// sanitizeSwiperConfig clamps out-of-range values silently, so a demo
		// that overshoots would quietly show something other than it claims.
		const bounds = {
			speed: [100, 2000],
			autoplayDelay: [500, 10000],
			arrowSize: [24, 80],
			arrowBorderRadius: [0, 50],
			paginationSize: [4, 24],
			slidesPerViewMobile: [1, 6],
			slidesPerViewTablet: [1, 6],
			slidesPerViewDesktop: [1, 6],
			spaceBetweenMobile: [0, 100],
			spaceBetweenTablet: [0, 100],
			spaceBetweenDesktop: [0, 100],
		};

		for (const [name, [min, max]] of Object.entries(bounds)) {
			for (const match of seed.matchAll(new RegExp(`${name}: (\\d+)`, "g"))) {
				const value = Number(match[1]);
				expect(value, `${name}: ${value} is outside ${min}-${max}`).toBeGreaterThanOrEqual(min);
				expect(value, `${name}: ${value} is outside ${min}-${max}`).toBeLessThanOrEqual(max);
			}
		}
	});

	it("answers the Private Network Access preflight on both fetched routes", async () => {
		// Chrome preflights a public https page fetching 127.0.0.1 and needs an
		// explicit opt-in; a 405 here means the demo can't run against
		// `wrangler dev` at all. Deployed, these routes are never preflighted.
		for (const path of ["/demo/blueprint.json", "/demo/glidepress-slider.zip"]) {
			const res = await fetchWorker(path, {
				method: "OPTIONS",
				headers: {
					Origin: "https://playground.wordpress.net",
					"Access-Control-Request-Method": "GET",
					"Access-Control-Request-Private-Network": "true",
				},
			});
			expect(res.status).toBe(204);
			expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
			expect(res.headers.get("Access-Control-Allow-Private-Network")).toBe("true");
		}
	});

	it("omits the private-network opt-in when the preflight didn't ask for it", async () => {
		const res = await fetchWorker("/demo/blueprint.json", {
			method: "OPTIONS",
			headers: { Origin: "https://example.com", "Access-Control-Request-Method": "GET" },
		});
		expect(res.status).toBe(204);
		expect(res.headers.get("Access-Control-Allow-Private-Network")).toBeNull();
	});

	it("404s the zip when the newest release has no archive in KV", async () => {
		await env.REPO.put(
			"versions",
			JSON.stringify([{ version: "9.9.9", sha1: "c".repeat(40), time: "2026-08-01T00:00:00+00:00" }])
		);
		const res = await fetchWorker("/demo/glidepress-slider.zip");
		expect(res.status).toBe(404);
	});

	it("404s an unknown /demo path and rejects non-GET methods", async () => {
		await seedReleases();
		expect((await fetchWorker("/demo/nope")).status).toBe(404);
		expect((await fetchWorker("/demo", { method: "POST" })).status).toBe(405);
		expect((await fetchWorker("/demo/glidepress-slider.zip", { method: "POST" })).status).toBe(405);
	});
});

describe("usage tracking", () => {
	const tokenKey = async () => `token:${await sha256Hex(TOKEN)}`;

	it("records lastUsed (but no download count) on a packages.json fetch", async () => {
		await seedToken();
		await env.REPO.put("versions", JSON.stringify([]));

		const res = await fetchWorker("/packages.json", { headers: basicAuth(TOKEN) });
		expect(res.status).toBe(200);

		const record = await env.REPO.get(await tokenKey(), "json");
		expect(record.lastUsed).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(record.downloads).toBeUndefined();
	});

	it("increments downloads on each dist fetch", async () => {
		await seedToken();
		await env.REPO.put("dist:1.0.0", new Uint8Array([0x50, 0x4b, 0x03, 0x04]));

		await fetchWorker("/dist/glidepress-slider-1.0.0.zip", { headers: basicAuth(TOKEN) });
		await fetchWorker("/dist/glidepress-slider-1.0.0.zip", { headers: basicAuth(TOKEN) });

		const record = await env.REPO.get(await tokenKey(), "json");
		expect(record.downloads).toBe(2);
	});

	it("skips the KV write when lastUsed is already today and it's not a download", async () => {
		const earlierToday = new Date().toISOString().slice(0, 10) + "T00:00:00.000Z";
		await env.REPO.put(
			`token:${await sha256Hex(TOKEN)}`,
			JSON.stringify({ label: "test", prefix: TOKEN.slice(0, 10), lastUsed: earlierToday })
		);
		await env.REPO.put("versions", JSON.stringify([]));

		const res = await fetchWorker("/packages.json", { headers: basicAuth(TOKEN) });
		expect(res.status).toBe(200);

		// Unchanged lastUsed proves no write happened.
		const record = await env.REPO.get(await tokenKey(), "json");
		expect(record.lastUsed).toBe(earlierToday);
	});

	it("surfaces lastUsed and downloads in the admin token list", async () => {
		await env.REPO.put(
			`token:${await sha256Hex(TOKEN)}`,
			JSON.stringify({
				label: "test",
				created: "2026-01-01T00:00:00.000Z",
				prefix: TOKEN.slice(0, 10),
				lastUsed: "2026-07-01T12:00:00.000Z",
				downloads: 7,
			})
		);

		const res = await fetchWorker(
			"/admin/api/tokens",
			{ headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
			{ ADMIN_KEY }
		);
		expect(res.status).toBe(200);
		const [token] = await res.json();
		expect(token.lastUsed).toBe("2026-07-01T12:00:00.000Z");
		expect(token.downloads).toBe(7);
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

	it("GET /admin/api/versions lists releases newest first with dist presence and size", async () => {
		// Versions distinct from other tests' — dist: keys persist across tests.
		await env.REPO.put(
			"versions",
			JSON.stringify([
				{ version: "3.0.0", sha1: "a".repeat(40), time: "2026-01-01T00:00:00+00:00" },
				{ version: "3.1.0", sha1: "b".repeat(40), time: "2026-02-01T00:00:00+00:00" },
			])
		);
		// 3.1.0's zip carries a size in KV metadata; 3.0.0 has no zip at all.
		await env.REPO.put("dist:3.1.0", new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
			metadata: { size: 4 },
		});

		const res = await fetchWorker("/admin/api/versions", { headers: bearer }, withAdmin);
		expect(res.status).toBe(200);
		const releases = await res.json();
		expect(releases.map((r) => r.version)).toEqual(["3.1.0", "3.0.0"]);
		expect(releases[0]).toMatchObject({ version: "3.1.0", sha1: "b".repeat(40), dist: true, size: 4 });
		expect(releases[1]).toMatchObject({ version: "3.0.0", dist: false, size: null });
	});

	it("GET /admin/api/versions requires the Bearer ADMIN_KEY", async () => {
		const res = await fetchWorker("/admin/api/versions", {}, withAdmin);
		expect(res.status).toBe(401);
	});

	it("DELETE /admin/api/versions/<version> removes the zip and the version entry, keeping others", async () => {
		await env.REPO.put(
			"versions",
			JSON.stringify([
				{ version: "1.0.0", sha1: "a".repeat(40), time: "2026-01-01T00:00:00+00:00" },
				{ version: "1.1.0", sha1: "b".repeat(40), time: "2026-02-01T00:00:00+00:00" },
			])
		);
		await env.REPO.put("dist:1.1.0", new Uint8Array([0x50, 0x4b, 0x03, 0x04]));

		const res = await fetchWorker("/admin/api/versions/1.1.0", { method: "DELETE", headers: bearer }, withAdmin);
		expect(res.status).toBe(200);

		expect(await env.REPO.get("dist:1.1.0")).toBeNull();
		const remaining = await env.REPO.get("versions", "json");
		expect(remaining.map((v) => v.version)).toEqual(["1.0.0"]);
	});

	it("adminAuthorized returns false when ADMIN_KEY is unset", () => {
		const request = new Request(`${ORIGIN}/admin/api/tokens`, {
			headers: { Authorization: "Bearer anything" },
		});
		// No ADMIN_KEY in env -> admin is disabled, even with a Bearer header.
		expect(adminAuthorized(request, {})).toBe(false);
	});
});
