'use strict';

const { EventEmitter } = require('events');
const WebSocket = require('ws');
const {
  GRAPHQL_WS_URL, GRID_REWARD_SUBSCRIPTION, TibberAuthError, TibberApiChangedError, graphqlError,
} = require('./TibberAppClient');

const AUTH_RETRY_MS = 6 * 60 * 60 * 1000; // 6 h
const API_CHANGED_RETRY_MS = 60 * 60 * 1000; // 1 h: no point hammering a changed API
const PING_MS = 60 * 1000; // client keep-alive ping
const WATCHDOG_MS = 3 * 60 * 1000; // no traffic (not even pong) for this long = dead

/**
 * Keeps a graphql-transport-ws subscription to gridRewardStatus for one home.
 * Emits: 'data' (gridRewardStatus object), 'connected', 'disconnected', 'error'.
 *
 * Unlike the HA integration (fixed 5 s retry), this one backs off
 * exponentially, from 5 s up to 5 min.
 */
/**
 * One log line on why the server closed the connection, e.g.
 * "Connection closed by server: 1000 normal closure, after 62 min".
 * Codes: https://www.rfc-editor.org/rfc/rfc6455#section-7.4.1 and graphql-transport-ws (44xx).
 */
const CLOSE_CODES = {
  1000: 'normal closure',
  1001: 'server going away',
  1005: 'no status code',
  1006: 'lost without close frame',
  1011: 'server error',
  1012: 'server restarting',
  1013: 'try again later',
  4400: 'bad request',
  4401: 'unauthorized (token expired?)',
  4403: 'forbidden',
  4408: 'connection init timeout',
  4409: 'subscriber already exists',
  4429: 'too many requests',
  4500: 'internal server error',
};

function describeClose(code, reason, connectedAt, now = Date.now()) {
  const text = reason && reason.length ? `, "${String(reason).slice(0, 200)}"` : '';
  const known = CLOSE_CODES[code] ? ` ${CLOSE_CODES[code]}` : '';
  const after = connectedAt ? `, after ${Math.round((now - connectedAt) / 60000)} min` : ', before it was ready';
  return `Connection closed: ${code}${known}${text}${after}`;
}

class GridRewardSubscription extends EventEmitter {
  constructor({ client, homeId, homey, log = () => {} }) {
    super();
    this.client = client;
    this.homeId = homeId;
    this.homey = homey; // for setTimeout/clearTimeout that are cleaned up on app stop
    this.log = log;
    this._ws = null;
    this._stopped = true;
    this._retryMs = 5000;
    this._retryTimer = null;
    this._watchdog = null;
    this._pinger = null;
    this._apiChanged = false;
  }

  start() {
    this._stopped = false;
    this._connect();
  }

  stop() {
    this._stopped = true;
    if (this._retryTimer) this.homey.clearTimeout(this._retryTimer);
    if (this._watchdog) this.homey.clearTimeout(this._watchdog);
    this._stopPinger();
    if (this._ws) {
      try {
        this._ws.close();
      } catch (err) { /* ignore */ }
    }
    this._ws = null;
  }

  async _connect() {
    if (this._stopped) return;
    let token;
    try {
      token = await this.client.getToken();
    } catch (err) {
      if (this._stopped) return;
      this.emit('error', err);
      // Wrong credentials: don't hammer the login endpoint (account lockout risk).
      // Retry rarely in case it was a transient error; repair/restart retries at once.
      let delay;
      if (err instanceof TibberAuthError) delay = AUTH_RETRY_MS;
      else if (err instanceof TibberApiChangedError) delay = API_CHANGED_RETRY_MS;
      this._scheduleReconnect(delay);
      return;
    }
    // stop() may have been called while we were waiting for the token.
    if (this._stopped) return;

    const ws = new WebSocket(GRAPHQL_WS_URL, 'graphql-transport-ws', {
      headers: { Authorization: `Bearer ${token}` },
    });
    this._ws = ws;

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'connection_init' }));
      this._kickWatchdog();
    });

    ws.on('message', (raw) => {
      this._kickWatchdog();
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        return;
      }
      switch (msg.type) {
        case 'connection_ack':
          this._retryMs = 5000;
          this._connectedAt = Date.now();
          this._startPinger(ws);
          this.emit('connected');
          ws.send(JSON.stringify({
            type: 'subscribe',
            id: `grid-${this.homeId}`,
            payload: {
              operationName: 'gridRewardsSubscription',
              variables: { homeId: this.homeId },
              query: GRID_REWARD_SUBSCRIPTION,
            },
          }));
          break;
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
        case 'next': {
          const payload = msg.payload || {};
          const status = payload.data && payload.data.gridRewardStatus;
          if (status) {
            this._apiChanged = false;
            this.emit('data', status);
          } else if (payload.errors && payload.errors.length) {
            this._failSubscription(ws, payload.errors);
          }
          break;
        }
        case 'error':
          // The server rejected the subscription. The socket stays open (pings
          // still flow), so without closing it we would never get data again.
          this._failSubscription(ws, msg.payload);
          break;
        case 'complete':
          // The server ended the subscription: reconnect.
          ws.close();
          break;
        default:
          break;
      }
    });

    ws.on('error', (err) => this.emit('error', err));

    ws.on('close', (code, reason) => {
      if (this._ws !== ws) return; // an old socket (e.g. after stop/repair)
      this._ws = null;
      this.log(describeClose(code, reason, this._connectedAt));
      this._connectedAt = null;
      this._stopPinger();
      this.emit('disconnected');
      this._scheduleReconnect(this._apiChanged ? API_CHANGED_RETRY_MS : undefined);
    });
  }

  _failSubscription(ws, errors) {
    const err = graphqlError(errors);
    this._apiChanged = err instanceof TibberApiChangedError;
    this.emit('error', err);
    try {
      ws.close();
    } catch (e) { /* close handler reconnects */ }
  }

  // The server is not required to ping, so we ping it ourselves (graphql-transport-ws
  // "ping" -> server must answer "pong"). A quiet but healthy connection therefore
  // still has traffic, and the watchdog only fires when the connection is really dead.
  _startPinger(ws) {
    this._stopPinger();
    this._pinger = this.homey.setInterval(() => {
      try {
        ws.send(JSON.stringify({ type: 'ping' }));
      } catch (err) { /* close handler will reconnect */ }
    }, PING_MS);
  }

  _stopPinger() {
    if (this._pinger) this.homey.clearInterval(this._pinger);
    this._pinger = null;
  }

  _kickWatchdog() {
    if (this._watchdog) this.homey.clearTimeout(this._watchdog);
    this._watchdog = this.homey.setTimeout(() => {
      this.log('Watchdog: no traffic (not even pong), reconnecting');
      if (this._ws) this._ws.terminate();
    }, WATCHDOG_MS);
  }

  _scheduleReconnect(overrideMs) {
    if (this._stopped) return;
    if (this._retryTimer) this.homey.clearTimeout(this._retryTimer);
    let delay = this._retryMs;
    if (overrideMs) {
      delay = overrideMs;
    } else {
      this._retryMs = Math.min(this._retryMs * 2, 5 * 60 * 1000);
    }
    this.log(`Reconnecting in ${Math.round(delay / 1000)} s`);
    this._retryTimer = this.homey.setTimeout(() => this._connect(), delay);
  }
}

module.exports = GridRewardSubscription;
module.exports.describeClose = describeClose;
