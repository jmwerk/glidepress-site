/**
 * GlidePress site Worker: serves the static showcase (from public/ via Workers
 * static assets — assets are matched before this code runs) and the private
 * Composer repository for glidepress/glidepress-slider.
 *
 * Composer routes (HTTP basic auth; the password is an access token):
 *   GET /packages.json                        Composer metadata for all published versions
 *   GET /dist/glidepress-slider-<ver>.zip     Dist archive for one version
 *
 * Public routes (no auth — see handleChangelog for the reasoning):
 *   GET /changelog                            Server-rendered release history page
 *
 * Dist responses carry an ETag (the zip's sha1, quoted) and answer a matching
 * If-None-Match with 304. packages.json intentionally has no ETag: Composer 2
 * revalidates repo metadata only via If-Modified-Since/Last-Modified
 * (ComposerRepository::fetchFileIfLastModified; CurlDownloader has no
 * If-None-Match support), so a metadata ETag would never be exercised.
 *
 * Admin API routes (Bearer auth with the ADMIN_KEY worker secret; the token
 * management UI itself is a static asset at public/admin/, served before this
 * code runs):
 *   GET    /admin/api/tokens                  List tokens
 *   POST   /admin/api/tokens {label}          Create a token
 *   DELETE /admin/api/tokens/<id>             Revoke a token (id from the list)
 *   GET    /admin/api/versions                List published releases + dist status
 *   DELETE /admin/api/versions/<version>      Pull a release (zip + version entry)
 *
 * KV schema (binding REPO):
 *   token:<sha256-hex-of-token> -> JSON { "label": "...", "created": "...", "prefix": "gp_1234567",
 *                                         "lastUsed"?: "...", "downloads"?: 0 }
 *   versions       -> JSON [ { "version", "sha1", "time",
 *                              "require"?: { "php": ">=8.1", ... },
 *                              "type"?: "wordpress-plugin",
 *                              "extra"?: { ... },
 *                              "notes"?: "markdown release notes" }, ... ]
 *   dist:<version> -> zip binary
 *
 * require/type/extra/notes are optional per-version fields written by the
 * plugin CI at publish time. notes is a markdown string rendered (escaped,
 * paragraphs and bullets only) on the public /changelog page. packages.json falls back to require {"php": ">=7.4"} and
 * type "wordpress-plugin" (and omits extra) for entries that predate them, so
 * a release can change its constraints without a Worker deploy.
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

/**
 * Updates a token's KV record with lastUsed and, for dist downloads, an
 * incremented downloads counter. Runs via ctx.waitUntil() so it never delays
 * the response. KV updates are last-write-wins, so concurrent requests with
 * the same token can drop an increment — the counts are approximate, which is
 * acceptable for the "is this token still in use?" question the admin UI
 * answers.
 */
async function recordUsage(token, record, isDist, env) {
	const updated = { ...record, lastUsed: new Date().toISOString() };
	if (isDist) updated.downloads = (record.downloads || 0) + 1;
	await env.REPO.put(`token:${await sha256Hex(token)}`, JSON.stringify(updated));
}

// True when an If-None-Match header matches the entity tag, per RFC 9110 weak
// comparison (W/ prefixes ignored) — or is "*". `etag` is the quoted form.
function ifNoneMatchSatisfied(header, etag) {
	if (!header) return false;
	return header.split(",").some((t) => {
		const tag = t.trim();
		return tag === "*" || tag.replace(/^W\//, "") === etag;
	});
}

function unauthorized() {
	return new Response("Unauthorized", {
		status: 401,
		headers: { "WWW-Authenticate": 'Basic realm="glidepress-composer"' },
	});
}

async function handleComposer(request, env, ctx, url) {
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

	// Record usage in the background. To limit KV writes, skip when lastUsed
	// is already today and this isn't a dist download — metadata polls
	// (packages.json) then cost at most one write per token per day, while
	// every download still bumps the counter.
	const isDist = Boolean(distMatch);
	const today = new Date().toISOString().slice(0, 10);
	if (isDist || (auth.lastUsed || "").slice(0, 10) !== today) {
		ctx.waitUntil(recordUsage(token, auth, isDist, env));
	}

	if (isPackages) {
		const versions = (await env.REPO.get("versions", "json")) || [];
		const releases = versions.map((v) => ({
			name: PACKAGE,
			version: v.version,
			// Per-version metadata from the publishing CI wins; the fallbacks are
			// the values every release carried before these fields existed.
			type: v.type || "wordpress-plugin",
			require: v.require || { php: ">=7.4" },
			...(v.extra ? { extra: v.extra } : {}),
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

	// Dist download. The ETag is the zip's sha1 from the versions list — the
	// same value packages.json publishes as the dist shasum, so the validator a
	// client saw in metadata matches the one on the download. Composer itself
	// never revalidates dists (it trusts its local cache unconditionally), but
	// the ETag lets other HTTP clients skip re-transferring a zip they hold.
	const version = distMatch[1];
	const meta = ((await env.REPO.get("versions", "json")) || []).find((v) => v.version === version);
	const etag = meta?.sha1 ? `"${meta.sha1}"` : null;
	// Answered from the versions entry alone — no blob read. (A half-failed
	// publish could leave an entry without a blob; a 304 for a client that
	// already holds the matching bytes is still correct then.)
	if (etag && ifNoneMatchSatisfied(request.headers.get("If-None-Match"), etag)) {
		return new Response(null, {
			status: 304,
			headers: { ETag: etag, "Cache-Control": "private, max-age=31536000, immutable" },
		});
	}
	const zip = await env.REPO.get(`dist:${version}`, "stream");
	if (!zip) return new Response("Not found", { status: 404 });
	const headers = {
		"Content-Type": "application/zip",
		"Cache-Control": "private, max-age=31536000, immutable",
	};
	if (etag) headers.ETag = etag;
	return new Response(zip, { headers });
}

// ---------------------------------------------------------------------------
// Changelog page
// ---------------------------------------------------------------------------

function escapeHtml(text) {
	return text.replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
	);
}

/**
 * Renders a release-notes markdown string as minimal HTML. Deliberately not a
 * markdown parser: blank-line-separated blocks become <p>, except blocks whose
 * every line starts with "- " or "* ", which become a <ul>. All text is
 * HTML-escaped, so any other markdown syntax renders literally.
 */
function renderNotes(notes) {
	const blocks = notes
		.replace(/\r\n/g, "\n")
		.split(/\n\s*\n/)
		.map((b) => b.trim())
		.filter(Boolean);
	return blocks
		.map((block) => {
			const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
			if (lines.every((l) => /^[-*] /.test(l))) {
				return `<ul>${lines.map((l) => `<li>${escapeHtml(l.slice(2))}</li>`).join("")}</ul>`;
			}
			// Single newlines inside a block are soft wraps, not new paragraphs.
			return `<p>${lines.map(escapeHtml).join(" ")}</p>`;
		})
		.join("\n");
}

/**
 * Public release-history page. Deliberately unauthenticated: version numbers
 * and release notes aren't sensitive. What IS withheld: sha1 hashes and dist
 * URLs — those belong to the authenticated Composer routes and are never
 * rendered here.
 */
async function handleChangelog(request, env) {
	if (request.method !== "GET") {
		return new Response("Method not allowed", { status: 405 });
	}

	const versions = (await env.REPO.get("versions", "json")) || [];
	// Newest first, same ordering as the admin releases panel.
	const releases = [...versions].sort((a, b) => (b.time || "").localeCompare(a.time || ""));

	const entries = releases
		.map((v) => {
			const date = (v.time || "").slice(0, 10);
			return `<article class="release">
	<header class="release__head">
		<h2 class="release__version">${escapeHtml(String(v.version))}</h2>
		${date ? `<time class="release__date" datetime="${escapeHtml(date)}">${escapeHtml(date)}</time>` : ""}
	</header>
	${v.notes ? `<div class="release__notes">${renderNotes(String(v.notes))}</div>` : ""}
</article>`;
		})
		.join("\n");

	// Header/footer markup mirrors public/index.html (fragment links made
	// absolute); styling comes from the same assets/site.css.
	const html = `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>Changelog — GlidePress Slider</title>
	<meta name="description" content="Release history for the GlidePress Slider WordPress plugin.">
	<link rel="canonical" href="https://glidepress.jmwerk.com/changelog">
	<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' fill='%232448c8'/%3E%3Crect x='22' y='30' width='36' height='40' fill='%23f5f1e8'/%3E%3Crect x='66' y='30' width='12' height='40' fill='%23f5f1e8' opacity='.5'/%3E%3C/svg%3E">
	<link rel="stylesheet" href="/assets/site.css">
</head>
<body>

<header class="site-header">
	<div class="wrap site-header__inner">
		<a class="brand" href="/">GlidePress</a>
		<nav class="site-nav" aria-label="Site">
			<a href="/#effects">Effects</a>
			<a href="/#details">Details</a>
			<a href="/#editor">Editor</a>
			<a href="/#accessibility">Accessibility</a>
			<a href="/changelog" aria-current="page">Changelog</a>
		</nav>
	</div>
</header>

<main>
	<section class="changelog">
		<div class="wrap">
			<p class="kicker">Release history</p>
			<h1>Changelog</h1>
			<p class="section__lead">Published versions of GlidePress Slider, newest first.</p>
${entries || '			<p class="footnote">No releases have been published yet.</p>'}
		</div>
	</section>
</main>

<footer class="site-footer">
	<div class="wrap site-footer__inner">
		<p>
			GlidePress Slider is free software,
			<abbr title="GNU General Public License">GPL</abbr>-2.0-or-later.
		</p>
		<p>
			Built on <a href="https://swiperjs.com/" rel="external">Swiper</a>
			for <a href="https://wordpress.org/" rel="external">WordPress</a>.
		</p>
	</div>
</footer>

</body>
</html>
`;

	return new Response(html, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "public, max-age=300",
			// public/_headers only covers static-asset responses; mirror the
			// site-wide security headers here so this Worker-rendered page
			// matches the rest of the site.
			"X-Content-Type-Options": "nosniff",
			"X-Frame-Options": "DENY",
			"Referrer-Policy": "strict-origin-when-cross-origin",
			"Content-Security-Policy":
				"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'self'; form-action 'self'",
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

export function adminAuthorized(request, env) {
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
					return {
						id,
						prefix: meta.prefix || id.slice(0, 10),
						label: meta.label,
						created: meta.created,
						lastUsed: meta.lastUsed,
						downloads: meta.downloads,
					};
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

	if (url.pathname === "/admin/api/versions") {
		if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
		const versions = (await env.REPO.get("versions", "json")) || [];
		// One list call instead of a get per version: dist presence for every
		// release at once, plus the zip size when the publisher stored it in KV
		// metadata (older releases may predate that and report size: null).
		const dists = new Map();
		let cursor;
		do {
			const page = await env.REPO.list({ prefix: "dist:", cursor });
			for (const k of page.keys) {
				dists.set(k.name.slice("dist:".length), k.metadata?.size ?? null);
			}
			cursor = page.list_complete ? undefined : page.cursor;
		} while (cursor);
		const releases = versions
			.map((v) => ({ ...v, dist: dists.has(v.version), size: dists.get(v.version) ?? null }))
			.sort((a, b) => (b.time || "").localeCompare(a.time || ""));
		return json(releases);
	}

	// Same version charset the dist download route accepts.
	const versionMatch = url.pathname.match(/^\/admin\/api\/versions\/([\w.-]+)$/);
	if (versionMatch && request.method === "DELETE") {
		const version = versionMatch[1];
		const versions = (await env.REPO.get("versions", "json")) || [];
		const remaining = versions.filter((v) => v.version !== version);
		// Delete the zip unconditionally so an orphaned dist blob (publish that
		// half-failed) can be cleaned up too; idempotent like the token delete.
		await env.REPO.delete(`dist:${version}`);
		if (remaining.length !== versions.length) {
			await env.REPO.put("versions", JSON.stringify(remaining));
		}
		return json({ ok: true });
	}

	return json({ error: "not found" }, 404);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		if (url.pathname === "/changelog") {
			return handleChangelog(request, env);
		}
		if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
			return handleAdmin(request, env, url);
		}
		return handleComposer(request, env, ctx, url);
	},
};
