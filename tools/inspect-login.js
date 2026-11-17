#!/usr/bin/env node
'use strict';

/**
 * can the app avoid storing the Tibber password?
 *
 * Logs in once and prints WHAT the login response contains (field names, the
 * token's lifetime, whether anything looks like a refresh token), never the
 * values themselves.
 *
 *   node tools/inspect-login.js
 *
 * Asks for e-mail and password (the password is not echoed). Nothing is saved.
 */

const readline = require('readline');

const AUTH_URL = 'https://app.tibber.com/v1/login.credentials';

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // eslint-disable-next-line no-underscore-dangle
      rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

/** Describe a value without revealing it. */
function shape(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'object') return `{ ${Object.keys(value).join(', ')} }`;
  if (typeof value === 'string') return `string(${value.length})`;
  return typeof value;
}

function decodeJwt(token) {
  try {
    const [h, p] = token.split('.');
    const dec = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    return { header: dec(h), payload: dec(p) };
  } catch (err) {
    return null;
  }
}

function duration(seconds) {
  if (seconds >= 86400) return `${(seconds / 86400).toFixed(1)} days`;
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)} hours`;
  return `${Math.round(seconds / 60)} minutes`;
}

async function main() {
  const email = process.env.TIBBER_EMAIL || await ask('Tibber e-mail: ');
  const password = process.env.TIBBER_PASSWORD || await ask('Tibber password (hidden): ', { hidden: true });

  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(10000),
  });
  console.log(`\nHTTP ${res.status}`);
  const cookies = res.headers.get('set-cookie');
  console.log(`Set-Cookie header: ${cookies ? `yes (${cookies.split(/,(?=[^ ])/).map((c) => c.split('=')[0].trim()).join(', ')})` : 'no'}`);
  if (!res.ok) return;

  const body = await res.json();
  console.log('\nResponse fields (values hidden):');
  for (const [k, v] of Object.entries(body)) console.log(`  ${k}: ${shape(v)}`);

  const refreshLike = Object.keys(body).filter((k) => /refresh|renew|long/i.test(k));
  console.log(`\nRefresh-like fields: ${refreshLike.length ? refreshLike.join(', ') : 'none'}`);

  const jwt = typeof body.token === 'string' ? decodeJwt(body.token) : null;
  if (!jwt) {
    console.log('Token: not a readable JWT');
    return;
  }
  const { iat, exp } = jwt.payload;
  console.log(`\nToken: JWT, alg ${jwt.header.alg}, payload fields: ${Object.keys(jwt.payload).join(', ')}`);
  // Claims that describe the login system, not the user (sub/sid/subHash are left out).
  for (const k of ['iss', 'aud', 'client_id', 'scope', 'scopes', 'amr', 'idp']) {
    if (k in jwt.payload) console.log(`  ${k}: ${JSON.stringify(jwt.payload[k])}`);
  }
  const life = typeof exp === 'number' ? (typeof iat === 'number' ? exp - iat : exp - Date.now() / 1000) : null;
  if (life !== null) console.log(`Token lifetime: ${duration(life)} (expires ${new Date(exp * 1000).toISOString()})`);

  if (typeof body.refreshToken !== 'string') {
    console.log(life !== null && life >= 30 * 86400
      ? '\n=> No refresh token, but the token is long-lived: storing only the token looks feasible.'
      : '\n=> No refresh token and a short-lived token: the app has to keep the password.');
    return;
  }

  console.log('\nA refresh token is present. Looking for how to use it...');
  await tryRefresh(jwt.payload, body.refreshToken);
}

/** Find the token endpoint via OpenID Connect discovery and try one refresh. */
async function tryRefresh(claims, refreshToken) {
  if (!claims.iss) {
    console.log('=> No issuer (iss) in the token: cannot discover the refresh endpoint.');
    return;
  }
  const discoveryUrl = `${String(claims.iss).replace(/\/$/, '')}/.well-known/openid-configuration`;
  let config;
  try {
    const res = await fetch(discoveryUrl, { signal: AbortSignal.timeout(10000) });
    console.log(`Discovery ${discoveryUrl}: HTTP ${res.status}`);
    if (!res.ok) return;
    config = await res.json();
  } catch (err) {
    console.log(`Discovery failed: ${err.message}`);
    return;
  }
  console.log(`  token_endpoint: ${config.token_endpoint}`);
  console.log(`  grant_types_supported: ${JSON.stringify(config.grant_types_supported)}`);
  if (!config.token_endpoint) return;

  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
  if (claims.client_id) form.set('client_id', String(claims.client_id));
  const res = await fetch(config.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.timeout(10000),
  });
  let out = {};
  try {
    out = await res.json();
  } catch (err) { /* not JSON */ }
  console.log(`\nRefresh attempt: HTTP ${res.status}`);
  if (!res.ok) {
    // OAuth error codes are safe to show, e.g. invalid_client / invalid_grant
    console.log(`  error: ${out.error || '-'}  ${out.error_description || ''}`);
    console.log('=> Refresh did not work this way. The app has to keep the password for now.');
    return;
  }
  console.log('Response fields (values hidden):');
  for (const [k, v] of Object.entries(out)) console.log(`  ${k}: ${shape(v)}`);
  const newJwt = typeof out.access_token === 'string' ? decodeJwt(out.access_token) : null;
  if (newJwt && typeof newJwt.payload.exp === 'number') {
    console.log(`New token lifetime: ${duration(newJwt.payload.exp - (newJwt.payload.iat || Date.now() / 1000))}`);
  }
  if (typeof out.refresh_token === 'string') {
    console.log(`Refresh token rotated: ${out.refresh_token !== refreshToken ? 'yes (a new one each time)' : 'no (same one)'}`);
  }
  console.log('=> Refresh works: the app can store the refresh token instead of the password.');
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
});
