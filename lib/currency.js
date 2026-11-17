'use strict';

/**
 * Display unit for Tibber's rewardCurrency (ISO 4217). Swedish, Norwegian and
 * Danish crowns are all shown as "kr", like in Tibber's app.
 */
const UNITS = {
  SEK: 'kr', NOK: 'kr', DKK: 'kr', EUR: '€',
};

function unitFor(code) {
  if (!code) return 'kr';
  return UNITS[code] || code;
}

module.exports = { unitFor };
