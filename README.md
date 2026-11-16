# Tibber Grid Rewards for Homey (draft, v0.1)

A Homey app (SDK3) that follows Tibber Grid Rewards in real time. It uses the same unofficial app API as the Home Assistant integration
[JohNan/homeassistant-tibber_grid_rewards](https://github.com/JohNan/homeassistant-tibber_grid_rewards).

> **Unofficial.** This project is not affiliated with or endorsed by Tibber.

## Architecture

```
Tibber login (e-mail + password)
        │  POST app.tibber.com/v1/login.credentials → JWT
        ▼
TibberAppClient ──── GraphQL HTTP (app.tibber.com/v4/gql): list of homes when pairing
        │
GridRewardSubscription ── WSS app.tibber.com/v4/gql/ws (graphql-transport-ws)
        │                  subscription gridRewardStatus(homeId)
        ▼  'data'
GridRewardDevice ── RewardTracker (pure logic, tested)
        │             • today   = month − month value at start of day
        │             • session = month − month value when delivery started
        ▼
Capabilities (with Insights) + Flow cards
```

One device per Tibber home. The credentials are stored in the device's store.

## Capabilities

| Capability | Type | Insights |
|---|---|---|
| `grid_reward_state` | enum: available / unavailable / delivering / unknown | – |
| `grid_reward_active` | boolean (session in progress) | ✔ |
| `grid_reward_reason` | string | – |
| `grid_reward_session` | kr, current session | ✔ |
| `grid_reward_today` | kr today | ✔ |
| `grid_reward_month` | kr this month (directly from Tibber) | ✔ |
| `grid_reward_all_time` | kr all time | ✔ |

Because the values are logged to Insights, daily energy reports can read the Grid Rewards income straight from Homey.

## Flow cards

- **When:** status changed (tokens: status, reason) · session started · session ended (tokens: reward in kr, duration in min)
- **And:** a Grid Rewards session is / is not active

## Pairing and repair

- **Pairing:** log in with your Tibber e-mail and password, then pick the home(s) to add.
- **Repair:** if the password changes, repair the device and enter the new credentials. The app checks that the account still has access to the device's home.

## Improvements over the HA integration

- Day and session counters are stored **per device (home)**. The HA version shares them between homes and accounts.
- The day rollover is based on the last known month value, so it is correct even if Homey was off at midnight. The time zone comes from Homey's clock.
- A downward correction from Tibber within the month is not mistaken for a new month, and a late month reset is still detected.
- Reconnects with exponential backoff (5 s → 5 min). The app pings the server every minute and reconnects if nothing has been received for 3 min.
- With a wrong password, login is retried only every 6 hours (to avoid locking the account). Repair the device to enter a new password.
- Updates are processed one at a time per device, so Flow cards are never triggered twice.

## Getting started

```bash
npm install          # installs ws
npm test             # runs all tests (no Homey or Tibber account needed)
homey app run        # runs the app on your Homey during development
```

The tests cover the reward logic, the WebSocket subscription, the device and the driver (with a stub of the `homey` module in `test/helpers/`), and replay recorded data. GitHub Actions ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the tests and `homey app validate --level publish` on every push.

## Recording real data

1. In the device settings, turn on **Developer → Record raw data**.
2. Run the app and save the log: `homey app run | tee run.log`
3. Extract the recording: `node tools/extract-recording.js run.log > test/fixtures/my-day.jsonl`
4. Look at it: `node tools/replay.js test/fixtures/my-day.jsonl` prints every update with today, session and events, and lists impossible values.

Every `.jsonl` file in `test/fixtures/` is replayed by `npm test`. The recording contains your home id, so check it before you commit it.

## To do before it is "real"

- [ ] Review the icon and images (generated, original design – not Tibber's logo).
- [ ] Verify against real data: which `reason`/`reasons` values Tibber sends, and whether `rewardCurrentMonth` updates continuously during a session.
- [ ] Phase 2: the home battery (savings, activity reason, planned schedule), via the same GraphQL endpoint with 5-minute polling.
- [ ] Phase 2: flexDevices (car/battery) as separate devices.

More ideas are collected in [Docs/IDEBANK.md](Docs/IDEBANK.md) (in Swedish).

## Risks

- The API is **undocumented** and Tibber can change or shut it down at any time.
- Your real Tibber password is stored on Homey (in the device's store).
- Unofficial project, not approved by Tibber.
