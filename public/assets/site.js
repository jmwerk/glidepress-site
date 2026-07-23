/**
 * GlidePress Slider showcase — demo initialisation.
 *
 * Mirrors the plugin's frontend behaviour: fixed effect defaults, keyboard
 * and A11y modules on, and autoplay that respects prefers-reduced-motion.
 * Sliders below the fold are initialised lazily via IntersectionObserver.
 */
( function () {
	'use strict';

	var reducedMotion = window.matchMedia(
		'(prefers-reduced-motion: reduce)'
	).matches;

	var EFFECT_OPTIONS = {
		slide: {},
		fade: { fadeEffect: { crossFade: true } },
		flip: { flipEffect: { slideShadows: false } },
		creative: {
			creativeEffect: {
				prev: { shadow: true, translate: [ '-20%', 0, -1 ], opacity: 0.6 },
				next: { translate: [ '100%', 0, 0 ] },
			},
		},
	};

	function initSlider( el ) {
		if ( el.dataset.gpInitialized ) {
			return;
		}
		el.dataset.gpInitialized = 'true';

		var effect = el.dataset.gpEffect || 'slide';
		var autoplay = el.dataset.gpAutoplay === 'true' && ! reducedMotion;

		var options = {
			effect: effect,
			speed: reducedMotion ? 0 : 300,
			loop: true,
			keyboard: { enabled: true, onlyInViewport: true },
			a11y: { enabled: true },
			navigation: {
				prevEl: el.querySelector( '.swiper-button-prev' ),
				nextEl: el.querySelector( '.swiper-button-next' ),
			},
			pagination: {
				el: el.querySelector( '.swiper-pagination' ),
				clickable: true,
			},
		};

		if ( autoplay ) {
			options.autoplay = {
				delay: 5000,
				pauseOnMouseEnter: true,
				disableOnInteraction: false,
			};
		}

		Object.assign( options, EFFECT_OPTIONS[ effect ] || {} );

		new window.Swiper( el, options );
	}

	function initAll() {
		var sliders = document.querySelectorAll( '.gp-demo' );

		if ( ! ( 'IntersectionObserver' in window ) ) {
			sliders.forEach( initSlider );
			return;
		}

		var observer = new IntersectionObserver(
			function ( entries ) {
				entries.forEach( function ( entry ) {
					if ( entry.isIntersecting ) {
						initSlider( entry.target );
						observer.unobserve( entry.target );
					}
				} );
			},
			{ rootMargin: '200px' }
		);

		sliders.forEach( function ( el ) {
			observer.observe( el );
		} );
	}

	initAll();
} )();
