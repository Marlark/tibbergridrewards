'use strict';

// Make require('homey') resolve to the stub. Load this before the app code.
const Module = require('module');
const path = require('path');

const stub = path.join(__dirname, 'homey-stub.js');
const orig = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === 'homey') return stub;
  return orig.call(this, request, ...rest);
};
