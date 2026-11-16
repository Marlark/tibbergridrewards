'use strict';

const Homey = require('homey');
const { TibberAppClient, TibberAuthError } = require('../../lib/TibberAppClient');

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
      await device.updateCredentials({ email: username, password });
      return true;
    });
  }

}

module.exports = GridRewardDriver;
