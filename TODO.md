# TODO - Comelit (SimpleHome, Vedo, intercom) v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/fr.md`, `docs/en.md`, `CHANGELOG.md` and this file.
- No forum topic of its own, no forum post from a module session: lot 7 was
  claimed in /t/10385 (post #262); the main session posts one recap per wave.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 - core** (2026-10-18): own HTTP client on `node:http`
      ported from aiocomelit 3.0.0 (login, pages, actions, new Vedo
      firmware); Serial Bridge lights, plugs, shutters, thermostats; the Vedo
      through the bridge or a Vedo IP; ICONA door opening ported from
      comelit-client 3.0.0; read-only alarm states and push buttons;
      setpoint, arming, disarming and doors each opt-in; fresh read before
      every alarm / setpoint / stop command, serialized, deadlines inside
      Gladys' 5 s; refused PIN / token stops persisted in `/data`; scene
      triggers `alarm_triggered`, `armed`, `disarmed`; "Test the connection";
      fr/en. Tested against an in-memory bridge and intercom only. Store
      validator: its only error is the `docker_image` not yet pullable from
      GHCR (no release yet).
- [ ] **Milestone 2 - real devices**: run against a real Serial Bridge, a
      Vedo (old and new firmware, through the bridge and IP) and an intercom
      bridge; capture real pages (anonymised) as fixtures; fix what differs
      (see below).
- [ ] **Milestone 3 - more**: thermostat mode (on / off, auto / manual,
      summer / winter) behind the setpoint option; humidity and
      dehumidifiers; irrigation (a valve: off by default, never a switch);
      scenarios as buttons; the power of the `other` objects
      (`counter.json`); zone exclusion (`excl` / `incl`) behind an option;
      intercom actuators (`actuator-address-book`, comelit-client
      `openActuator`); the area of each zone (`in_area`); scene actions arm /
      disarm.
- [ ] **Milestone 4 - first release**: Docker image check, Release workflow,
      topic, GHCR package public.

## To check on a real bridge

- The answer to a wrong PIN: 200 without cookie (aiocomelit's reading), or a
  cookie and a session that never shows, or something else?
- How long a bridge or a Vedo keeps a session; whether `login.json` /
  `area_stat.json` every poll is enough to see an expired one.
- The `logged` field of the Vedo pages through a bridge, and whether
  `vedo_area_stat.json` before the `alm=` login answers 200 with `logged: 0`.
- `action.cgi` answers: 200 always (old firmware)? What a refused or
  impossible arming answers (open zone, anomaly with `force=0`).
- The new firmware: really 404 on every action? Is `area_stat.json` updated
  right after it (the confirmation read relies on it)?
- `zone_desc.json`: `present` a list or a string; what `in_area` holds.
- Shutters: does a command the other way stop a moving shutter (Home
  Assistant relies on it)? Does `icon_status` show 0 once a shutter reaches
  its end?
- Protected objects (`protected: 1`): does `action.cgi` refuse them?
- Thermostats: the setpoint in tenths in `val`, the `O` / `L` / `U` and
  `A` / `M` letters, the bounds the bridge accepts.
- Intercom: the access answer to a wrong token; the first byte of the
  opening frame (comelit-client writes `0x00` / `0x20` without the `0x18` its
  actuator frames carry); whether the configuration `none`, the server info
  and the two answers after each init are needed; the encoding of the door
  names. Kept as comelit-client writes it until a real bridge says
  otherwise (milestone 2).

## Decisions

- **Own clients, no dependency**: no maintained Comelit client on npm under
  a usable licence that covers the Vedo safely; aiocomelit (Apache-2.0) and
  comelit-client (Apache-2.0, intercom part only) are ported and credited in
  `THIRD_PARTY_NOTICES.md` (copied into the image with `LICENSE`). Home
  Assistant's Comelit integration (Apache-2.0) is followed for the arming
  levels and actions (`p1`, `p12`), the thermostat values and the shutter
  stop. Runtime dependency: the SDK only.
- **Version 0.1.0, set by hand once**: the template ships 1.0.0; the
  sibling modules start at 0.1.x, so `package.json`, `package-lock.json`, the
  manifest `version` and the `docker_image` tag were set together to 0.1.0 in
  milestone 1, before any release. Every later version comes from
  Actions -> Release (the first patch release gives 0.1.1).
- **One installation per integration**: one bridge, one alarm (through the
  bridge, or a Vedo IP when its address is given), one intercom bridge. One
  HTTP session per host (cookie jar per client, 10 cookies at most), one
  request at a time, commands and their reads before the polling; 250 ms
  between two Vedo calls only, 1.5 s between two thermostat commands.
- **Ids**: `bridge:comelit`, `vedo:comelit`, `light:<i>`, `plug:<i>`,
  `shutter:<i>`, `thermostat:<i>`, `area:<i>`, `zone:<i>` with the 0-based
  index the bridge gives (as Home Assistant), `door:<apt-address>-<output>`,
  the target the door opens (never the slot of the intercom address book). The user sees numbers from 1 (area 1 = index 0):
  default names, `zone_kinds`, scene trigger `area` and `zone`.
- **Device kinds**: lights `light/binary`, plugs (`other`) `switch/binary`,
  shutters `shutter/state` (-1 / 0 / 1, the core COVER_STATE; the bridge's
  0 / 1 / 2 stopped / opening / closing), thermostats
  `temperature-sensor/decimal` + `thermostat/target-temperature` (°C, 5 to
  30), alarm states read-only (`text`, `siren`, `tamper`, `input`, the zone
  kinds) and alarm / door commands `button/push` (value 1 only, strictly):
  no "turn everything off" reaches the alarm or the doors. A thermostat whose
  temperature and setpoint are both 0 is a dehumidifier only: left out (as
  Home Assistant). The setpoint feature stays writable when its option is
  off (refused then): the option never changes the device structure.
- **Refused PIN**: a `login.cgi` answered 200 without cookie, or a session
  not seen right after the cookie nor 1.5 s later, is a refusal (aiocomelit
  raises on the first, returns false on the second). The session stops at
  once (no timer); the stop is saved in `/data/comelit-state.json` with the
  address only (never the PIN nor a hash of it: a short PIN is brute-forced
  from any hash). A refused Vedo PIN through the bridge stops the alarm only:
  the bridge forgets that PIN until the next configuration, even across its
  own reconnections. Lifted by saving a new address, port or secret (another
  setting saved never lifts it), or by "Test the connection". A reconnection
  to Gladys keeps the stops. A login.cgi answered 401 or 403 is a refusal
  too. The stop is noted in memory synchronously when the event comes, then
  saved.
- **Other failures**: 10 s, 30 s, 1 min, 2 min, then 5 min between
  sessions; a discovery that fails fails the session (never a partial list);
  the Vedo behind the bridge that fails shows offline and is tried again at
  the next polls without touching the lights.
- **Commands**: sent within 3.5 s of the request or withdrawn ("nothing was
  sent"); answer awaited until 4.5 s. HTTP 200: accepted (bridge objects
  only); a 4xx: refused by
  the bridge (except 404 on the new Vedo firmware, which aiocomelit says
  answers 404 to every action); any other outcome after the write (5xx, no
  answer, lost connection): "sent, without confirmation" with a read back in
  2 s. For the alarm, every answer (200 on the older firmware, 404 on the
  new one) is followed by a state read within the time left: a success only
  if that state differs from the one read before the send and shows the
  result (disarmed: no alarm, no entry or exit delay); else "sent, without
  confirmation" and a read back.
- **Alarm**: arming refused unless the area is disarmed with no delay nor
  alarm running; already in the mode asked: nothing sent; disarming sends
  unless disarmed with nothing running. Never forced (`force=0`); HA passes
  the anomaly flag as `force`, here an area the Vedo will not arm stays
  disarmed. Arming and disarming are two options, both off by default.
- **Shutters**: open / close are absolute but decided on a fresh read:
  moving the other way is refused (the bridge would only stop it). Stop sends
  the reverse of the movement read (Home Assistant's way); a guard (with its
  start state) refuses a second stop until the bridge shows the shutter
  stopped or 15 s pass.
- **Thermostats**: setpoint behind its option, 5 to 30 °C, a strict number
  (null, '' are not numbers), rounded to 0.1; refused while off or automatic;
  two thermostat commands at least 1.5 s apart (aiocomelit).
- **Doors**: behind their option; the intercom is contacted only when its
  address and token are set; one short ICONA session per operation (list,
  open); the door looked up in the configuration read in the same session;
  the option and the deadline checked before the CTPP channel and before the
  first opening frame; the answer is always "sent, without confirmation",
  even with every frame written (the bridge never confirms); at 4.5 s the session is closed, nothing more is
  written; no new opening of the same door for 10 s. The doors are read at
  start, on a scan and on "Test the connection", again after 1 min, 5 min,
  then every 30 min on a failure.
- **Model**: every read changes the model when the client emits it, at its
  answer, in order (one request at a time per host: the answers come in the
  order of the requests); the publication, scene events and status follow
  in the event chain. The acks never wait for a publication to Gladys.
- **Prototype pollution**: JSON from the bridge, the intercom and `/data` is
  parsed with a reviver that drops `__proto__`, `constructor` and
  `prototype`; fields are read as own properties by fixed keys; the model and
  the configuration use `Map`s; nothing from the network becomes a key.
- **Scene events**: one per transition; none for the first state seen after
  a start; `alarm_triggered` carries the first zone in alarm (zones do not
  say their area in v1). No scene action in v1: buttons only.
- **Rate limits**: the publisher of gladys-risco / gladys-envisalink (same
  author): only changed values, a heartbeat every 30 min plus a per-feature
  offset, 240 states/min of which 60 kept for what is not a zone, 120
  events/min, `alarm_triggered` never dropped and tried 3 times.
- **Not checked**: Docker is not installed on this PC, so no image build and
  no end-to-end test in a container; never run against a real bridge, Vedo
  or intercom; the ICONA frames are checked against comelit-client's source
  read by hand (its TypeScript was not run).

## Decisions after the review (2026-10-18)

- **A (blocking) - "Test the connection" and the options**: `configUpdated`
  keeps the raw configuration in both branches and applies the four options
  (`allow_setpoint`, `allow_arm`, `allow_disarm`, `allow_door`) to the
  configuration in use before anything is awaited; "Test the connection"
  always reads `gladys.getConfig()` again and restarts with it. An option
  switched off stays off across the button.
- **B - door entry reassigned**: the discovery keeps `apt_address` and
  `output_index` in the params of each door device; the opening compares the
  entry read in the same session with them (or with the last doors read);
  a difference is refused ("the intercom configuration changed, scan
  again"), no frame written, and the doors are read again.
- **C - alarm confirmation**: only a state that differs from the one read
  before the send can confirm; a disarm needs disarmed, no alarm, no entry
  nor exit delay.
- **D - older Vedo firmware**: a 200 goes through the same confirmation
  read; not shown in time: "sent, without confirmation" and a read back.
- **E - 401 / 403 to `login.cgi`**: a refused PIN, persisted stop.
- **F - doors**: always "sent, without confirmation".
- **G - "close everything"**: a status read asked of the bridge after a
  command arrived, with no command sent to that object since, serves it
  (several commands of one type share one read); the bridge calls no longer
  wait 250 ms (only the Vedo calls; thermostats 1.5 s). Eight shutters closed
  at once all leave. A shutter opening during it is refused (documented).
- **M2** stops noted synchronously in the event handler, then saved; **M3**
  10 cookies at most; **M4** the "plugs" are every `other` object and obey
  the "turn everything off" (docs warn about gates and pumps); **M5** the
  manifest description names the doors; **M6** docs: the session cookie
  travels in clear too; **M7** the arm P1 button follows `p1_pres` like
  P1 + P2 follows `p2_pres`; **M8** one log line for every command refused in
  `setValue`; **M9** open / close refused while a stop guard is up; **M10** a
  door missing from the configuration read again triggers a new reading of
  the doors.

## Decisions after the approval round 1 (2026-10-18)

- **B (replaces the params check)**: Gladys rewrites the params of a device
  (`upsertDeviceParams`), so they cannot hold what a door was made for. The
  external id is the target: `door:<apt-address>-<output-index>`;
  `parseFeatureId` reads it, the opening looks for that address and output
  in the configuration read in the same session. A slot of the book given to
  another target is a new device; the old one is refused as missing, no
  frame, and the doors are read again (test B2).
- **S - shutter stop**: always decided on a `fresh()` read of its own, made
  right before; the shared read stays for open, close and setpoints, and is
  used at most 1 s old when deciding (test S: "stop everything" while a
  shutter reaches its end, no reverse command).
- **Starts**: `startNow` always takes the latest configuration received
  (`rawConfig`, set by `connected`, `configUpdated` and "Test the
  connection"), so a start queued behind a newer save never brings back the
  older options (test A3).
- **Alarm confirmation**: reads every 500 ms until 4.5 s after the request,
  success at the first that shows the result (and differs from the state
  read before).
- **"Test the connection"** with an empty configuration from Gladys: fails
  with a status, nothing started, the running sessions kept.
- **arm()**: `armed_p1` refused on an area without P1, as `armed_p12` without
  P2.
