# GlidePress Slider — site + private Composer repo

One Cloudflare Worker serving two things on the same domain:

- **`/`** — the static showcase site (`public/`, no build step: plain HTML, CSS
  and JS, plus the same Swiper 12 bundle the plugin ships, vendored into
  `public/vendor/`). Served via Workers static assets; `public/_headers`
  configures security headers and caching.
- **`/packages.json`, `/dist/*.zip`** — the private Composer repository for
  `glidepress/glidepress-slider` (HTTP basic auth; the password is an access
  token). Package zips and version metadata live in Workers KV — releases are
  published into KV by the plugin repo's CI, so deploying this Worker is never
  needed to ship a plugin version.
- **`/admin`** — token management UI (create / list / revoke), unlocked with the
  `ADMIN_KEY` worker secret.

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

## Deploy

```bash
npx wrangler deploy
```

Secrets (one-time / rotation): `npx wrangler secret put ADMIN_KEY`

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
