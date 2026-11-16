#!/usr/bin/env node
'use strict';

/**
 * Extracts recorded Tibber updates from a Homey app log into a JSONL file.
 *
 *   homey app run | tee run.log            (with "Record raw data" enabled on the device)
 *   node tools/extract-recording.js run.log > test/fixtures/my-day.jsonl
 *
 * Reads stdin when no file is given.
 */

const fs = require('fs');

const MARK = '[REC] ';

function extract(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(MARK);
    if (i === -1) continue;
    try {
      out.push(JSON.stringify(JSON.parse(line.slice(i + MARK.length))));
    } catch (err) { /* truncated/garbled line: skip */ }
  }
  return out;
}

if (require.main === module) {
  const file = process.argv[2];
  const text = fs.readFileSync(file || 0, 'utf8');
  const lines = extract(text);
  process.stdout.write(lines.join('\n') + (lines.length ? '\n' : ''));
  process.stderr.write(`${lines.length} records\n`);
}

module.exports = { extract };
