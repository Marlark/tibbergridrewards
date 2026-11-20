'use strict';

/**
 * One login and one WebSocket per Tibber account (e-mail), shared by all of the
 * account's home devices. Each home gets its own subscription on that socket.
 * The connection is stopped when its last home is released.
 */

const { TibberAppClient } = require('./TibberAppClient');
const GridRewardSubscription = require('./GridRewardSubscription');

const pools = new WeakMap(); // homey -> ConnectionPool

const accountKey = (email) => String(email || '').trim().toLowerCase();

class ConnectionPool {
  /** The pool for this Homey (one per app instance). */
  static for(homey) {
    if (!pools.has(homey)) pools.set(homey, new ConnectionPool(homey));
    return pools.get(homey);
  }

  constructor(homey) {
    this.homey = homey;
    this.accounts = new Map(); // key -> { key, client, sub, homes: Set }
  }

  /**
   * Join the account's connection with a home. Returns { key, client, sub }.
   * With a different password than the shared client has, the newest one is used:
   * it comes from a device that was just paired or repaired.
   */
  acquire({
    email, password, homeId, log = () => {},
  }) {
    const key = accountKey(email);
    let account = this.accounts.get(key);
    if (!account) {
      const client = new TibberAppClient({ email, password, log });
      const sub = new GridRewardSubscription({ client, homey: this.homey, log });
      account = {
        key, client, sub, homes: new Set(),
      };
      this.accounts.set(key, account);
    } else if (account.client.password !== password) {
      account.client.password = password;
      account.client._token = null; // log in again with the new password
    }
    account.homes.add(homeId);
    account.sub.addHome(homeId);
    if (account.sub._stopped) account.sub.start();
    return account;
  }

  /** Leave the account's connection; the last home to leave stops it. */
  release(key, homeId) {
    const account = this.accounts.get(key);
    if (!account) return;
    account.homes.delete(homeId);
    account.sub.removeHome(homeId);
    if (account.homes.size === 0) {
      account.sub.stop();
      this.accounts.delete(key);
    }
  }
}

module.exports = ConnectionPool;
module.exports.accountKey = accountKey;
