#!/usr/bin/env node
'use strict';

/**
 * Extracts recorded Tibber updates from a Homey app log into a JSONL file.
 *
 *   homey app run | tee run.log            (with "Record raw data" enabled on the device)
 *   node tools/extract-recording.js run.log > test/fixtures/my-day.jsonl
 *   node tools/extract-recording.js --battery run.log > battery.jsonl   (battery responses)
 *
 * Reads stdin when no file is given.
 */

const fs = require('fs');

const MARK = '[REC] ';
const BATTERY_MARK = '[REC-BATTERY] ';

/** Decode a log file: Windows PowerShell's `tee` writes UTF-16LE with a BOM. */
function decode(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').slice(1);
  if (buf[0] === 0xfe && buf[1] === 0xff) return buf.swap16().toString('utf16le').slice(1);
  return buf.toString('utf8').replace(/^﻿/, '');
}

function extract(text, mark = MARK) {
  const out = [];
  // Strip ANSI colour codes from homey CLI output
  const clean = text.replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex
  for (const line of clean.split(/\r?\n/)) {
    const i = line.indexOf(mark);
    if (i === -1) continue;
    try {
      out.push(JSON.stringify(JSON.parse(line.slice(i + mark.length))));
    } catch (err) { /* truncated/garbled line: skip */ }
  }
  return out;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const battery = args.includes('--battery');
  const file = args.find((a) => a !== '--battery');
  const text = decode(fs.readFileSync(file || 0));
  const lines = extract(text, battery ? BATTERY_MARK : MARK);
  process.stdout.write(lines.join('\n') + (lines.length ? '\n' : ''));
  process.stderr.write(`${lines.length} records\n`);
}

module.exports = {
  extract, decode, MARK, BATTERY_MARK,
};
