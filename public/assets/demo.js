/**
 * Live demo launcher.
 *
 * Booting WordPress Playground pulls tens of megabytes, so the iframe is only
 * created when the visitor asks for it — the page itself stays as light as the
 * rest of the site. The Worker renders the button with the blueprint URL on it
 * (see src/demo.js) so nothing about the origin is hardcoded here.
 */
( function () {
	'use strict';

	var button = document.getElementById( 'launch-button' );
	var launch = document.getElementById( 'launch' );
	var stage = document.getElementById( 'playground' );
	var host = document.getElementById( 'playground-frame' );
	var fullscreen = document.getElementById( 'fullscreen-button' );

	if ( ! button || ! launch || ! stage || ! host ) {
		return;
	}

	button.addEventListener( 'click', function () {
		var src =
			button.dataset.playground +
			'/?mode=seamless&blueprint-url=' +
			encodeURIComponent( button.dataset.blueprint );

		var frame = document.createElement( 'iframe' );
		frame.src = src;
		frame.title = 'WordPress block editor running GlidePress Slider';
		// Playground needs to write to its own origin storage and open the
		// site preview, so it is framed without a sandbox attribute; it is a
		// separate origin and can't reach anything on this one.
		frame.allow = 'clipboard-write';

		host.appendChild( frame );
		stage.hidden = false;
		launch.hidden = true;

		// The boot takes a while and the iframe is blank at first; move focus
		// so keyboard and screen-reader users are told where they landed.
		stage.setAttribute( 'tabindex', '-1' );
		stage.focus();
	} );

	// Even full-bleed, a laptop viewport is tight for the editor plus its
	// inspector. Fullscreen is on the stage, not the iframe: the frame is
	// cross-origin, so only our own element can make the request.
	if ( fullscreen && stage.requestFullscreen ) {
		fullscreen.addEventListener( 'click', function () {
			if ( document.fullscreenElement ) {
				document.exitFullscreen();
			} else {
				stage.requestFullscreen();
			}
		} );

		document.addEventListener( 'fullscreenchange', function () {
			fullscreen.textContent = document.fullscreenElement
				? 'Exit full screen'
				: 'Full screen';
		} );
	} else if ( fullscreen ) {
		fullscreen.hidden = true;
	}
} )();
