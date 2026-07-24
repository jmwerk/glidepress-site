/**
 * Live editable demo: real WordPress, in the visitor's browser.
 *
 * /demo                        The page. Links out to Playground rather than
 *                              embedding it: an editor in a cross-origin frame
 *                              loses focus and fullscreen to permissions
 *                              policy, gets whatever width the page has left,
 *                              and costs this page a frame-src exception plus
 *                              a script. A link costs none of that.
 * /demo/blueprint.json         WordPress Playground blueprint (CORS: read by
 *                              playground.wordpress.net, a different origin).
 * /demo/glidepress-slider.zip  The latest published release, unauthenticated
 *                              (CORS) so the blueprint's installPlugin step
 *                              can fetch it. Deliberately public: Playground
 *                              runs entirely client-side, so there is nowhere
 *                              to put a token that a visitor couldn't read.
 *                              Everything else about distribution stays behind
 *                              /packages.json and /dist/* as before.
 *
 * Nothing here is a re-implementation of the block: Playground compiles PHP to
 * WebAssembly and runs actual WordPress, so the editor, the inspector controls
 * and the frontend (view.js + Swiper) are the ones the plugin ships. The demo
 * always serves the newest release, so it needs no upkeep when one is
 * published.
 *
 * The showcase content is inserted at runtime by SEED_SCRIPT below, using
 * wp.blocks.createBlock against the registered block types — not as a stored
 * markup fixture. A fixture would have to reproduce the exact output of the
 * blocks' save() (down to the key order inside data-swiper-config) and would
 * silently start failing block validation the next time save() changed.
 */

import { FAVICON, SITE_FOOTER, htmlHeaders, siteHeader } from "./shell.js";

const ZIP_PATH = "/demo/glidepress-slider.zip";
const PLAYGROUND_ORIGIN = "https://playground.wordpress.net";

// ---------------------------------------------------------------------------
// Files written into the Playground WordPress by the blueprint
// ---------------------------------------------------------------------------

/**
 * Runs inside the Playground WordPress (wp-admin), NOT in the Worker. Seeds a
 * kitchen-sink document into a brand-new post: one section per feature, each
 * with a slider configured to demonstrate it, then selects the first slider
 * and opens the sidebar so the controls are on screen straight away.
 *
 * Every number here stays inside the ranges sanitizeSwiperConfig enforces
 * (speed 100-2000, slides per view 1-6, space 0-100, autoplay delay
 * 500-10000, arrow size 24-80, arrow radius 0-50, pagination size 4-24) — out
 * of range values are silently clamped, which would make the demo a liar.
 *
 * Note the editor lays slides out side by side rather than running Swiper, so
 * effects, autoplay, peek and responsive visibility only really show
 * themselves on the published page. The copy says so.
 */
const SEED_SCRIPT = `/* GlidePress demo — seeds the kitchen-sink showcase. */
( function () {
	'use strict';

	var CREAM = '#f5f1e8';
	var NAVY = '#2c3e66';
	var CLAY = '#a05c3b';
	var MOSS = '#4e6b51';
	var PLUM = '#5a4a6b';
	var SLATE = '#42474f';

	var PALETTE = [ NAVY, CLAY, MOSS, PLUM, SLATE ];

	function heading( text, level ) {
		return wp.blocks.createBlock( 'core/heading', {
			level: level || 2,
			content: text,
		} );
	}

	function paragraph( text ) {
		return wp.blocks.createBlock( 'core/paragraph', { content: text } );
	}

	/**
	 * A slide. \`extra\` is merged over the defaults so a section can override
	 * any part of it — including \`style\`, which is replaced wholesale.
	 */
	function slide( title, text, extra ) {
		var attributes = {
			contentSpacing: 'evenly',
			style: {
				color: { background: NAVY, text: CREAM },
				spacing: {
					padding: {
						top: '1.75rem',
						right: '1.5rem',
						bottom: '1.75rem',
						left: '1.5rem',
					},
				},
				border: { radius: '6px' },
			},
		};

		Object.keys( extra || {} ).forEach( function ( key ) {
			attributes[ key ] = extra[ key ];
		} );

		var inner = [ heading( title, 3 ) ];
		if ( text ) {
			inner.push( paragraph( text ) );
		}

		return wp.blocks.createBlock( 'glidepress/slide', attributes, inner );
	}

	/** A slide whose only variable is its background colour. */
	function colourSlide( index, title, text ) {
		return slide( title, text, {
			contentSpacing: 'evenly',
			style: {
				color: {
					background: PALETTE[ index % PALETTE.length ],
					text: CREAM,
				},
				spacing: {
					padding: {
						top: '1.75rem',
						right: '1.5rem',
						bottom: '1.75rem',
						left: '1.5rem',
					},
				},
				border: { radius: '6px' },
			},
		} );
	}

	function slider( attributes, slides ) {
		return wp.blocks.createBlock(
			'glidepress/slider',
			attributes,
			slides
		);
	}

	/** Numbered filler slides, for sections that only vary slider settings. */
	function numbered( count, label ) {
		var slides = [];
		for ( var i = 0; i < count; i++ ) {
			slides.push(
				colourSlide( i, label + ' ' + ( i + 1 ), '' )
			);
		}
		return slides;
	}

	// Each entry becomes: a heading, a line of explanation, and one slider.
	//
	// This MUST stay a function. As a plain array it was evaluated when the
	// script loaded, which called wp.blocks.createBlock before the editor had
	// registered any block type — and the throw took the whole script with it,
	// including the wp.domReady handler below, so the seed never even started.
	function buildSections() {
		return [
			{
				title: 'Responsive slides per view',
				note: 'One slide on mobile, two on tablet, three on desktop, with the gap widening as it goes. Narrow the window on the published page to watch it step down.',
				slider: slider(
					{
						align: 'wide',
						ariaLabel: 'Responsive slides per view',
						effect: 'slide',
						loop: true,
						equalHeight: true,
						slidesPerViewMobile: 1,
						slidesPerViewTablet: 2,
						slidesPerViewDesktop: 3,
						spaceBetweenMobile: 16,
						spaceBetweenTablet: 24,
						spaceBetweenDesktop: 32,
					},
					numbered( 6, 'Slide' )
				),
			},
			{
				title: 'Fade',
				note: 'Cross-fades between slides. Every effect except Slide is locked to one slide per view — the controls grey themselves out.',
				slider: slider(
					{
						ariaLabel: 'Fade effect',
						effect: 'fade',
						speed: 700,
						loop: true,
					},
					numbered( 3, 'Fade' )
				),
			},
			{
				title: 'Flip',
				note: 'A 3D flip, with slide shadows off so the colours stay flat.',
				slider: slider(
					{ ariaLabel: 'Flip effect', effect: 'flip', speed: 600, loop: true },
					numbered( 3, 'Flip' )
				),
			},
			{
				title: 'Creative',
				note: 'The outgoing slide translates away while the next one arrives over it.',
				slider: slider(
					{
						ariaLabel: 'Creative effect',
						effect: 'creative',
						speed: 800,
						loop: true,
					},
					numbered( 3, 'Creative' )
				),
			},
			{
				title: 'Autoplay, with a pause button',
				note: 'Advances every three seconds, pauses when the pointer is over it, and renders a real pause control — autoplay that cannot be stopped is an accessibility failure.',
				slider: slider(
					{
						ariaLabel: 'Autoplay',
						effect: 'slide',
						loop: true,
						autoplay: true,
						autoplayDelay: 3000,
						autoplayPauseOnHover: true,
						autoplayShowPauseButton: true,
						equalHeight: true,
					},
					numbered( 4, 'Autoplay' )
				),
			},
			{
				title: 'Peek at the neighbours',
				note: 'Overflow lets the slides either side show past the edges. Slide effect only, and it keeps an extra looped slide on each side so the peek is never blank.',
				slider: slider(
					{
						align: 'wide',
						ariaLabel: 'Overflow peek',
						effect: 'slide',
						loop: true,
						overflow: true,
						equalHeight: true,
						slidesPerViewMobile: 1,
						slidesPerViewTablet: 1,
						slidesPerViewDesktop: 1,
						spaceBetweenMobile: 20,
						spaceBetweenTablet: 24,
						spaceBetweenDesktop: 28,
					},
					numbered( 5, 'Peek' )
				),
			},
			{
				title: 'Styled controls',
				note: 'Arrow colour, background, size and corner radius, plus pagination colours and dot size — all per slider, all in the sidebar. These arrows are large and square.',
				slider: slider(
					{
						ariaLabel: 'Styled controls',
						effect: 'slide',
						loop: true,
						equalHeight: true,
						arrowColor: '#211f1a',
						arrowBackground: '#f5f1e8',
						arrowBorderRadius: 8,
						arrowSize: 64,
						paginationColor: '#a05c3b',
						paginationColorInactive: 'rgba(245,241,232,0.45)',
						paginationSize: 16,
					},
					numbered( 4, 'Styled' )
				),
			},
			{
				title: 'Minimal chrome',
				note: 'Arrows off, pagination off, keyboard still on. Drag it, or focus it on the published page and use the arrow keys.',
				slider: slider(
					{
						ariaLabel: 'No arrows or pagination',
						effect: 'slide',
						loop: true,
						arrows: false,
						pagination: false,
						keyboard: true,
						equalHeight: true,
					},
					numbered( 4, 'Bare' )
				),
			},
			{
				title: 'Equal height',
				note: 'These slides hold wildly different amounts of text. With equal height on, they all match the tallest instead of the slider resizing as it moves.',
				slider: slider(
					{
						align: 'wide',
						ariaLabel: 'Equal height',
						effect: 'slide',
						loop: true,
						equalHeight: true,
						slidesPerViewMobile: 1,
						slidesPerViewTablet: 2,
						slidesPerViewDesktop: 2,
						spaceBetweenMobile: 16,
						spaceBetweenTablet: 24,
						spaceBetweenDesktop: 24,
					},
					[
						colourSlide( 0, 'Short', 'One line.' ),
						colourSlide(
							1,
							'Rather longer',
							'This slide carries several sentences of copy so that it stands a good deal taller than its neighbour. Turn equal height off in the sidebar and the whole slider will start resizing itself as you move between the two, which is the behaviour you usually do not want.'
						),
						colourSlide( 2, 'Middling', 'Two lines, give or take, of supporting text.' ),
						colourSlide( 3, 'Short again', 'One line.' ),
					]
				),
			},
			{
				title: 'Slides are just blocks',
				note: 'Gradient, border, shadow, minimum height, padding and typography come from the controls WordPress gives every block — GlidePress adds none of them. Select a slide to see.',
				slider: slider(
					{
						ariaLabel: 'Slide styling',
						effect: 'slide',
						loop: true,
						equalHeight: true,
					},
					[
						slide( 'Gradient', 'A gradient background, from the colour panel.', {
							contentSpacing: 'evenly',
							style: {
								color: {
									gradient:
										'linear-gradient(135deg, #2c3e66 0%, #5a4a6b 100%)',
									text: CREAM,
								},
								spacing: {
									padding: {
										top: '2.5rem',
										right: '2rem',
										bottom: '2.5rem',
										left: '2rem',
									},
								},
							},
						} ),
						slide( 'Border and shadow', 'A thick border, a rounded corner and a drop shadow.', {
							contentSpacing: 'evenly',
							style: {
								color: { background: CREAM, text: '#211f1a' },
								border: {
									color: '#a05c3b',
									width: '4px',
									style: 'solid',
									radius: '16px',
								},
								shadow: 'var(--wp--preset--shadow--natural)',
								spacing: {
									padding: {
										top: '2.5rem',
										right: '2rem',
										bottom: '2.5rem',
										left: '2rem',
									},
								},
							},
						} ),
						slide( 'Minimum height', 'A minimum height set on the slide itself, with the content spread apart.', {
							contentSpacing: 'evenly',
							style: {
								color: { background: MOSS, text: CREAM },
								dimensions: { minHeight: '340px' },
								spacing: {
									padding: {
										top: '2rem',
										right: '2rem',
										bottom: '2rem',
										left: '2rem',
									},
								},
								typography: { fontSize: '1.35rem' },
							},
						} ),
					]
				),
			},
			{
				title: 'Hide a slide per breakpoint',
				note: 'Each of these is hidden at one screen size. The editor always shows all three; on the published page the matching one is removed before Swiper counts the slides, so the pagination stays honest.',
				slider: slider(
					{
						ariaLabel: 'Responsive visibility',
						effect: 'slide',
						loop: false,
						equalHeight: true,
					},
					[
						slide( 'Not on mobile', 'This slide disappears on narrow screens.', {
							hideOnMobile: true,
							contentSpacing: 'evenly',
							style: {
								color: { background: NAVY, text: CREAM },
								spacing: { padding: { top: '1.75rem', right: '1.5rem', bottom: '1.75rem', left: '1.5rem' } },
								border: { radius: '6px' },
							},
						} ),
						slide( 'Not on tablet', 'This one goes at tablet widths.', {
							hideOnTablet: true,
							contentSpacing: 'evenly',
							style: {
								color: { background: CLAY, text: CREAM },
								spacing: { padding: { top: '1.75rem', right: '1.5rem', bottom: '1.75rem', left: '1.5rem' } },
								border: { radius: '6px' },
							},
						} ),
						slide( 'Not on desktop', 'And this one is for small screens only.', {
							hideOnDesktop: true,
							contentSpacing: 'evenly',
							style: {
								color: { background: MOSS, text: CREAM },
								spacing: { padding: { top: '1.75rem', right: '1.5rem', bottom: '1.75rem', left: '1.5rem' } },
								border: { radius: '6px' },
							},
						} ),
					]
				),
			},
			{
				title: 'Full width',
				note: 'Alignment is the standard block one: none, wide or full. This slider is full.',
				slider: slider(
					{
						align: 'full',
						ariaLabel: 'Full width',
						effect: 'slide',
						loop: true,
						equalHeight: true,
						slidesPerViewMobile: 1,
						slidesPerViewTablet: 2,
						slidesPerViewDesktop: 4,
						spaceBetweenMobile: 12,
						spaceBetweenTablet: 16,
						spaceBetweenDesktop: 20,
					},
					numbered( 6, 'Full' )
				),
				},
		];
	}

	function buildDocument() {
		var blocks = [
			paragraph(
				'Every section below is a real GlidePress slider, configured to show one thing. Select any slider and its settings appear in the sidebar. The editor lays slides out side by side rather than running them — <strong>publish the page and view it</strong> to see the effects, autoplay and responsive behaviour for real.'
			),
		];

		buildSections().forEach( function ( section ) {
			blocks.push( heading( section.title ) );
			blocks.push( paragraph( section.note ) );
			blocks.push( section.slider );
		} );

		return blocks;
	}

	var timer = null;
	var tries = 0;
	// Why the last attempt didn't seed. Surfaced in the editor if we give up:
	// the first version of this failed silently and looked identical to a
	// plugin that hadn't installed.
	var blocked = 'nothing attempted yet';

	function stop() {
		if ( timer ) {
			clearInterval( timer );
			timer = null;
		}
	}

	function log( message ) {
		if ( window.console && console.log ) {
			console.log( '[GlidePress demo] ' + message );
		}
	}

	/**
	 * The onboarding modal covers the post the moment it is seeded, which is
	 * the opposite of what a demo wants. The preference scope moved between
	 * WordPress versions, so set both.
	 */
	function dismissWelcomeGuide() {
		var preferences = wp.data.dispatch( 'core/preferences' );
		if ( ! preferences || ! preferences.set ) {
			return;
		}
		[ 'core/edit-post', 'core' ].forEach( function ( scope ) {
			try {
				preferences.set( scope, 'welcomeGuide', false );
			} catch ( error ) {
				// Scope doesn't exist on this version; the other one will.
			}
		} );
	}

	/**
	 * @return {string} 'seeded' when the document was inserted, 'skip' when
	 * there is deliberately nothing to do, 'wait' to try again.
	 */
	function trySeed() {
		if ( ! window.wp || ! wp.data || ! wp.blocks ) {
			blocked = 'the wp.data and wp.blocks packages have not loaded';
			return 'wait';
		}
		// The plugin registers its blocks from block.json on editor load;
		// until that has happened createBlock would produce invalid blocks.
		if ( ! wp.blocks.getBlockType( 'glidepress/slider' ) ) {
			blocked =
				'the glidepress/slider block never registered, so the plugin did not install or activate';
			return 'wait';
		}
		var editor = wp.data.select( 'core/editor' );
		var blockEditor = wp.data.select( 'core/block-editor' );
		if ( ! editor || ! blockEditor ) {
			blocked = 'the core/editor and core/block-editor stores are not ready';
			return 'wait';
		}
		// No current post yet means the editor is still starting up.
		var post = editor.getCurrentPost && editor.getCurrentPost();
		if ( ! post || ! post.id ) {
			blocked = 'no post is loaded yet';
			return 'wait';
		}

		// Never overwrite anyone's work. An untouched new post is empty, or
		// holds the single empty paragraph some versions start you with.
		var existing = blockEditor.getBlocks();
		var isEmpty =
			existing.length === 0 ||
			( existing.length === 1 &&
				existing[ 0 ].name === 'core/paragraph' &&
				! String(
					( existing[ 0 ].attributes &&
						existing[ 0 ].attributes.content ) ||
						''
				).trim() );

		if ( ! isEmpty ) {
			blocked = 'the post already has content';
			return 'skip';
		}

		// isCleanNewPost has come and gone between versions, so it is a
		// bonus check rather than a gate — calling it blind is what broke
		// the first version of this script.
		if (
			typeof editor.isCleanNewPost === 'function' &&
			! editor.isCleanNewPost() &&
			post.status !== 'auto-draft'
		) {
			blocked = 'the post is not a clean new post';
			return 'skip';
		}

		dismissWelcomeGuide();

		var blocks = buildDocument();
		wp.data.dispatch( 'core/editor' ).editPost( {
			title: 'GlidePress kitchen sink',
		} );
		wp.data.dispatch( 'core/block-editor' ).resetBlocks( blocks );

		// Select the first slider, not the intro paragraph: the point of the
		// demo is the slider inspector.
		var firstSlider = blocks.filter( function ( block ) {
			return block.name === 'glidepress/slider';
		} )[ 0 ];
		if ( firstSlider ) {
			wp.data
				.dispatch( 'core/block-editor' )
				.selectBlock( firstSlider.clientId );
		}

		// Put the block inspector on screen. The sidebar store moved from
		// core/edit-post to core/editor in WordPress 6.5+, so try the new
		// home first.
		[ 'core/editor', 'core/edit-post' ].some( function ( store ) {
			var dispatcher = wp.data.dispatch( store );
			if ( ! dispatcher || ! dispatcher.openGeneralSidebar ) {
				return false;
			}
			dispatcher.openGeneralSidebar( 'edit-post/block' );
			return true;
		} );

		return 'seeded';
	}

	/** Report a give-up in the editor itself, not just the console. */
	function report() {
		var message =
			'The GlidePress demo could not build its showcase post: ' +
			blocked +
			'. The editor is otherwise fine — add a GlidePress Slider block ' +
			'yourself from the inserter.';
		log( message );
		var notices = wp.data.dispatch( 'core/notices' );
		if ( notices && notices.createNotice ) {
			notices.createNotice( 'warning', message, { isDismissible: true } );
		}
	}

	wp.domReady( function () {
		// Poll rather than subscribe: the editor stores register in an order
		// that has changed between WordPress versions, and a poll that finds
		// nothing simply tries again. ~30s, which is generous even for a cold
		// Playground boot on a slow machine.
		function tick() {
			tries++;
			var state;
			try {
				state = trySeed();
			} catch ( error ) {
				// Without this, a selector that has been removed upstream
				// throws every 150ms and the demo looks like it did nothing.
				blocked = 'it threw — ' + ( error && error.message );
				state = 'wait';
			}

			if ( state === 'seeded' ) {
				stop();
				log( 'seeded the kitchen sink' );
				return;
			}
			if ( state === 'skip' ) {
				stop();
				log( 'nothing to do: ' + blocked );
				return;
			}
			if ( tries > 200 ) {
				stop();
				report();
			}
		}

		timer = setInterval( tick, 150 );
		tick();
	} );
} )();
`;

/** Must-use plugin that loads SEED_SCRIPT in the block editor. */
const SEED_PLUGIN = `<?php
/**
 * GlidePress demo bootstrap. Exists only inside the Playground demo; it is
 * not part of the plugin.
 */

add_action(
	'enqueue_block_editor_assets',
	static function () {
		wp_enqueue_script(
			'glidepress-demo-seed',
			content_url( 'mu-plugins/glidepress-demo.js' ),
			array( 'wp-dom-ready', 'wp-data', 'wp-blocks' ),
			'1',
			true
		);
	}
);
`;

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * CORS preflight for the two routes Playground fetches cross-origin.
 *
 * Both are simple GETs, so a deployed site is never preflighted at all — this
 * exists for `wrangler dev`. Chrome classes a request from a public https page
 * (playground.wordpress.net) to 127.0.0.1 as Private Network Access and
 * preflights it regardless, then requires the response to opt in explicitly.
 * Without this the demo cannot be exercised locally: the fetch fails before
 * the GET is ever sent.
 */
function corsPreflight(request) {
	const headers = {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
		"Access-Control-Max-Age": "86400",
	};
	if (request.headers.get("Access-Control-Request-Private-Network") === "true") {
		headers["Access-Control-Allow-Private-Network"] = "true";
	}
	return new Response(null, { status: 204, headers });
}

/** Newest published release, by the same ordering the changelog uses. */
async function latestRelease(env) {
	const versions = (await env.REPO.get("versions", "json")) || [];
	return [...versions].sort((a, b) => (b.time || "").localeCompare(a.time || ""))[0] || null;
}

/**
 * The plugin zip for the newest release. Public and CORS-enabled so the
 * blueprint's installPlugin step can fetch it from the Playground origin.
 * Cached briefly rather than immutably: the URL is stable while the version
 * behind it moves, so a new release has to be able to take over.
 */
async function handleZip(request, env) {
	if (request.method !== "GET" && request.method !== "HEAD") {
		return new Response("Method not allowed", { status: 405 });
	}

	const latest = await latestRelease(env);
	if (!latest) return new Response("No releases published", { status: 404 });

	const zip = await env.REPO.get(`dist:${latest.version}`, "stream");
	if (!zip) return new Response("Release archive missing", { status: 404 });

	return new Response(zip, {
		headers: {
			"Content-Type": "application/zip",
			"Content-Disposition": `attachment; filename="glidepress-slider-${latest.version}.zip"`,
			"Access-Control-Allow-Origin": "*",
			// No ETag here, unlike /dist/*: this URL's contents change when a
			// release is published, and a Playground boot fetches it once, so
			// there is nothing for a validator to save.
			"Cache-Control": "public, max-age=300",
		},
	});
}

/**
 * Playground blueprint. Fetched cross-origin by playground.wordpress.net, so
 * it needs CORS; it is generated per-request rather than served as a static
 * file so the zip URL follows the request's own origin instead of hardcoding
 * the production hostname.
 *
 * Note that `wrangler dev` reports the origin from the [[routes]] custom
 * domain over http, so the demo can't be booted end-to-end locally — the
 * Playground page is https and won't fetch an http resource. Exercise the
 * routes locally, the full boot on a deployed URL.
 */
async function handleBlueprint(request, env, url) {
	if (request.method !== "GET" && request.method !== "HEAD") {
		return new Response("Method not allowed", { status: 405 });
	}

	const blueprint = {
		$schema: "https://playground.wordpress.net/blueprint-schema.json",
		landingPage: "/wp-admin/post-new.php",
		preferredVersions: { php: "8.3", wp: "latest" },
		// The demo needs nothing from the network once it has booted, and the
		// blueprint's own resources are fetched by the browser, not by PHP.
		features: { networking: false },
		steps: [
			// Password omitted deliberately — the field is deprecated in the
			// blueprint schema and the step defaults to the admin account.
			{ step: "login", username: "admin" },
			{
				step: "installPlugin",
				pluginData: { resource: "url", url: `${url.origin}${ZIP_PATH}` },
				options: { activate: true },
			},
			{
				step: "writeFile",
				path: "/wordpress/wp-content/mu-plugins/glidepress-demo.js",
				data: SEED_SCRIPT,
			},
			{
				step: "writeFile",
				path: "/wordpress/wp-content/mu-plugins/glidepress-demo.php",
				data: SEED_PLUGIN,
			},
			{
				step: "setSiteOptions",
				options: {
					blogname: "GlidePress demo",
					blogdescription: "A throwaway WordPress running in your browser",
				},
			},
		],
	};

	return new Response(JSON.stringify(blueprint, null, "\t"), {
		headers: {
			"Content-Type": "application/json",
			"Access-Control-Allow-Origin": "*",
			"Cache-Control": "public, max-age=300",
		},
	});
}

/** The demo page itself. */
async function handlePage(request, env, url) {
	if (request.method !== "GET" && request.method !== "HEAD") {
		return new Response("Method not allowed", { status: 405 });
	}

	const latest = await latestRelease(env);
	const versionNote = latest
		? `You will be running version ${latest.version} — the same archive the Composer repository serves.`
		: "No release has been published yet, so the editor will start without the plugin.";

	// Playground reads the blueprint from this query parameter and fetches it
	// back off this origin, which is why /demo/blueprint.json is CORS-enabled.
	const PLAYGROUND_URL = `${PLAYGROUND_ORIGIN}/?blueprint-url=${encodeURIComponent(
		`${url.origin}/demo/blueprint.json`
	)}`;

	const html = `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>Live demo — GlidePress Slider</title>
	<meta name="description" content="Try the GlidePress Slider block in a real WordPress block editor, running entirely in your browser. Nothing to install.">
	<link rel="canonical" href="https://glidepress.jmwerk.com/demo">
	<meta property="og:title" content="GlidePress Slider — live demo">
	<meta property="og:description" content="A real WordPress block editor in your browser. Build a slider, then look at the published page.">
	<meta property="og:type" content="website">
	<meta property="og:url" content="https://glidepress.jmwerk.com/demo">
	<meta property="og:image" content="https://glidepress.jmwerk.com/assets/og.png">
	<link rel="icon" href="${FAVICON}">
	<link rel="stylesheet" href="/assets/site.css">
</head>
<body>

${siteHeader("/demo")}

<main>
	<section class="section">
		<div class="wrap">
			<p class="kicker">Live demo</p>
			<h1>A real editor, not a screenshot.</h1>
			<p class="section__lead">
				The link below opens an actual WordPress &mdash; PHP compiled to
				WebAssembly, running in your browser &mdash; with GlidePress installed
				and a kitchen-sink post already written: a dozen sliders, one per
				feature, from the four effects to autoplay, peeking neighbours, styled
				controls and per-breakpoint visibility. Select any of them and its
				settings are right there in the sidebar.
			</p>
			<p class="section__lead">
				The editor lays slides out side by side rather than running them, so
				<b>publish the post and view it</b> &mdash; that page runs the same
				Swiper&nbsp;12 frontend a real install would, and it&rsquo;s where the
				effects and autoplay actually move.
			</p>

			<div class="demo-launch">
				<p class="demo-launch__cta">
					<a class="btn" href="${PLAYGROUND_URL}" target="_blank" rel="noopener external">Open the editor</a>
					<span class="quiet-link">opens playground.wordpress.net in a new tab</span>
				</p>
				<p class="footnote">
					Roughly 40&nbsp;MB and a few seconds to start. Everything runs on
					your machine &mdash; nothing is uploaded, nothing is saved, and
					closing the tab throws the whole site away. Best on a desktop
					browser; it asks a lot of a phone.
					${versionNote}
				</p>
			</div>
		</div>
	</section>

	<section class="section section--rule">
		<div class="wrap">
			<h2>What to try</h2>
			<ul class="plain-list">
				<li><b>Publish it first.</b> Everything below is more interesting on the published page, where the sliders actually run.</li>
				<li>Resize the window on that page: slides per view steps 3&rarr;2&rarr;1, and the <i>Hide a slide per breakpoint</i> section drops a different slide at each size.</li>
				<li>Tab to a slider and use <kbd>&larr;</kbd> and <kbd>&rarr;</kbd>. Slide changes are announced.</li>
				<li>Let the autoplay slider run, then hover it, then use its pause button.</li>
				<li>Back in the editor, switch <b>Effect</b> on any slider and watch the slides-per-view controls grey out for everything but Slide.</li>
				<li>Select a single slide and change its background, padding, border or shadow &mdash; those are stock WordPress controls, not ours.</li>
				<li>Add a block inside a slide: an image, a button, a heading, columns.</li>
			</ul>
			<p class="footnote">
				This is the plugin exactly as shipped &mdash; the demo installs the
				current release zip at boot, so what you see here is what you get.
				Nothing you do is saved; reload the page and it&rsquo;s a fresh
				WordPress again.
			</p>
		</div>
	</section>
</main>

${SITE_FOOTER}

</body>
</html>
`;

	// No CSP exception and no script: the page is a link, so Playground runs on
	// its own origin in its own tab. Framing it needed frame-src plus a script
	// to build the iframe, and cost the editor the permissions an embedded
	// cross-origin frame doesn't get (focus, fullscreen) along with the width.
	return new Response(html, { headers: htmlHeaders({ cacheControl: "public, max-age=300" }) });
}

export async function handleDemo(request, env, url) {
	const isCrossOrigin = url.pathname === "/demo/blueprint.json" || url.pathname === ZIP_PATH;
	if (isCrossOrigin && request.method === "OPTIONS") return corsPreflight(request);

	if (url.pathname === "/demo" || url.pathname === "/demo/") return handlePage(request, env, url);
	if (url.pathname === "/demo/blueprint.json") return handleBlueprint(request, env, url);
	if (url.pathname === ZIP_PATH) return handleZip(request, env);
	return new Response("Not found", { status: 404 });
}
