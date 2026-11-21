'use strict';

/**
 * Data for the Grid Rewards dashboard widget. Returns the values of one home
 * device (the one chosen when the widget was added, else the first one) and,
 * if there is one, the battery of the same home. Texts are translated here so
 * the widget page itself needs no locale files.
 */

const { homesOf, flexDevicesOf } = require('../../lib/devices');

const cap = (device, id) => (device.hasCapability(id) ? device.getCapabilityValue(id) : null);

async function getStatus({ homey, query = {} }) {
  const homes = homesOf(homey);
  const home = homes.find((d) => d.getId && d.getId() === query.deviceId) || homes[0];
  if (!home) return { error: homey.__('error.no_home_device') };

  const state = cap(home, 'grid_reward_state') || 'unknown';
  const battery = flexDevicesOf(homey, home.getData().id).find((d) => d.getData().kind === 'battery');

  return {
    name: home.getName ? home.getName() : '',
    unit: home.getCurrencyUnit ? home.getCurrencyUnit() : 'kr',
    available: home.getAvailable ? home.getAvailable() : true,
    state,
    stateText: homey.__(`widget.state.${state}`),
    reason: cap(home, 'grid_reward_reason'),
    active: cap(home, 'grid_reward_active') === true,
    today: cap(home, 'grid_reward_today'),
    month: cap(home, 'grid_reward_month'),
    session: cap(home, 'grid_reward_session'),
    estimate: cap(home, 'grid_reward_session_estimate'),
    updated: home.getUpdatedTime ? home.getUpdatedTime() : null,
    lastSession: cap(home, 'grid_reward_last_session'),
    sessionsToday: cap(home, 'grid_reward_sessions_today'),
    minutesToday: cap(home, 'grid_reward_minutes_today'),
    battery: battery ? {
      activity: cap(battery, 'battery_activity'),
      savingsToday: cap(battery, 'battery_savings_today'),
    } : null,
    labels: {
      today: homey.__('widget.today'),
      month: homey.__('widget.month'),
      session: homey.__('widget.session'),
      lastSession: homey.__('widget.last_session'),
      sessions: homey.__('widget.sessions'),
      battery: homey.__('widget.battery'),
      savedToday: homey.__('widget.saved_today'),
      unavailable: homey.__('widget.unavailable'),
      updated: homey.__('widget.updated'),
      estimate: homey.__('widget.estimate'),
    },
  };
}

module.exports = { getStatus };
