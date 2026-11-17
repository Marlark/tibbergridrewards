# Changelog

All notable changes to this app are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the app uses [Semantic Versioning](https://semver.org/).

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
- Tests for the device and driver with a stub of the `homey` module, and GitHub Actions CI running the tests and `homey app validate`.
- Original icon and images.
- English and Swedish translations.
