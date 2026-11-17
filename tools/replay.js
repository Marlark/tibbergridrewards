#!/usr/bin/env node
'use strict';

/**
 * Replays a recording (JSONL, one {t, tz, status} per line) through the same
 * logic as the app and checks that the results are sane.
 *
 *   node tools/replay.js test/fixtures/my-day.jsonl
 */

const fs = require('fs');
const {
  parseStatus, applyUpdate, settle, localDayKey, SETTLE_MS,
} = require('../lib/RewardTracker');

function parseJsonl(text) {
  return text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function replay(records) {
  let state = {};
  // Sessions started but not yet reported as ended. Can be 2 for a moment:
  // a new session may start before the previous one's settlement arrives.
  let open = 0;
  const steps = [];
  const violations = [];
  const check = (i, events) => {
    for (const ev of events) {
      if (ev.type === 'day_ended' || ev.type === 'month_ended') {
        if (ev.reward < 0) violations.push(`#${i}: ${ev.type} reward ${ev.reward} < 0`);
      } else if (ev.type === 'session_started') {
        open += 1;
        if (open > 2) violations.push(`#${i}: ${open} sessions open at once`);
      } else {
        if (open === 0) violations.push(`#${i}: session ended without start`);
        if (ev.reward < 0) violations.push(`#${i}: session reward ${ev.reward} < 0`);
        open = Math.max(0, open - 1);
      }
    }
  };
  records.forEach((r, i) => {
    const p = parseStatus(r.status);
    const dayKey = localDayKey(new Date(r.t), r.tz || 'Europe/Stockholm');
    const res = applyUpdate(state, {
      month: p.month, gridState: p.gridState, dayKey, now: r.t,
    });
    state = res.state;
    check(i, res.events);
    if (res.today !== null && res.today < 0) violations.push(`#${i}: today ${res.today} < 0`);
    if (res.sessionReward < 0) violations.push(`#${i}: session ${res.sessionReward} < 0`);
    steps.push({
      t: r.t, dayKey, ...p, today: res.today, session: res.sessionReward, events: res.events,
    });
  });
  // As the app's timer would: close a session still awaiting settlement at the end.
  if (records.length) {
    const end = settle(state, records.at(-1).t + SETTLE_MS);
    state = end.state;
    check(records.length, end.events);
    if (end.events.length) steps.at(-1).events.push(...end.events);
  }
  return { state, steps, violations };
}

if (require.main === module) {
  const { steps, violations } = replay(parseJsonl(fs.readFileSync(process.argv[2], 'utf8')));
  for (const s of steps) {
    const ev = s.events.map((e) => {
      if (e.type === 'session_ended') return `ended ${e.reward} kr / ${e.minutes} min`;
      if (e.type === 'month_ended') return `MONTH ${e.month}: ${e.reward} kr, ${e.sessions} sessions`;
      if (e.type === 'day_ended') return `DAY ${e.date}: ${e.reward} kr, ${e.sessions} sessions, ${e.minutes} min`;
      return 'started';
    }).join(', ');
    console.log([new Date(s.t).toISOString(), s.gridState.padEnd(11), `month ${s.month}`,
      `today ${s.today}`, `session ${s.session}`, ev].join('  '));
  }
  console.log(violations.length ? `\n${violations.length} problem(s):\n${violations.join('\n')}` : '\nNo problems found.');
  process.exitCode = violations.length ? 1 : 0;
}

module.exports = { replay, parseJsonl };
