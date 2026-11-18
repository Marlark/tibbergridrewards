'use strict';

// Replays every recording in test/fixtures through the app logic.
// Add real recordings (see tools/extract-recording.js) and they are tested automatically.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { replay, parseJsonl } = require('../tools/replay');
const { extract, decode } = require('../tools/extract-recording');

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

test('real recording: every session gets its late settlement', () => {
  const { steps } = replay(load('real-2026-11-17.jsonl'));
  const ended = steps.flatMap((s) => s.events).filter((e) => e.type === 'session_ended');
  // Without waiting for settlement the sum was 16.19 kr; Tibber paid 0.46 kr more.
  assert.deepStrictEqual(ended.map((e) => e.reward), [0.29, 1.73, 5.02, 1.09, 1.34, 3.25, 1.16, 0.23, 2.53]);
});

test('extract picks [REC] lines out of a Homey log', () => {
  const log = [
    '2026-11-16T10:00:00.000Z [log] [Device:abc] Reconnecting in 5 s',
    '2026-11-16T10:00:01.000Z [log] [Device:abc] [REC] {"t":1,"tz":"Europe/Stockholm","status":{}}',
    '... [REC] {"t":2, broken',
  ].join('\n');
  assert.deepStrictEqual(extract(log), ['{"t":1,"tz":"Europe/Stockholm","status":{}}']);
});

test('decode handles PowerShell tee output (UTF-16LE with BOM) and colour codes', () => {
  const line = '\x1b[35m2026-11-17T10:00:00.000Z\x1b[39m [log] [Device:abc] [REC] {"t":1,"status":{}}\r\n';
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(line, 'utf16le')]);
  assert.deepStrictEqual(extract(decode(buf)), ['{"t":1,"status":{}}']);
  assert.deepStrictEqual(extract(decode(Buffer.from(line, 'utf8'))), ['{"t":1,"status":{}}']);
});

test('anonymize replaces ids and names and leaves nothing behind', () => {
  const { anonymize } = require('../tools/anonymize-recording');
  const rec = (homeId) => ({
    t: 1,
    tz: 'Europe/Stockholm',
    status: {
      homeId,
      rewardCurrentMonth: 5,
      flexDevices: [
        { vehicleId: 'v-real-123', shortName: 'My Tesla', make: 'Tesla', imgUrl: 'https://x/me.png' },
        { batteryId: 'b-real-456', shortName: 'Storgatan 1', make: 'Huawei' },
      ],
    },
  });
  const out = anonymize([rec('h-real-789'), rec('h-real-789')]);
  const text = JSON.stringify(out);
  for (const secret of ['h-real-789', 'v-real-123', 'b-real-456', 'My Tesla', 'Storgatan 1', 'me.png']) {
    assert.ok(!text.includes(secret), secret);
  }
  assert.strictEqual(out[1].status.homeId, 'home-1');
  assert.deepStrictEqual(out[0].status.flexDevices.map((f) => [f.vehicleId || f.batteryId, f.shortName, f.make]),
    [['vehicle-1', 'Car', 'Tesla'], ['battery-1', 'Battery', 'Huawei']]);
  assert.strictEqual(out[0].status.rewardCurrentMonth, 5);
});

test('the committed real recording is anonymised', () => {
  const text = fs.readFileSync(path.join(dir, 'real-2026-11-17.jsonl'), 'utf8');
  const ids = [...text.matchAll(/"(homeId|vehicleId|batteryId)":"([^"]+)"/g)].map((m) => m[2]);
  assert.ok(ids.length > 0);
  assert.ok(ids.every((id) => /^(home|vehicle|battery)-\d+$/.test(id)), 'only anonymised ids');
  const names = [...text.matchAll(/"shortName":"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(names.every((n) => n === 'Car' || n === 'Battery'), 'only anonymised names');
});
