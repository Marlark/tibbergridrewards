'use strict';

/**
 * Data for the "last 7 days" widget: one bar per day from the home device's daily
 * totals, and today's reward so far. Days before the app was installed are null
 * (shown as "–"), not 0.
 */

const { localDayKey } = require('../../lib/RewardTracker');
const { localeFor } = require('../../lib/i18n');

const DAY_MS = 24 * 3600 * 1000;

/** The n dates up to and including today (YYYY-MM-DD), oldest first. */
function lastDates(today, n) {
  const [y, m, d] = today.split('-').map(Number);
  const base = Date.UTC(y, m - 1, d);
  return Array.from({ length: n }, (_, i) => new Date(base - (n - 1 - i) * DAY_MS).toISOString().slice(0, 10));
}

function homesOf(homey) {
  try {
    return homey.drivers.getDriver('grid-reward').getDevices();
  } catch (err) {
    return [];
  }
}

async function getWeek({ homey, query = {} }) {
  const homes = homesOf(homey);
  const home = homes.find((d) => d.getId && d.getId() === query.deviceId) || homes[0];
  if (!home) return { error: homey.__('error.no_home_device') };

  const today = localDayKey(new Date(), homey.clock.getTimezone());
  const weekday = new Intl.DateTimeFormat(localeFor(homey.i18n.getLanguage()), { weekday: 'short', timeZone: 'UTC' });
  const byDate = Object.fromEntries(home.getDays().map((d) => [d.date, d]));
  const todayValue = home.hasCapability('grid_reward_today') ? home.getCapabilityValue('grid_reward_today') : null;

  const days = lastDates(today, 7).map((date) => {
    const known = byDate[date];
    let reward = known ? known.reward : null;
    if (date === today) reward = typeof todayValue === 'number' ? todayValue : 0;
    return {
      date, label: weekday.format(new Date(`${date}T12:00:00Z`)), reward, today: date === today,
    };
  });
  const total = Math.round(days.reduce((sum, d) => sum + (d.reward || 0), 0) * 100) / 100;

  return {
    name: home.getName ? home.getName() : '',
    unit: home.getCurrencyUnit ? home.getCurrencyUnit() : 'kr',
    days,
    total,
    labels: { title: homey.__('widget.week_title'), today: homey.__('widget.today') },
  };
}

module.exports = { getWeek };
