#!/usr/bin/env node
'use strict';

/**
 * Makes a recording safe to commit as a test fixture: replaces the home, car and
 * battery ids with home-1 / vehicle-1 / battery-1 and the user-given names
 * (shortName, often an address) with "Car" / "Battery".
 *
 *   node tools/anonymize-recording.js recordings/my-day.jsonl > test/fixtures/my-day.jsonl
 *
 * Amounts, makes, times and the time zone are kept (the tests need them).
 */

const fs = require('fs');

function anonymize(records) {
  const aliases = new Map();
  const counts = { home: 0, vehicle: 0, battery: 0 };
  const alias = (kind, value) => {
    if (value === undefined || value === null) return value;
    if (!aliases.has(value)) {
      counts[kind] += 1;
      aliases.set(value, `${kind}-${counts[kind]}`);
    }
    return aliases.get(value);
  };

  const out = records.map((r) => {
    const status = JSON.parse(JSON.stringify(r.status || {}));
    if (status.homeId) status.homeId = alias('home', status.homeId);
    for (const f of status.flexDevices || []) {
      if (f.vehicleId) {
        f.vehicleId = alias('vehicle', f.vehicleId);
        f.shortName = 'Car';
      }
      if (f.batteryId) {
        f.batteryId = alias('battery', f.batteryId);
        f.shortName = 'Battery';
      }
      delete f.imgUrl; // may point at the user's own picture
    }
    return { ...r, status };
  });

  // Safety net: none of the original values may survive anywhere in the output.
  const text = JSON.stringify(out);
  const leaked = [...aliases.keys()].filter((v) => text.includes(String(v)));
  if (leaked.length) throw new Error(`Anonymisation failed, still contains: ${leaked.join(', ')}`);
  return out;
}

if (require.main === module) {
  const file = process.argv[2];
  const text = fs.readFileSync(file || 0, 'utf8');
  const records = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
  const out = anonymize(records);
  process.stdout.write(out.map((r) => JSON.stringify(r)).join('\n') + (out.length ? '\n' : ''));
  process.stderr.write(`${out.length} records anonymised\n`);
}

module.exports = { anonymize };
