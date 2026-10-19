# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Fixed

- Alarm scene trigger lost when the zone is unknown: the SDK refuses an
  undefined value, so `alarm_triggered` now sends `zone: null`, and every
  scene event turns an undefined, non-finite or non-primitive value into
  null.

## [0.1.1] - 2026-10-18

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

### Fixed

- "Test the connection" could bring back an option switched off since the
  start: it now reads the configuration from Gladys, and the options apply
  at once when saved.
- A door given another address or output in the intercom is refused with
  "scan again", nothing written, and the doors are read again.
- An alarm command is confirmed only by a state read that changed and shows
  the result (a disarm also needs no alarm nor delay running); a 200 of the
  older Vedo firmware no longer counts as a success by itself.
- A 401 or 403 answer to the PIN is a refused PIN (stop, no new try).
- A door opening is always reported "sent, without confirmation".
- "Close everything": commands of one type share a status read made after
  they arrived, and the bridge calls no longer wait 250 ms (only the Vedo
  ones): eight shutters closed at once all leave in time.
- The arm P1 button only shows on areas with a P1; opening or closing a
  shutter is refused while a stop is not seen yet; every refused command is
  logged; at most 10 cookies are kept; a stop is noted at once.
- Docs: the "plugs" are every "other" object of the bridge and obey the
  "turn everything off"; the session cookie travels in clear too; the
  manifest description names the intercom doors.
- Door devices are keyed by the target they open (address and output of the
  intercom book): a slot given to another door is a new device, the old one
  opens nothing.
- A shutter stop is always decided on a read of its own made right before
  (a shutter at its end gets no reverse command); a shared read is used at
  most 1 s old.
- A start waiting behind a newer configuration uses the newer one; "Test the
  connection" refuses an empty configuration; the alarm state is read every
  500 ms until 4.5 s to confirm a command; arm P1 is refused on an area
  without P1.
- One read back pending per object type: a burst of commands ("turn
  everything off" after "close everything") no longer fills the queue of the
  bridge with reads, every command leaves in time.
- The queue of the alarm is freed once a command is sent; its confirmation
  reads no longer delay the next alarm command.
- "Test the connection" on an empty configuration only fails, without
  changing the connection status.

[Unreleased]: https://github.com/LM1LC3N7/gladys-comelit/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-comelit/releases/tag/v0.1.1
