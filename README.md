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
        │
        ▼  flexDevices in the same update
FlexDevice (car / battery) ── no login of its own
```

One device per Tibber home. The credentials are stored in the device's store. Cars and batteries can be added as separate devices; they are fed by their home device, so they need no login and no extra API calls.

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
| `grid_reward_last_session` | kr, last finished session | ✔ |
| `grid_reward_sessions_today` | sessions today | ✔ |
| `grid_reward_minutes_today` | min delivered today | ✔ |
| `grid_reward_sessions_month` | sessions this calendar month | ✔ |

Because the values are logged to Insights, daily energy reports can read the Grid Rewards income straight from Homey.

**Car / battery devices** have `grid_reward_state`, `grid_reward_reason`, `flex_smart_enabled` (smart charging / smart mode on) and, for cars, `flex_plugged_in`. **Batteries** also poll Tibber every 5 minutes for `battery_savings_today` / `_week` / `_month` (kr, Insights), `battery_activity` (what the battery is doing now) and `battery_next_activity` (next planned charge/discharge). The query is the same as in the HA integration. A failed poll shows a warning on the battery but does not make it unavailable.

**Reasons** are translated (English and Swedish). Codes seen in real data: `available`, `excess`, `shortage`, `other` and, for the car, `noVehiclesPluggedIn`. Unknown codes are shown as they are; add them under `reason` in `locales/*.json`. When the home is unavailable, the reasons of its unavailable car/battery are shown on the home too (e.g. *No car plugged in*).

**Currency** follows Tibber's `rewardCurrency`: SEK, NOK and DKK are shown as *kr*, EUR as *€* (capabilities, battery savings, widget and history).

## Flow cards

**Home**

- **When:** status changed (tokens: status, reason, reason code) · session started (reason, reason code) · session ended (reward, duration in min) · daily summary at midnight (reward, sessions, delivery time in min, date) · monthly summary when a new month starts (reward, sessions, delivery time, month) · reward today / this month passed *X* · unavailable for *X* hours (hours, reason, reason code)
- **And:** a Grid Rewards session is / is not active · the status is / is not *available / unavailable / delivering / unknown* · reward today is / is not above *X*

**Car / battery**

- **When:** status changed (status, reason, reason code) · the car was plugged in or unplugged · the battery activity changed (activity, activity code) · unavailable for *X* hours (e.g. the car has not been plugged in)
- **And:** the car is / is not plugged in · Grid Rewards is / is not available · the status is / is not …

Use the *reason code* token for conditions in flows; it does not change with the language.

*Unavailable for X hours* runs once per unavailable period, when the chosen time has passed (checked every minute). Time while the app was stopped does not make it fire afterwards. *Reward passed X* runs once per day (today) or month (this month) when the amount is passed; a small dip and rise does not run it twice.

## Dashboard widget

*Grid Rewards* shows status and reason, reward today and this month, the current or last session, sessions and delivery time today, and the battery's activity and savings if the home has one. Choose the home when you add the widget. It refreshes every 30 seconds and follows the dashboard's light/dark theme. Requires Homey 12.3 or later (the app's `compatibility` is `>=12.3.0`).

## Session history

The app's settings page (*Settings → Apps → Tibber Grid Rewards*) lists the last 100 finished sessions per home (time, reward, duration, reason) and totals per day.

## Connection status

The home device's settings show the connection (connected / reconnecting / login failed / API changed), the last update from Tibber, connected since and the number of reconnects since the app started.

## Pairing and repair

- **Pairing:** log in with your Tibber e-mail and password, then pick the home(s) to add.
- **Repair:** if the password changes, repair the device and enter the new credentials. The app checks that the account still has access to the device's home.
- **Car / battery:** add the home device first. Then add *Car / battery (Grid Rewards)*; it lists what the home device has received from Tibber.

## Improvements over the HA integration

- Day and session counters are stored **per device (home)**. The HA version shares them between homes and accounts.
- The day rollover is based on the last known month value, so it is correct even if Homey was off at midnight. The time zone comes from Homey's clock.
- A downward correction from Tibber within the month is not mistaken for a new month, and a late month reset is still detected.
- Reconnects with exponential backoff (5 s → 5 min). The app pings the server every minute and reconnects if nothing has been received for 3 min.
- With a wrong password, login is retried only every 6 hours (to avoid locking the account). Repair the device to enter a new password.
- Updates are processed one at a time per device, so Flow cards are never triggered twice.
- If Tibber changes its API (the query no longer fits the schema, or the login endpoint is gone), the device becomes unavailable with a clear message, you get one notification, and the app retries every hour instead of failing silently.
- *Session ended* waits for Tibber to settle the last quarter (about 40 s after the session ends, at most 3 min), so the reward includes it. In real data this added 0.46 kr to 16.19 kr over 9 sessions.

## Getting started

```bash
npm install          # installs ws
npm test             # runs all tests (no Homey or Tibber account needed)
homey app run        # runs the app on your Homey during development
```

The tests cover the reward logic, the WebSocket subscription, the home and car/battery devices and drivers (with a stub of the `homey` module in `test/helpers/`), and replay recorded data. GitHub Actions ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the tests and `homey app validate --level publish` on every push.

## Recording real data

1. In the device settings, turn on **Developer → Record raw data**.
2. Run the app and save the log: `homey app run | tee run.log`
3. Extract the recording: `node tools/extract-recording.js run.log > test/fixtures/my-day.jsonl`
4. Look at it: `node tools/replay.js test/fixtures/my-day.jsonl` prints every update with today, session and events, and lists impossible values.

Every `.jsonl` file in `test/fixtures/` is replayed by `npm test`. The recording contains your home id, so check it before you commit it.

## To do before it is "real"

- [ ] Review the icon and images (generated, original design – not Tibber's logo).
- [ ] Try the car/battery devices, the battery details, the widget and the daily summary on a real Homey. Record a battery response and add translations for the activity codes Tibber sends (`battery_activity` in `locales/*.json`; unknown codes are logged and shown in readable English).

More ideas are collected in [Docs/IDEBANK.md](Docs/IDEBANK.md) (in Swedish).

## Risks

- The API is **undocumented** and Tibber can change or shut it down at any time.
- Your real Tibber password is stored on Homey (in the device's store). The Home Assistant integration does the same. Checked with `tools/inspect-login.js`: the login returns a refresh token, but renewing it at Tibber's token endpoint needs the Tibber app's client secret, so the password is still needed to log in again.
- Unofficial project, not approved by Tibber.

## License

[MIT](LICENSE). The license covers this code only; it gives no rights to Tibber's API, name or brand.
