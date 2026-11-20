'use strict';

/**
 * Session history for the settings page (served by api.js). Dates are formatted
 * here, in Homey's time zone and language.
 */

const { localDayKey } = require('./RewardTracker');
const { reasonText } = require('./reasons');
const { localeFor } = require('./i18n');
const { planSvg } = require('./planChart');

const round2 = (n) => Math.round(n * 100) / 100;

function devicesOf(homey, driverId) {
  try {
    return homey.drivers.getDriver(driverId).getDevices();
  } catch (err) {
    return [];
  }
}

const homesOf = (homey) => devicesOf(homey, 'grid-reward');

/**
 * Each battery's planned charge level (#15). Points get a local time label, and
 * the curve comes ready as an SVG (lib/planChart.js). compact: for the widget.
 */
function batteryPlans(homey, timeZone, lang, { compact = false } = {}) {
  const hm = new Intl.DateTimeFormat(lang, { timeZone, hour: '2-digit', minute: '2-digit' });
  const day = new Intl.DateTimeFormat(lang, { timeZone, weekday: 'short' });
  return devicesOf(homey, 'flex-device')
    .filter((d) => d.getData().kind === 'battery' && typeof d.getPlan === 'function')
    .map((d) => {
      const { points, updatedAt } = d.getPlan();
      const local = points.map((p) => {
        const date = new Date(p.time);
        return {
          ...p,
          label: hm.format(date),
          day: day.format(date),
          dayKey: localDayKey(date, timeZone),
        };
      });
      const first = local.find((p) => p.soc != null);
      return {
        id: d.getData().id,
        deviceId: d.getId ? d.getId() : null,
        name: d.getName(),
        updated: updatedAt ? hm.format(new Date(updatedAt)) : null,
        soc: first ? first.soc : null,
        points: local,
        svg: planSvg(local, { title: homey.__('history.plan_title'), compact }),
      };
    });
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
  const lang = localeFor(homey.i18n.getLanguage());
  const fmt = new Intl.DateTimeFormat(lang, {
    timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
  const labels = Object.fromEntries(['title', 'empty', 'per_day', 'sessions', 'when', 'reward', 'duration',
    'reason', 'total', 'min', 'sessions_count', 'no_home',
    'plan_title', 'plan_soc', 'plan_charge', 'plan_discharge', 'plan_empty', 'plan_note'].map((k) => [k, homey.__(`history.${k}`)]));

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
  return { labels, homes, batteries: batteryPlans(homey, timeZone, lang) };
}

module.exports = { getHistory, perDay, batteryPlans };
