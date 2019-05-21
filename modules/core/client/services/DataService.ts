'use strict';

import angular from 'angular';

export interface IDataService {
	cities: string[];
}

angular.module('core').service('DataService', () => {
	return {
		cities: [
			'Edmonton',
			'Airdrie',
			'Beaumont',
			'Brooks',
			'Calgary',
			'Camrose',
			'Chestermere',
			'Cold Lake',
			'Fort Saskatchewan',
			'Grande Prairie',
			'Lacombe',
			'Leduc',
			'Lethbridge',
			'Lloydminster',
			'Medicine Hat',
			'Red Deer',
			'Spruce Grove',
			'St. Albert',
			'Wetaskiwin'
		]
	} as IDataService;
});
