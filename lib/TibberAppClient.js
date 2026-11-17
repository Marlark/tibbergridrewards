'use strict';

/**
 * Minimal client for Tibber's (unofficial) app API, the same one the Tibber
 * mobile app and the HA integration JohNan/homeassistant-tibber_grid_rewards use.
 *
 *  - Login:        POST https://app.tibber.com/v1/login.credentials  {email, password} -> {token}
 *  - GraphQL HTTP: POST https://app.tibber.com/v4/gql                (Bearer token)
 *  - GraphQL WS:   wss://app.tibber.com/v4/gql/ws  subprotocol "graphql-transport-ws"
 *
 * The API is undocumented and can change without notice.
 */

const AUTH_URL = 'https://app.tibber.com/v1/login.credentials';
const GRAPHQL_URL = 'https://app.tibber.com/v4/gql';
const GRAPHQL_WS_URL = 'wss://app.tibber.com/v4/gql/ws';

class TibberAuthError extends Error {}

/** Tibber's API no longer matches what this app asks for (schema changed or endpoint gone). */
class TibberApiChangedError extends Error {}

// GraphQL validation errors: the query no longer fits the schema.
const SCHEMA_ERROR = /cannot query field|unknown (type|argument|fragment|field)|is not defined|must have a selection|is required|of required type|validation/i;

/**
 * Turn a list of GraphQL errors into an Error. Schema/validation errors become
 * TibberApiChangedError, everything else a plain Error.
 */
function graphqlError(errors) {
  const list = Array.isArray(errors) ? errors : [errors];
  const text = list.map((e) => (e && e.message) || JSON.stringify(e)).join('; ');
  const schema = list.some((e) => e && (
    (e.extensions && e.extensions.code === 'GRAPHQL_VALIDATION_FAILED')
    || SCHEMA_ERROR.test(e.message || '')));
  return schema ? new TibberApiChangedError(`API changed: ${text}`) : new Error(`GraphQL: ${text}`);
}

function jwtExp(token) {
  // Read exp from the JWT payload without verifying the signature (just like the HA integration).
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp : 0;
  } catch (err) {
    return 0;
  }
}

class TibberAppClient {
  constructor({ email, password, log = () => {} }) {
    this.email = email;
    this.password = password;
    this.log = log;
    this._token = null;
    this._exp = 0;
  }

  async getToken() {
    const now = Date.now() / 1000;
    if (this._token && this._exp - now > 30) return this._token;

    const res = await fetch(AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: this.email, password: this.password }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new TibberAuthError(`Login failed (${res.status})`);
    }
    if (res.status === 404 || res.status === 410) {
      throw new TibberApiChangedError(`Login endpoint gone (${res.status})`);
    }
    if (!res.ok) throw new Error(`Login HTTP ${res.status}`);

    const data = await res.json();
    if (!data.token) throw new TibberAuthError('No token in login response');
    this._token = data.token;
    this._exp = jwtExp(data.token) || now + 3600;
    return this._token;
  }

  async query(query, variables = {}) {
    const token = await this.getToken();
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
    const body = await res.json();
    if (body.errors && body.errors.length) throw graphqlError(body.errors);
    return body.data;
  }

  async getHomes() {
    const data = await this.query('{ me { homes { id title } } }');
    return (data && data.me && data.me.homes) || [];
  }
}

const GRID_REWARD_SUBSCRIPTION = `
subscription gridRewardsSubscription($homeId: String!) {
  gridRewardStatus(homeId: $homeId) { __typename ...gridReward }
}
fragment gridRewardState on GridRewardState {
  __typename
  ... on GridRewardAvailable { kind }
  ... on GridRewardUnavailable { reasons }
  ... on GridRewardDelivering { reason }
}
fragment gridRewardVehicle on GridRewardVehicle {
  kind vehicleId shortName make isPluggedIn isSmartChargingEnabled
  state { __typename ...gridRewardState }
}
fragment gridRewardBattery on GridRewardBattery {
  kind batteryId shortName make isSmartModeEnabled
  state { __typename ...gridRewardState }
}
fragment gridReward on GridReward {
  homeId
  state { __typename ...gridRewardState }
  rewardCurrency
  rewardCurrentMonth
  rewardAllTime
  flexDevices {
    __typename
    ... on GridRewardVehicle { ...gridRewardVehicle }
    ... on GridRewardBattery { ...gridRewardBattery }
  }
}`;

module.exports = {
  TibberAppClient,
  TibberAuthError,
  TibberApiChangedError,
  graphqlError,
  GRAPHQL_WS_URL,
  GRID_REWARD_SUBSCRIPTION,
};
