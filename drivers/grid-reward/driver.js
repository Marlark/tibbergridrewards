'use strict';

const Homey = require('homey');
const { TibberAppClient, TibberAuthError } = require('../../lib/TibberAppClient');
const { crossed } = require('../../lib/unavailable');
const { accountKey } = require('../../lib/ConnectionPool');

/** Returns a logged-in client, or null on wrong credentials. Other errors are thrown. */
async function tryLogin(email, password, log) {
  const client = new TibberAppClient({ email, password, log });
  try {
    await client.getToken();
  } catch (err) {
    if (err instanceof TibberAuthError) return null;
    throw err;
  }
  return client;
}

class GridRewardDriver extends Homey.Driver {

  async onInit() {
    this.homey.flow.getConditionCard('is_delivering')
      .registerRunListener(async ({ device }) => device.getCapabilityValue('grid_reward_active') === true);
    this.homey.flow.getConditionCard('state_is')
      .registerRunListener(async ({ device, state }) => device.getCapabilityValue('grid_reward_state') === state);
    // The device triggers every minute while unavailable; each flow runs once, when its hours pass.
    this.homey.flow.getDeviceTriggerCard('unavailable_for')
      .registerRunListener(async (args, state) => crossed(state, args.hours));

    // Thresholds: the device triggers whenever the amount grows ({from, to}); a flow
    // runs when its amount lies in between, i.e. once per day/month.
    const passed = async (args, state) => state.from < args.amount && args.amount <= state.to;
    this.homey.flow.getDeviceTriggerCard('reward_today_passed').registerRunListener(passed);
    this.homey.flow.getDeviceTriggerCard('reward_month_passed').registerRunListener(passed);
    this.homey.flow.getConditionCard('reward_today_above')
      .registerRunListener(async ({ device, amount }) => (device.getCapabilityValue('grid_reward_today') || 0) > amount);
  }

  async onPair(session) {
    let client = null;
    let creds = null;

    // Template "login_credentials" sends { username, password }
    session.setHandler('login', async ({ username, password }) => {
      client = await tryLogin(username, password, this.log.bind(this));
      if (!client) return false; // shows "wrong credentials"
      creds = { email: username, password };
      return true;
    });

    session.setHandler('list_devices', async () => {
      const homes = await client.getHomes();
      return homes.map((home) => ({
        name: `Grid Rewards – ${home.title || home.id}`,
        data: { id: home.id },
        store: { ...creds },
      }));
    });
  }

  async onRepair(session, device) {
    session.setHandler('login', async ({ username, password }) => {
      const client = await tryLogin(username, password, this.log.bind(this));
      if (!client) return false;
      // The new account must still have access to this device's home.
      const homes = await client.getHomes();
      if (!homes.some((h) => h.id === device.getData().id)) {
        throw new Error(this.homey.__('error.home_missing'));
      }
      // Other homes on the same account share its login: give them the new
      // credentials too, if the account still has access to them.
      const oldKey = accountKey(device.getStore().email); // before it is updated
      await device.updateCredentials({ email: username, password });
      const homeIds = new Set(homes.map((h) => h.id));
      for (const other of this.getDevices()) {
        if (other === device || accountKey(other.getStore().email) !== oldKey) continue;
        if (!homeIds.has(other.getData().id)) continue;
        await other.updateCredentials({ email: username, password }).catch(this.error);
      }
      return true;
    });
  }

}

module.exports = GridRewardDriver;
