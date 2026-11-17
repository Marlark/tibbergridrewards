'use strict';

/**
 * Translate Tibber reason codes (e.g. 'excess', 'noVehiclesPluggedIn') with the
 * texts in locales/*.json under "reason". Unknown codes are shown as they are,
 * so a new code from Tibber is still visible (and can be added to the locales).
 */
function reasonText(homey, codes) {
  return (codes || []).map((code) => {
    const key = `reason.${code}`;
    let text;
    try {
      text = homey.__(key);
    } catch (err) {
      text = null;
    }
    return !text || text === key ? code : text;
  }).join(', ');
}

module.exports = { reasonText };
