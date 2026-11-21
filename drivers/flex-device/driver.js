'use strict';

const Homey = require('homey');
const { crossed } = require('../../lib/unavailable');
const { homesOf } = require('../../lib/devices');

// What the car/battery earned, its sessions and its share (shown on both kinds).
const EARNED = [
  'flex_reward_today', 'flex_reward_month', 'flex_reward_total', 'flex_reward_share',
  'grid_reward_sessions_today', 'grid_reward_minutes_today', 'grid_reward_sessions_month', 'grid_reward_availability',
];

/**
 * Cars and batteries (Tibber "flex devices"). They need no login of their own:
 * the Grid Rewards home device receives them in its subscription and forwards
 * every update (see GridRewardDevice._updateFlexDevices).
 */
// The battery's day (#29, #48).
const BATTERY_DAY = [
  'battery_hours_grid_rewards', 'battery_hours_price', 'battery_hours_solar',
  'battery_charged_today', 'battery_discharged_today',
];

class FlexDeviceDriver extends Homey.Driver {

  async onInit() {
    this.homey.flow.getActionCard('flex_charger_reported')
      .registerRunListener(async ({ device, plugged }) => device.onChargerReported(plugged === 'yes'));
    this.homey.flow.getConditionCard('flex_plugged_in')
      .registerRunListener(async ({ device }) => device.getCapabilityValue('flex_plugged_in') === true);
    this.homey.flow.getConditionCard('flex_available')
      .registerRunListener(async ({ device }) => ['available', 'delivering']
        .includes(device.getCapabilityValue('grid_reward_state')));
    this.homey.flow.getConditionCard('flex_smart_is_on')
      .registerRunListener(async ({ device }) => device.getCapabilityValue('flex_smart_enabled') === true);
    this.homey.flow.getConditionCard('flex_state_is')
      .registerRunListener(async ({ device, state }) => device.getCapabilityValue('grid_reward_state') === state);
    this.homey.flow.getDeviceTriggerCard('flex_unavailable_for')
      .registerRunListener(async (args, state) => crossed(state, args.hours));
  }

  async onPairListDevices() {
    const homes = homesOf(this.homey);
    if (!homes.length) throw new Error(this.homey.__('error.no_home_device'));

    const list = [];
    for (const home of homes) {
      for (const f of home.getFlexDevices()) {
        const capabilities = f.kind === 'vehicle'
          ? ['grid_reward_state', 'grid_reward_reason', ...EARNED, 'flex_plugged_in', 'flex_smart_enabled']
          : ['grid_reward_state', 'grid_reward_reason', ...EARNED, 'flex_smart_enabled',
            'battery_savings_today', 'battery_savings_week', 'battery_savings_month',
            'battery_activity', 'battery_next_activity', ...BATTERY_DAY];
        list.push({
          name: f.name && f.make && f.name !== f.make ? `${f.name} (${f.make})` : (f.name || f.make || f.kind),
          data: { id: f.id, homeId: home.getData().id, kind: f.kind },
          capabilities,
          // Its own icon, so the car and the battery are easy to tell apart (#71).
          icon: f.kind === 'vehicle' ? '/vehicle.svg' : '/battery.svg',
        });
      }
    }
    if (!list.length) throw new Error(this.homey.__('error.no_flex_devices'));
    return list;
  }

}

module.exports = FlexDeviceDriver;
