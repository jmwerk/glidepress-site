import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			// Bindings (REPO KV, AUTH_RATE_LIMITER, assets) come straight from
			// the deploy config so tests exercise the real setup.
			wrangler: { configPath: "./wrangler.toml" },
			miniflare: {
				// The test runner itself needs Node.js compatibility inside
				// workerd; the production Worker does not, so the flag lives
				// here rather than in wrangler.toml.
				compatibilityFlags: ["nodejs_compat"],
			},
		}),
	],
});
