/**
 * Shared chrome for the Worker-rendered pages (/changelog, /demo).
 *
 * public/index.html is the source of truth for the site's markup; these
 * helpers mirror its header and footer (with fragment links made absolute) so
 * server-rendered pages don't drift from it — in particular so a new nav item
 * is added in one place rather than once per page.
 */

// Mirrored by hand in public/404.html, which is served as a static asset
// without invoking the Worker and so can't import this. Change both together.
const NAV = [
	["/demo", "Live demo"],
	["/#effects", "Effects"],
	["/#details", "Details"],
	["/#editor", "Editor"],
	["/#accessibility", "Accessibility"],
	["/changelog", "Changelog"],
];

/** `current` is the href of the page being rendered, or null for none. */
export function siteHeader(current = null) {
	const links = NAV.map(
		([href, label]) =>
			`\t\t\t<a href="${href}"${href === current ? ' aria-current="page"' : ""}>${label}</a>`
	).join("\n");
	return `<header class="site-header">
	<div class="wrap site-header__inner">
		<a class="brand" href="/">GlidePress</a>
		<nav class="site-nav" aria-label="Site">
${links}
		</nav>
	</div>
</header>`;
}

export const SITE_FOOTER = `<footer class="site-footer">
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
</footer>`;

export const FAVICON =
	"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' fill='%232448c8'/%3E%3Crect x='22' y='30' width='36' height='40' fill='%23f5f1e8'/%3E%3Crect x='66' y='30' width='12' height='40' fill='%23f5f1e8' opacity='.5'/%3E%3C/svg%3E";

// The site-wide policy from public/_headers. Worker-rendered pages set their
// own headers (that file only covers static-asset responses), so this keeps
// them identical to the rest of the site.
export const BASE_CSP =
	"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'self'; form-action 'self'";

/**
 * Response headers for a Worker-rendered HTML page: the site-wide security
 * headers plus the given cache policy. `csp` defaults to BASE_CSP; /demo
 * passes an extended one because it embeds a cross-origin iframe.
 */
export function htmlHeaders({ cacheControl, csp = BASE_CSP, frameOptions = "DENY" } = {}) {
	return {
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": cacheControl,
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options": frameOptions,
		"Referrer-Policy": "strict-origin-when-cross-origin",
		"Content-Security-Policy": csp,
	};
}
