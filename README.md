# GlidePress Slider — site + private Composer repo

One Cloudflare Worker serving two things on the same domain:

- **`/`** — the static showcase site (`public/`, no build step: plain HTML, CSS
  and JS, plus the same Swiper 12 bundle the plugin ships, vendored into
  `public/vendor/`). Served via Workers static assets; `public/_headers`
  configures security headers and caching. `not_found_handling = "404-page"`
  serves `public/404.html` for browser navigations to unknown paths *without*
  invoking the Worker — non-navigation requests (Composer, the admin UI's
  `fetch()` calls) still reach the Worker as usual (see the comment in
  `wrangler.toml`).
- **`/packages.json`, `/dist/*.zip`** — the private Composer repository for
  `glidepress/glidepress-slider` (HTTP basic auth; the password is an access
  token). Package zips and version metadata live in Workers KV — releases are
  published into KV by the plugin repo's CI, including optional per-version
  `require`/`type`/`extra` overrides (with fallbacks for older entries), so
  deploying this Worker is never needed to ship a plugin version, even one
  that changes its Composer constraints. Dist downloads carry an ETag (the
  zip's sha1) and answer a matching `If-None-Match` with `304`; `packages.json`
  deliberately doesn't — Composer 2 only revalidates metadata via
  `If-Modified-Since` (see the header comment in `src/index.js`).
- **`/changelog`** — public server-rendered release history (version numbers,
  dates, and optional per-version `notes` markdown from KV, rendered escaped
  with paragraphs/bullets only). Deliberately unauthenticated — versions
  aren't sensitive — but sha1 hashes and dist URLs are never rendered.
  Listed in `run_worker_first` so browser navigations reach the Worker
  instead of the 404 page. Cached for 5 minutes (`max-age=300`).
- **`/admin`** — admin UI. The page itself is a static asset
  (`public/admin/`); it talks to the Worker's `/admin/api/*` JSON routes,
  unlocked with the `ADMIN_KEY` worker secret. Two panels:
  - **Tokens** (create / list / revoke). Each token's row shows when it was
    last used and how many dist downloads it has made (approximate — KV is
    last-write-wins on concurrent updates; to limit KV writes, metadata polls
    update "last used" at most once per day).
  - **Published releases** (read-only list + delete). Shows every version from
    KV, newest first with the latest flagged, and whether its dist zip is
    actually present (single KV `list` on the `dist:` prefix, with the zip size
    when the publisher stored it in KV metadata). *Delete* pulls a bad release:
    it permanently removes the zip and the version entry — consumers pinned to
    that version will fail to install/update until they repin.

## Rate limiting

Auth brute-forcing is throttled with a [Workers rate limiting
binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
(`AUTH_RATE_LIMITER` in `wrangler.toml`, GA since 2025-09 — formerly the
"unsafe" `ratelimit` binding), keyed on the client IP (`CF-Connecting-IP`),
allowing 10 units per IP per 60 s. Over the limit → `429` with `Retry-After`.

- **Composer routes** (`/packages.json`, `/dist/*`): one unit per
  *credentialed* request, consumed **before** the KV token lookup, so
  over-limit IPs never cost a KV read. The binding's only API is the consuming
  `limit({ key })` — there is no read-only check — so requests with a valid
  token also spend a unit; 10/min is far above normal Composer traffic
  (~2 requests per install/update). Requests without basic-auth credentials
  get a plain `401` and consume nothing.
- **Admin API** (`/admin/api/*`): one unit per *failed* Bearer attempt only;
  valid-key requests never touch the limiter.

Caveats (per Cloudflare docs): counters are per-colo and eventually
consistent — this is brute-force protection, not exact accounting. The
limiter is also enforced in `wrangler dev` (all local requests share one
bucket). The Worker fails open if the binding is absent.

## Testing

```bash
npm install
npm test
```

Tests run with [Vitest](https://vitest.dev/) inside the actual Workers runtime
via [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/),
with bindings taken from `wrangler.toml` (KV state persists across tests
within a run, so tests seed distinct keys). Covered: Composer auth (401
challenge, valid-token `packages.json` shape, dist downloads), per-version
KV metadata overrides vs. fallbacks, dist ETag/`If-None-Match` 304s, the
no-challenge 404 for stray paths, per-token usage tracking (last-used /
download counts and the daily write-skip), the admin token API
(create/validate/revoke, Bearer auth, disabled without `ADMIN_KEY`), the
admin versions API (list with dist presence/size, release deletion), and the
public changelog page (ordering, notes escaping/formatting, no sha1/dist
leakage, caching).

## Deploy

**CI (normal path):** pushing to `main` runs the test suite and, if green,
deploys via `.github/workflows/deploy.yml`
([cloudflare/wrangler-action](https://github.com/cloudflare/wrangler-action)).
Pull requests run tests only. Two repo secrets must be configured under
*Settings → Secrets and variables → Actions*:

- `CLOUDFLARE_API_TOKEN` — an API token with the *Edit Cloudflare Workers*
  template permissions
- `CLOUDFLARE_ACCOUNT_ID` — from the Workers overview page in the dashboard

**Manual fallback:**

```bash
npx wrangler deploy
```

Worker secrets (one-time / rotation, not managed by CI):
`npx wrangler secret put ADMIN_KEY`

## Consumer setup (WordPress site installing the plugin)

```jsonc
// composer.json
"repositories": [{ "type": "composer", "url": "https://glidepress.jmwerk.com" }],
"require": { "composer/installers": "^2.0", "glidepress/glidepress-slider": "^2.1" }
```

```bash
composer config --global http-basic.glidepress.jmwerk.com token <TOKEN>
composer require glidepress/glidepress-slider:^2.1
```

Tokens come from `/admin`.

## Updating the vendored Swiper bundle

The bundle in `public/vendor/` is copied from the plugin's `node_modules/swiper`
so the demos run exactly what the plugin ships. When the plugin's Swiper
dependency changes, re-copy it from a plugin checkout:

```bash
cp path/to/glidepress-slider/node_modules/swiper/swiper-bundle.min.{js,css} public/vendor/
```

## Local preview

```bash
npx wrangler dev
```
