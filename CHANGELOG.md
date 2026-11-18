# Changelog

All notable changes to this app are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the app uses [Semantic Versioning](https://semver.org/).

## [0.1.1] – unreleased

### Changed

- The developer setting *Record raw data* is removed. Raw Tibber updates are now only recorded during `homey app run`, never in a published app.

## [0.1.0] – unreleased

First version.

### Added

- Real-time Grid Rewards status per Tibber home via the GraphQL subscription `gridRewardStatus`.
- Capabilities with Insights: status, session active, reason, current session, reward today, this month and all time.
- Flow cards: *status changed*, *session started*, *session ended* (reward and duration) and the condition *a session is / is not active*.
- Pairing with Tibber e-mail and password, one device per home.
- Repair flow for entering new credentials. The app checks that the account still has access to the device's home.
- Day and session counters stored per device. Day rollover uses Homey's time zone and works even if Homey was off at midnight.
- Month rollover detection that tells a new month apart from a downward correction, and still detects a late reset from Tibber.
- Reconnects with exponential backoff (5 s → 5 min), a client ping every minute and a 3-minute watchdog.
- Login is retried only every 6 hours after a wrong password, to avoid locking the Tibber account.
- Developer setting *Record raw data*, plus `tools/extract-recording.js` and `tools/replay.js` for replaying real Tibber data through the app logic. The extractor reads logs saved by Windows PowerShell (UTF-16).
- *Session ended* waits for Tibber’s settlement of the last quarter (at most 3 min), so the reward is complete. Verified against a real 23-hour recording (`test/fixtures/real-2026-11-17.jsonl`, anonymised).
- Car and battery as separate devices (status, reason, plugged in, smart control), fed by the home device. Flow cards: status changed, car plugged in/unplugged; conditions: car plugged in, Grid Rewards available.
- Daily summary Flow card at midnight: reward, number of sessions, delivery time and date.
- Translated reasons (English and Swedish) and a stable *reason code* token for flows.
- Detection of API changes from Tibber: the device becomes unavailable with a message, one notification is sent, and the app retries every hour. A rejected subscription now always leads to a reconnect.
- Statistics: last session, sessions and delivery time today, sessions this month (with Insights). Existing devices get the new capabilities automatically.
- Home battery details, polled every 5 minutes with the same query as the HA integration: savings today/week/month, current activity, next planned charge/discharge, and a Flow card when the activity changes.
- Dashboard widget showing status, today, month, session, statistics and battery.
- `tools/inspect-login.js` shows what Tibber's login returns (field names and token lifetime, never values).
- `compatibility` raised to `>=12.3.0` (required for the widget; the code also needs Node 18+).
- Flow card *unavailable for X hours* (home and car/battery), runs once per period; condition *status is …* with a dropdown.
- Session history: the last 100 sessions per home with reason, and totals per day, on the app's settings page.
- Connection status, last update, connected since and reconnects in the home device's settings.
- Flow cards *reward today / this month passed X* (once per day/month) and condition *reward today is above X*.
- Monthly summary Flow card when a new month starts: reward, sessions, delivery time, month.
- When the home is unavailable, the reason from the car/battery (e.g. *No car plugged in*) is shown on the home and in the widget.
- Currency from Tibber (kr / €) on all money values, battery savings, widget and history.
- Fewer writes to Homey: values and stored state are only written when they change. On a real day the home device went from 1 502 to 404 capability writes and from 209 to 95 store writes.
- Tests for the device and driver with a stub of the `homey` module, and GitHub Actions CI running the tests and `homey app validate`.
- Original icon and images.
- Translations: English, Swedish, Norwegian, Danish, German and Dutch. Dates and times follow Homey's language.
