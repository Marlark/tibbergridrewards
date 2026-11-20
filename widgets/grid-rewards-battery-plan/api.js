'use strict';

/**
 * Data for the "battery plan" widget (#15): the chosen battery's planned charge
 * level as a ready SVG, the same curve as on the app's settings page.
 */

const { batteryPlans } = require('../../lib/history');
const { localeFor } = require('../../lib/i18n');

async function getPlan({ homey, query = {} }) {
  const lang = localeFor(homey.i18n.getLanguage());
  const batteries = batteryPlans(homey, homey.clock.getTimezone(), lang, { compact: true });
  const b = batteries.find((x) => x.deviceId && x.deviceId === query.deviceId) || batteries[0];
  if (!b) return { error: homey.__('widget.no_battery') };
  return {
    name: b.name,
    soc: b.soc,
    svg: b.svg,
    updated: b.updated,
    labels: Object.fromEntries(['plan_title', 'plan_soc', 'plan_charge', 'plan_discharge', 'plan_empty']
      .map((k) => [k, homey.__(`history.${k}`)])),
  };
}

module.exports = { getPlan };
