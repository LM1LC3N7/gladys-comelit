# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Local connection to a Comelit SimpleHome Serial Bridge over HTTP, with the
  protocol of aiocomelit 3.0.0: login with the bridge PIN, lights, plugs,
  shutters (as `shutter`, never a switch) and thermostats (temperature and
  setpoint), read at an interval (10 s by default).
- The Vedo alarm, through the bridge or on a Vedo IP of its own: one device
  per area (state, alarm, tamper, arm total / partial P1 / partial P1 + P2 and
  disarm buttons) and per zone (open, alarm, excluded, tamper; kind set in
  the configuration). The new Vedo firmware (actions by POST) is detected.
- Intercom doors through the Comelit intercom bridge (ICONA protocol, port
  64100, ported from comelit-client 3.0.0): one "Open" button per door of
  its address book.
- Scene triggers `alarm_triggered`, `armed`, `disarmed` (Gladys 5.1.0 or
  later).
- "Test the connection" button.
- Docs in French and English, cover image.

### Security

- Arming, disarming, setting a setpoint and opening a door are four options,
  all off by default; each is checked when the command arrives, in the
  queue, after the fresh read and right before the write.
- Alarm, setpoint and shutter-stop commands are decided on the state read
  from the bridge right before them; one command at a time per host; never
  sent after 3.5 s; anything after the write without a clear answer is "sent,
  without confirmation" (with a read back, and a guard for the shutter stop
  and the doors), only an HTTP 4xx is a refusal.
- One session per host, one request at a time, growing waits between
  sessions; a refused PIN (bridge, alarm) or token (intercom) stops its
  session with no new try, persisted in `/data` without the secret.
- The PINs and the token are secret fields, never logged; the answers of the
  bridge and of the intercom are bounded and parsed without prototype keys.

[Unreleased]: https://github.com/LM1LC3N7/gladys-comelit/commits/main
