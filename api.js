'use strict';

/**
 * App API, used by the settings page (settings/index.html) to show the session
 * history. Dates are formatted here, in Homey's time zone and language.
 */

const { localDayKey } = require('./lib/RewardTracker');
const { reasonText } = require('./lib/reasons');

const round2 = (n) => Math.round(n * 100) / 100;

function homesOf(homey) {
  try {
    return homey.drivers.getDriver('grid-reward').getDevices();
  } catch (err) {
    return [];
  }
}

/** Sum sessions per local day (the day a session ended), newest first. */
function perDay(sessions, timeZone) {
  const days = new Map();
  for (const s of sessions) {
    const date = localDayKey(new Date(s.endedAt), timeZone);
    const d = days.get(date) || {
      date, reward: 0, sessions: 0, minutes: 0,
    };
    d.reward = round2(d.reward + s.reward);
    d.sessions += 1;
    d.minutes += s.minutes;
    days.set(date, d);
  }
  return [...days.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
}

function getHistory({ homey }) {
  const timeZone = homey.clock.getTimezone();
  const lang = homey.i18n.getLanguage() === 'sv' ? 'sv-SE' : 'en-GB';
  const fmt = new Intl.DateTimeFormat(lang, {
    timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
  const labels = Object.fromEntries(['title', 'empty', 'per_day', 'sessions', 'when', 'reward', 'duration',
    'reason', 'total', 'min', 'sessions_count', 'no_home'].map((k) => [k, homey.__(`history.${k}`)]));

  const homes = homesOf(homey).map((device) => {
    const sessions = device.getHistory().map((s) => ({
      ...s,
      when: fmt.format(new Date(s.startedAt || s.endedAt)),
      reasonText: reasonText(homey, s.reason ? String(s.reason).split(', ') : []),
    }));
    return {
      id: device.getData().id,
      name: device.getName(),
      unit: device.getCurrencyUnit ? device.getCurrencyUnit() : 'kr',
      sessions,
      days: perDay(sessions, timeZone),
      total: round2(sessions.reduce((sum, s) => sum + s.reward, 0)),
    };
  });
  return { labels, homes };
}

module.exports = {
  async getHistory({ homey }) {
    return getHistory({ homey });
  },
  perDay,
};
