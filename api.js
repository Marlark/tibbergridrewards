'use strict';

/**
 * App API, used by the settings page (settings/index.html).
 * Homey treats every function exported here as an endpoint, so each one needs an
 * entry under "api" in .homeycompose/app.json. Helpers belong in lib/.
 */

const history = require('./lib/history');
const csv = require('./lib/csv');

module.exports = {
  async getHistory({ homey }) {
    return history.getHistory({ homey });
  },

  // CSV of the sessions or the daily totals (#10). query.kind: 'sessions' | 'days'
  async getExport({ homey, query = {} }) {
    return csv.exportCsv({ homey, kind: query.kind });
  },
};
