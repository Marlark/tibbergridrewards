# Changelog

All notable changes to this app are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the app uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- The app settings page shows each battery's planned charge level as a curve, with planned charging and discharging per quarter, until the end of tomorrow (Tibber's forecast, updated every 5 minutes).
- Dashboard widget *Grid Rewards – battery plan* with the same curve and the current charge level.
- What the car and the battery have earned: *Earned today*, *this month* and *in total* on each car/battery device, live during a session, and the flow card *A Grid Rewards session ended* with the device's share. Tibber only reports the home's total, so each session is credited to the device that delivered during it (split evenly if both did). On a real day: battery 14.91 kr + car 1.73 kr = the home's 16.64 kr.
- On the car and the battery: sessions and delivery time today and this month, and its share (%) of what the cars and batteries earned this month.
- *Available today* (%) on the home, the car and the battery: the part of the day it was available for Grid Rewards or delivering, logged to Insights. Only time Homey actually observed counts.
- Records: best day, best session and longest session, for the home and for each car and battery, with the flow card *A new record was set*. Existing history gives the starting records, so updating does not fire the card.
- The history page shows which car or battery delivered in each session, with a filter per device, and the records. The CSV export of sessions has a *Device* column.
- Cars and batteries get their own icon when they are added (devices added earlier keep theirs).
- Export of the sessions or the daily totals as CSV from the app settings page, to download or copy. English uses commas and a decimal point; the other languages use semicolons and a decimal comma, as spreadsheets in those countries expect.

## [0.2.0] – 2026-11-20

### Changed

- Homes on the same Tibber account share one login and one WebSocket (a subscription per home) instead of one each. Repairing one home also gives the others on the account the new password.
- Battery details are fetched about 10 seconds after a Grid Rewards status change (at most once a minute), instead of waiting up to 5 minutes. The battery's activity now follows a session straight away.
- A battery warning is only shown after three failed polls in a row (about 15 minutes). Short outages at Tibber ("Circuit breaker open") are logged but no longer flash a warning. A changed API is still shown at once.

### Added

- Translations for more battery activities seen on a real battery: charging at a low price, discharging at a high price, and discharging before expected solar power.
- Flow cards *smart control was turned off* and *turned on or off*, and the condition *smart control is on*, for car and battery.
- Dashboard widget *Grid Rewards – last 7 days* with a bar per day.
- Daily totals are saved per home (about a year).

### Fixed

- The session history is kept per Tibber home in the app settings, so it survives removing and adding the home device. History from older versions is moved automatically.

## [0.1.1] – 2026-11-18

### Changed

- The developer setting *Record raw data* is removed. Raw Tibber updates are now only recorded during `homey app run`, never in a published app.

## [0.1.0] – 2026-11-18

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
