'use strict';

/**
 * History as CSV for the settings page (#10): finished sessions (the last 100 per
 * home) or daily totals (about a year per home). All homes in one file, with a
 * column for the home.
 *
 * Spreadsheets read CSV in the user's locale: English gets "," between fields and
 * a decimal point; the other languages get ";" and a decimal comma (as Excel and
 * Numbers expect in Sweden, Norway, Denmark, Germany and the Netherlands).
 * Times are local to Homey's time zone ("YYYY-MM-DD HH:MM").
 */

const { dateFormat } = require('./i18n');
const { reasonText } = require('./reasons');
const { homesOf } = require('./devices');

const KINDS = ['sessions', 'days'];


function formatFor(language) {
  return language === 'en' ? { sep: ',', comma: false } : { sep: ';', comma: true };
}

/** One field, quoted when it contains the separator, a quote or a line break. */
function field(value, sep) {
  const s = value == null ? '' : String(value);
  return s.includes(sep) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function number(n, comma, decimals = 2) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  const s = n.toFixed(decimals);
  return comma ? s.replace('.', ',') : s;
}

/** "YYYY-MM-DD HH:MM" in the given time zone. */
function localTime(ms, timeZone) {
  if (!ms) return '';
  const parts = Object.fromEntries(dateFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function toCsv(header, rows, sep) {
  // Excel needs the BOM to read UTF-8 (å, ä, ö, ø, æ, €).
  return `﻿${[header, ...rows].map((r) => r.map((v) => field(v, sep)).join(sep)).join('\r\n')}\r\n`;
}

function exportCsv({ homey, kind }) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown export: ${kind}`);
  const language = homey.i18n.getLanguage();
  const { sep, comma } = formatFor(language);
  const timeZone = homey.clock.getTimezone();
  const h = (k) => homey.__(`export.${k}`);
  const homes = homesOf(homey);
  const unitOf = (d) => (d.getCurrencyUnit ? d.getCurrencyUnit() : 'kr');

  let header;
  let rows;
  if (kind === 'sessions') {
    header = [h('home'), h('device'), h('started'), h('ended'), h('minutes'), h('reward'), h('settled'), h('currency'), h('reason')];
    rows = homes.flatMap((d) => d.getHistory().map((s) => [
      d.getName(),
      (s.flex || []).map((id) => (d.flexName ? d.flexName(id) : id)).join(' + '),
      localTime(s.startedAt, timeZone),
      localTime(s.endedAt, timeZone),
      s.minutes,
      number(s.reward, comma),
      s.settled ? number(s.settled, comma) : '',
      unitOf(d),
      reasonText(homey, s.reason ? String(s.reason).split(', ') : []),
    ]));
    rows.sort((a, b) => (a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0)); // oldest first, by end time
  } else {
    header = [h('home'), h('date'), h('sessions'), h('minutes'), h('reward'), h('currency')];
    rows = homes.flatMap((d) => d.getDays().map((x) => [
      d.getName(), x.date, x.sessions, x.minutes, number(x.reward, comma), unitOf(d),
    ]));
    rows.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)); // oldest first
  }

  const today = localTime(Date.now(), timeZone).slice(0, 10);
  return {
    filename: `grid-rewards-${kind}-${today}.csv`,
    rows: rows.length,
    csv: toCsv(header, rows, sep),
  };
}

module.exports = {
  exportCsv, field, localTime, KINDS,
};
