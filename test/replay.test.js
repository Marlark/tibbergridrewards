'use strict';

// Replays every recording in test/fixtures through the app logic.
// Add real recordings (see tools/extract-recording.js) and they are tested automatically.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { replay, parseJsonl } = require('../tools/replay');
const { extract } = require('../tools/extract-recording');

const dir = path.join(__dirname, 'fixtures');
const load = (file) => parseJsonl(fs.readFileSync(path.join(dir, file), 'utf8'));

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
  test(`replay ${file}: no impossible values`, () => {
    assert.deepStrictEqual(replay(load(file)).violations, []);
  });
}

test('synthetic month rollover gives the expected totals', () => {
  const { steps } = replay(load('synthetic-month-rollover.jsonl'));
  const ended = steps.flatMap((s) => s.events).filter((e) => e.type === 'session_ended');
  assert.deepStrictEqual(ended.map((e) => e.reward), [1.2, 0.5]);
  assert.strictEqual(steps.at(-1).today, 0.45);
  assert.strictEqual(steps.at(-2).reason, 'vehicleNotPluggedIn');
});

test('extract picks [REC] lines out of a Homey log', () => {
  const log = [
    '2026-11-16T10:00:00.000Z [log] [Device:abc] Reconnecting in 5 s',
    '2026-11-16T10:00:01.000Z [log] [Device:abc] [REC] {"t":1,"tz":"Europe/Stockholm","status":{}}',
    '... [REC] {"t":2, broken',
  ].join('\n');
  assert.deepStrictEqual(extract(log), ['{"t":1,"tz":"Europe/Stockholm","status":{}}']);
});
