# GlidePress Slider — showcase site

The static showcase site for the GlidePress Slider WordPress plugin. No build
step: plain HTML, CSS and JS, plus the same Swiper 12 bundle the plugin ships
(vendored into `vendor/`).

## Deploying to Cloudflare Pages

Create a Pages project connected to this repository with:

| Setting                | Value  |
| ---------------------- | ------ |
| Build command          | *(none — leave empty)* |
| Build output directory | `/`    |

Or deploy directly from the CLI:

```bash
npx wrangler pages deploy . --project-name glidepress-site
```

`_headers` configures security headers and long-lived caching for the vendored
Swiper bundle; Cloudflare Pages picks it up automatically.

## Updating the vendored Swiper bundle

The bundle in `vendor/` is copied from the plugin's `node_modules/swiper` so
the demos run exactly what the plugin ships. When the plugin's Swiper
dependency changes, re-copy it from a plugin checkout:

```bash
cp path/to/glidepress-slider/node_modules/swiper/swiper-bundle.min.{js,css} vendor/
```

## Local preview

```bash
npx serve .        # or: python3 -m http.server 8080
```
