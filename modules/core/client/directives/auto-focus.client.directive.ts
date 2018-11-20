(() => {
	'use strict';

	// Focus the element on page load
	// Unless the user is on a small device, because this could obscure the page with a keyboard

	angular.module('core').directive('autofocus', autofocus);

	autofocus.$inject = ['$timeout', '$window'];

	function autofocus($timeout, $window) {
		const directive = {
			restrict: 'A',
			link
		};

		return directive;

		function link(scope, element) {
			if ($window.innerWidth >= 800) {
				$timeout(() => {
					element[0].focus();
				}, 100);
			}
		}
	}
})();