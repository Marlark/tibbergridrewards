#!/usr/bin/env node
'use strict';

/**
 * Replays a recording (JSONL, one {t, tz, status} per line) through the same
 * logic as the app and checks that the results are sane.
 *
 *   node tools/replay.js test/fixtures/my-day.jsonl
 */

const fs = require('fs');
const { parseStatus, applyUpdate, localDayKey } = require('../lib/RewardTracker');

function parseJsonl(text) {
  return text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function replay(records) {
  let state = {};
  let open = false;
  const steps = [];
  const violations = [];
  records.forEach((r, i) => {
    const p = parseStatus(r.status);
    const dayKey = localDayKey(new Date(r.t), r.tz || 'Europe/Stockholm');
    const res = applyUpdate(state, {
      month: p.month, gridState: p.gridState, dayKey, now: r.t,
    });
    state = res.state;
    for (const ev of res.events) {
      if (ev.type === 'session_started') {
        if (open) violations.push(`#${i}: session started twice`);
        open = true;
      } else {
        if (!open) violations.push(`#${i}: session ended without start`);
        if (ev.reward < 0) violations.push(`#${i}: session reward ${ev.reward} < 0`);
        open = false;
      }
    }
    if (res.today !== null && res.today < 0) violations.push(`#${i}: today ${res.today} < 0`);
    if (res.sessionReward < 0) violations.push(`#${i}: session ${res.sessionReward} < 0`);
    steps.push({
      t: r.t, dayKey, ...p, today: res.today, session: res.sessionReward, events: res.events,
    });
  });
  return { state, steps, violations };
}

if (require.main === module) {
  const { steps, violations } = replay(parseJsonl(fs.readFileSync(process.argv[2], 'utf8')));
  for (const s of steps) {
    const ev = s.events.map((e) => (e.type === 'session_ended'
      ? `ended ${e.reward} kr / ${e.minutes} min` : 'started')).join(', ');
    console.log([new Date(s.t).toISOString(), s.gridState.padEnd(11), `month ${s.month}`,
      `today ${s.today}`, `session ${s.session}`, ev].join('  '));
  }
  console.log(violations.length ? `\n${violations.length} problem(s):\n${violations.join('\n')}` : '\nNo problems found.');
  process.exitCode = violations.length ? 1 : 0;
}

module.exports = { replay, parseJsonl };
