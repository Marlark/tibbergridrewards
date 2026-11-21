'use strict';

/**
 * Session history for the settings page (served by api.js). Dates are formatted
 * here, in Homey's time zone and language.
 */

const { localDayKey } = require('./RewardTracker');
const { reasonText } = require('./reasons');
const { localeFor, dateFormat } = require('./i18n');
const { planSvg } = require('./planChart');
const { homesOf, flexDevicesOf } = require('./devices');
const { TYPES } = require('./records');
const { monthRows } = require('./reasonStats');

const round2 = (n) => Math.round(n * 100) / 100;


/**
 * Each battery's planned charge level (#15). Points get a local time label, and
 * the curve comes ready as an SVG (lib/planChart.js). compact: for the widget.
 */
function batteryPlans(homey, timeZone, lang, { compact = false } = {}) {
  const hm = dateFormat(lang, { timeZone, hour: '2-digit', minute: '2-digit' });
  const day = dateFormat(lang, { timeZone, weekday: 'short' });
  return flexDevicesOf(homey)
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
      // The battery's day (#29, #48): today so far and the last 14 finished days.
      const bd = d.getBatteryDays ? d.getBatteryDays() : { today: null, days: [] };
      const batteryDays = [...(bd.today ? [{ ...bd.today, today: true }] : []),
        ...bd.days.filter((x) => !bd.today || x.date !== bd.today.date)].slice(0, 15);
      return {
        id: d.getData().id,
        deviceId: d.getId ? d.getId() : null,
        name: d.getName(),
        updated: updatedAt ? hm.format(new Date(updatedAt)) : null,
        soc: first ? first.soc : null,
        points: local,
        svg: planSvg(local, { title: homey.__('history.plan_title'), compact }),
        days: batteryDays,
        unit: d.getStoreValue ? d.getStoreValue('currencyUnit') || 'kr' : 'kr',
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

/**
 * Records for the page (#31, #73): one row per home/car/battery with its best day,
 * best session and longest session, dates formatted.
 */
function recordRows(homey, device, timeZone, lang) {
  if (!device.getRecords) return [];
  const all = device.getRecords();
  const date = dateFormat(lang, { timeZone, day: 'numeric', month: 'short', year: 'numeric' });
  const when = (at) => {
    if (!at) return '';
    const d = typeof at === 'number' ? new Date(at) : new Date(`${at}T12:00:00Z`);
    return date.format(d);
  };
  const row = (name, rec) => ({
    name,
    items: TYPES.filter((t) => rec && rec[t]).map((t) => ({
      type: t,
      label: homey.__(`records.${t}`),
      value: rec[t].value,
      minutes: t === 'longestSession',
      when: when(rec[t].at),
    })),
  });
  const rows = [row(device.getName(), all.home)];
  for (const id of Object.keys(all)) {
    if (id === 'home') continue;
    rows.push(row(device.flexName ? device.flexName(id) : id, all[id]));
  }
  return rows.filter((r) => r.items.length);
}

/** Sessions and reward per reason (#17): this month and the month before. */
function reasonMonths(homey, device, lang) {
  if (!device.getReasonStats) return [];
  const all = device.getReasonStats();
  const fmt = dateFormat(lang, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return Object.keys(all).sort().reverse().slice(0, 2).map((month) => ({
    month,
    label: fmt.format(new Date(`${month}-15T12:00:00Z`)),
    rows: monthRows(all[month]).map((r) => ({
      ...r,
      text: r.reason === 'unknown' ? '–' : reasonText(homey, [r.reason]),
    })),
  }));
}

function getHistory({ homey }) {
  const timeZone = homey.clock.getTimezone();
  const lang = localeFor(homey.i18n.getLanguage());
  const fmt = dateFormat(lang, {
    timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
  const labels = Object.fromEntries(['title', 'empty', 'per_day', 'sessions', 'when', 'reward', 'duration',
    'reason', 'total', 'min', 'sessions_count', 'no_home',
    'plan_title', 'plan_soc', 'plan_charge', 'plan_discharge', 'plan_empty', 'plan_note',
    'export_title', 'export_sessions', 'export_days', 'export_download', 'export_copy', 'export_empty',
    'export_rows', 'export_copied', 'export_copy_failed', 'device', 'all_devices', 'records',
    'battery_days', 'bd_gr', 'bd_price', 'bd_solar', 'bd_charged', 'bd_discharged', 'bd_savings', 'today',
    'settled', 'reasons_title', 'share'].map((k) => [k, homey.__(`history.${k}`)]));

  const homes = homesOf(homey).map((device) => {
    const sessions = device.getHistory().map((s) => ({
      ...s,
      when: fmt.format(new Date(s.startedAt || s.endedAt)),
      date: localDayKey(new Date(s.endedAt), timeZone),
      reasonText: reasonText(homey, s.reason ? String(s.reason).split(', ') : []),
      // The car/battery that delivered (#69); older sessions do not know.
      devices: (s.flex || []).map((id) => (device.flexName ? device.flexName(id) : id)),
    }));
    return {
      id: device.getData().id,
      name: device.getName(),
      unit: device.getCurrencyUnit ? device.getCurrencyUnit() : 'kr',
      devices: [...new Set(sessions.flatMap((s) => s.devices))].sort(),
      records: recordRows(homey, device, timeZone, lang),
      reasons: reasonMonths(homey, device, lang),
      sessions,
      days: perDay(sessions, timeZone),
      total: round2(sessions.reduce((sum, s) => sum + s.reward, 0)),
    };
  });
  return { labels, homes, batteries: batteryPlans(homey, timeZone, lang) };
}

module.exports = { getHistory, perDay, batteryPlans };
