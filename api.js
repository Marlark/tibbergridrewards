'use strict';

/**
 * App API, used by the settings page (settings/index.html).
 * Homey treats every function exported here as an endpoint, so each one needs an
 * entry under "api" in .homeycompose/app.json. Helpers belong in lib/.
 */

const history = require('./lib/history');

module.exports = {
  async getHistory({ homey }) {
    return history.getHistory({ homey });
  },
};
