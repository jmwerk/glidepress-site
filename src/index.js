/**
 * GlidePress site Worker: serves the static showcase (from public/ via Workers
 * static assets — assets are matched before this code runs) and the private
 * Composer repository for glidepress/glidepress-slider.
 *
 * Composer routes (HTTP basic auth; the password is an access token):
 *   GET /packages.json                        Composer metadata for all published versions
 *   GET /dist/glidepress-slider-<ver>.zip     Dist archive for one version
 *
 * Admin routes (Bearer auth with the ADMIN_KEY worker secret):
 *   GET    /admin                             Token management UI
 *   GET    /admin/api/tokens                  List tokens
 *   POST   /admin/api/tokens {label}          Create a token
 *   DELETE /admin/api/tokens/<token>          Revoke a token
 *
 * KV schema (binding REPO):
 *   token:<token>  -> JSON { "label": "...", "created": "..." }
 *   versions       -> JSON [ { "version", "sha1", "time" }, ... ]
 *   dist:<version> -> zip binary
 */

const PACKAGE = "glidepress/glidepress-slider";

// ---------------------------------------------------------------------------
// Composer-facing routes
// ---------------------------------------------------------------------------

async function authorize(request, env) {
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
	if (!token) return null;
	return env.REPO.get(`token:${token}`, "json");
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

	const auth = await authorize(request, env);
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
	if (url.pathname === "/admin" && request.method === "GET") {
		return new Response(ADMIN_PAGE, {
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-store",
				"X-Frame-Options": "DENY",
			},
		});
	}

	if (!adminAuthorized(request, env)) {
		return json({ error: "unauthorized" }, 401);
	}

	if (url.pathname === "/admin/api/tokens") {
		if (request.method === "GET") {
			const list = await env.REPO.list({ prefix: "token:" });
			const tokens = await Promise.all(
				list.keys.map(async (k) => {
					const meta = (await env.REPO.get(k.name, "json")) || {};
					return { token: k.name.slice("token:".length), ...meta };
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
			const record = { label, created: new Date().toISOString() };
			await env.REPO.put(`token:${token}`, JSON.stringify(record));
			return json({ token, ...record }, 201);
		}
		return json({ error: "method not allowed" }, 405);
	}

	const match = url.pathname.match(/^\/admin\/api\/tokens\/(gp_[0-9a-f]+)$/);
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

// ---------------------------------------------------------------------------
// Admin UI (self-contained; talks to /admin/api/* with a Bearer key)
// ---------------------------------------------------------------------------

const ADMIN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GlidePress Composer tokens</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 2rem 1rem;
         background: Canvas; color: CanvasText; }
  main { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 1.3rem; }
  fieldset { border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
             border-radius: 8px; padding: 1rem; margin: 0 0 1.5rem; }
  legend { padding: 0 .4rem; font-weight: 600; }
  input { font: inherit; padding: .45rem .6rem; border-radius: 6px;
          border: 1px solid color-mix(in srgb, CanvasText 35%, transparent);
          background: Field; color: FieldText; width: 100%; max-width: 26rem; }
  button { font: inherit; padding: .45rem .9rem; border-radius: 6px; cursor: pointer;
           border: 1px solid color-mix(in srgb, CanvasText 35%, transparent);
           background: ButtonFace; color: ButtonText; }
  button:hover { filter: brightness(1.08); }
  .row { display: flex; gap: .6rem; flex-wrap: wrap; align-items: center; }
  table { border-collapse: collapse; width: 100%; margin-top: .5rem; }
  th, td { text-align: left; padding: .45rem .6rem; font-size: .92rem;
           border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, transparent); }
  code { font-family: ui-monospace, monospace; font-size: .85rem; }
  .new-token { margin-top: 1rem; padding: 1rem; border-radius: 8px;
               background: color-mix(in srgb, LinkText 12%, Canvas);
               overflow-wrap: anywhere; }
  .muted { opacity: .65; font-size: .85rem; }
  .danger { color: #c0392b; }
  #status { min-height: 1.4em; }
  .hidden { display: none; }
  details { border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
            border-radius: 8px; padding: .6rem .9rem; margin: .6rem 0; }
  details summary { cursor: pointer; font-weight: 600; }
  details[open] summary { margin-bottom: .5rem; }
  pre { background: color-mix(in srgb, CanvasText 8%, Canvas); padding: .7rem .9rem;
        border-radius: 6px; overflow-x: auto; font-size: .85rem; line-height: 1.45; }
  pre code { font-size: inherit; }
  .guide ol { padding-left: 1.3rem; }
  .guide li { margin: .3rem 0; }
</style>
</head>
<body>
<main>
  <h1>GlidePress Composer &mdash; access tokens</h1>

  <fieldset id="login-box">
    <legend>Admin key</legend>
    <div class="row">
      <input id="admin-key" type="password" placeholder="paste admin key" autocomplete="current-password">
      <button id="login-btn">Unlock</button>
    </div>
    <p class="muted">The key is kept in this tab only (sessionStorage) and sent as a
    Bearer header to this same host. Nothing leaves this domain.</p>
  </fieldset>

  <div id="app" class="hidden">
    <fieldset>
      <legend>Create token</legend>
      <div class="row">
        <input id="label" placeholder="label, e.g. client-acme" maxlength="64">
        <button id="create-btn">Create</button>
      </div>
      <div id="new-token" class="new-token hidden"></div>
    </fieldset>

    <fieldset>
      <legend>Existing tokens</legend>
      <table>
        <thead><tr><th>Label</th><th>Token</th><th>Created</th><th></th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </fieldset>

    <fieldset class="guide">
    <legend>Guide</legend>

    <details open>
      <summary>What this page is for</summary>
      <p>The GlidePress plugin is installed on WordPress sites with
      <a href="https://getcomposer.org" rel="noopener">Composer</a>, from the private
      package repo on this same domain. A <strong>token is the password</strong> that
      lets one site (or person) access that repo. Create one token per site/client —
      then you can revoke a single site's access without touching the others.</p>
    </details>

    <details>
      <summary>Walkthrough: onboard a new site</summary>
      <ol>
        <li><strong>Create a token above</strong> with a label that names the site or
        client (e.g. <code>client-acme</code>). Two copy buttons appear: the raw token
        and a ready-made <code>composer config</code> command.</li>
        <li><strong>Send both snippets below</strong> to whoever manages that site,
        through a private channel (password manager share &mdash; not plain email if
        avoidable).</li>
        <li>On the site, they add the repo and plugin to the
        <code>composer.json</code> in the WordPress root:
<pre><code>{
    "repositories": [
        { "type": "composer", "url": "https://<span class="host"></span>" }
    ],
    "require": {
        "composer/installers": "^2.0",
        "glidepress/glidepress-slider": "^2.1"
    },
    "extra": {
        "installer-paths": {
            "wp-content/plugins/{$name}/": ["type:wordpress-plugin"]
        }
    }
}</code></pre></li>
        <li>They store the credentials once (outside the project, never committed):
<pre><code>composer config --global http-basic.<span class="host"></span> token &lt;TOKEN&gt;</code></pre></li>
        <li>Install and activate:
<pre><code>composer install
wp plugin activate glidepress-slider   # or via wp-admin &rarr; Plugins</code></pre></li>
      </ol>
    </details>

    <details>
      <summary>Updates &amp; new releases</summary>
      <p>Releases are published automatically when a version tag is pushed to the
      plugin repo (<code>npm run release -- patch</code> there). Nothing to do on this
      page. Consumers pull the newest allowed version with:</p>
      <pre><code>composer update glidepress/glidepress-slider</code></pre>
    </details>

    <details>
      <summary>Revoking access</summary>
      <p>Click <em>Revoke</em> next to a token. The site using it loses access within
      about a minute (edge cache propagation) &mdash; its next
      <code>composer install/update</code> fails with a 401. The plugin already
      installed on that site keeps working; revocation only stops future downloads.
      To restore access, create a fresh token and send it over.</p>
    </details>

    <details>
      <summary>Troubleshooting a consumer</summary>
      <ul>
        <li><code>401 Could not authenticate</code> &mdash; token missing, mistyped, or
        revoked; redo the <code>composer config</code> step.</li>
        <li><code>Could not find package</code> &mdash; the <code>repositories</code>
        entry is missing from their <code>composer.json</code>.</li>
        <li>Plugin ends up in <code>vendor/</code> &mdash; they're missing
        <code>composer/installers</code> or the <code>installer-paths</code> block.</li>
      </ul>
    </details>
    </fieldset>
  </div>

  <p id="status" class="muted"></p>
</main>
<script>
(function () {
  var KEY = "gp-admin-key";
  var statusEl = document.getElementById("status");

  // Fill in the current host wherever the guide references it.
  document.querySelectorAll(".host").forEach(function (el) {
    el.textContent = location.host;
  });

  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: {
        "Authorization": "Bearer " + sessionStorage.getItem(KEY),
        "Content-Type": "application/json"
      },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      if (r.status === 401) {
        sessionStorage.removeItem(KEY);
        show(false);
        throw new Error("Invalid admin key.");
      }
      return r.json().then(function (data) {
        if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
        return data;
      });
    });
  }

  function setStatus(msg, isError) {
    statusEl.textContent = msg || "";
    statusEl.className = isError ? "danger" : "muted";
  }

  function show(loggedIn) {
    document.getElementById("login-box").classList.toggle("hidden", loggedIn);
    document.getElementById("app").classList.toggle("hidden", !loggedIn);
  }

  function fmtDate(iso) {
    return iso ? iso.replace("T", " ").slice(0, 16) + " UTC" : "";
  }

  function copyBtn(text) {
    var b = document.createElement("button");
    b.textContent = "Copy";
    b.onclick = function () {
      navigator.clipboard.writeText(text).then(function () {
        b.textContent = "Copied!";
        setTimeout(function () { b.textContent = "Copy"; }, 1500);
      });
    };
    return b;
  }

  function refresh() {
    return api("GET", "/admin/api/tokens").then(function (tokens) {
      var tbody = document.getElementById("rows");
      tbody.textContent = "";
      tokens.forEach(function (t) {
        var tr = document.createElement("tr");

        var tdLabel = document.createElement("td");
        tdLabel.textContent = t.label || "(no label)";

        var tdToken = document.createElement("td");
        var code = document.createElement("code");
        code.textContent = t.token.slice(0, 10) + "\\u2026 ";
        tdToken.appendChild(code);
        tdToken.appendChild(copyBtn(t.token));

        var tdCreated = document.createElement("td");
        tdCreated.textContent = fmtDate(t.created);

        var tdActions = document.createElement("td");
        var del = document.createElement("button");
        del.textContent = "Revoke";
        del.className = "danger";
        del.onclick = function () {
          if (!confirm('Revoke "' + (t.label || t.token) + '"? Sites using it lose access immediately.')) return;
          api("DELETE", "/admin/api/tokens/" + t.token)
            .then(refresh)
            .then(function () { setStatus("Token revoked."); })
            .catch(function (e) { setStatus(e.message, true); });
        };
        tdActions.appendChild(del);

        tr.appendChild(tdLabel);
        tr.appendChild(tdToken);
        tr.appendChild(tdCreated);
        tr.appendChild(tdActions);
        tbody.appendChild(tr);
      });
      if (tokens.length === 0) {
        var tr = document.createElement("tr");
        var td = document.createElement("td");
        td.colSpan = 4;
        td.className = "muted";
        td.textContent = "No tokens yet.";
        tr.appendChild(td);
        tbody.appendChild(tr);
      }
    });
  }

  document.getElementById("login-btn").onclick = function () {
    var key = document.getElementById("admin-key").value.trim();
    if (!key) return;
    sessionStorage.setItem(KEY, key);
    setStatus("");
    refresh()
      .then(function () { show(true); })
      .catch(function (e) { setStatus(e.message, true); });
  };
  document.getElementById("admin-key").addEventListener("keydown", function (e) {
    if (e.key === "Enter") document.getElementById("login-btn").click();
  });

  document.getElementById("create-btn").onclick = function () {
    var label = document.getElementById("label").value.trim();
    if (!label) { setStatus("Enter a label first.", true); return; }
    api("POST", "/admin/api/tokens", { label: label })
      .then(function (t) {
        document.getElementById("label").value = "";
        var box = document.getElementById("new-token");
        box.classList.remove("hidden");
        box.textContent = "";
        var p1 = document.createElement("div");
        p1.append("Token for ");
        var strong = document.createElement("strong");
        strong.textContent = t.label;
        p1.append(strong, ": ");
        var code = document.createElement("code");
        code.textContent = t.token;
        p1.append(code, " ");
        p1.appendChild(copyBtn(t.token));
        var p2 = document.createElement("div");
        p2.className = "muted";
        var cmd = "composer config --global http-basic." + location.host + " token " + t.token;
        p2.append("Setup command: ");
        var code2 = document.createElement("code");
        code2.textContent = cmd;
        p2.append(code2, " ");
        p2.appendChild(copyBtn(cmd));
        box.append(p1, p2);
        setStatus("Token created.");
        return refresh();
      })
      .catch(function (e) { setStatus(e.message, true); });
  };

  if (sessionStorage.getItem(KEY)) {
    refresh()
      .then(function () { show(true); })
      .catch(function () { show(false); });
  }
})();
</script>
</body>
</html>`;
