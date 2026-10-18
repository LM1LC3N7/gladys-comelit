# Comelit (SimpleHome, Vedo, intercom) for Gladys

This integration connects a **Comelit** installation to Gladys Assistant,
**locally** on your network, without the Comelit cloud:

- the **SimpleHome** bridge (Serial Bridge): lights, plugs, shutters,
  thermostats;
- the **Vedo** alarm, through the bridge or on a Vedo IP of its own;
- optionally, the **doors and gates** of the intercom bridge.

> **Never tested with a real bridge.** The protocol comes from the
> [aiocomelit](https://github.com/chemelli74/aiocomelit) 3.0.0 library (the
> one of the Home Assistant Comelit integration) and, for the doors, from
> [comelit-client](https://github.com/madchicken/comelit-client), ported to
> JavaScript and checked only against a simulated bridge. Make your first
> tries at home, alarm disarmed, and report what goes wrong.
>
> Unofficial integration, not affiliated with Comelit Group.

## What you get

- **Comelit bridge**: connected or not.
- **Lights** (on, off) and **plugs** (on, off), with their state. The
  "plugs" are **all the "other" objects** (`other`) of the bridge, published
  as switches: they obey the "turn everything off" of voice assistants and
  scenes. An "other" output may drive a gate, a pump or a boiler: check what
  is behind each one before creating it in Gladys.
- **Shutters**: open, close, stop (a "shutter" feature, never a switch). The
  bridge gives no position, only the movement.
- **Thermostats**: measured temperature and **setpoint**. Setting the
  setpoint is **off by default** (option "Allow setting the thermostats").
- **Vedo alarm**, one device per area (named as in the Vedo):
  - read-only **State**: disarmed, armed (partial P1, P2, P1 + P2, total),
    arming, entry delay;
  - **Alarm in progress** and **Tamper**;
  - **buttons**: arm total, arm partial P1, arm partial P1 + P2 (if the area
    has a P2), disarm.
- Alarm **zones**, one per device: open or closed (or motion, smoke, leak
  depending on the kind chosen), alarm, excluded, tamper.
- **Intercom doors**: one "Open" **button** per door.
- **Scene triggers**: alarm triggered (with the first zone in alarm), area
  armed (mode, asked by Gladys or not), area disarmed.

No alarm or door command is a switch: a "turn everything off" from a voice
assistant, HomeKit or a scene can neither disarm nor open a door. The states
are read-only, the commands are buttons.

## Configuration

1. **Address of the bridge**: the IP address of the SimpleHome bridge. Give
   it a fixed address in your router. Empty if you only have a Vedo IP.
2. **Port of the bridge**: 80 unless changed.
3. **PIN of the bridge**: the one of the bridge web page, if it has one.
4. **PIN of the alarm**: a Vedo user code. Without it, the alarm is not read.
5. **Address of the Vedo IP**: only if your Vedo has its own network module.
   Empty: the alarm is read through the bridge.
6. **Kind of the zones** (optional), numbered from 1 as in the Comelit app,
   for example `2:motion, 5:smoke, 7-9:motion`. Kinds: `opening` (default),
   `motion`, `smoke`, `leak`. Changing the kind of a zone already created adds
   a new feature and keeps the old one (and its history).
7. **Intercom** (optional): address of the intercom bridge, port (64100) and
   **user token** (see below).
8. **Reading interval**: 10 seconds by default (5 to 300). The bridge pushes
   nothing: a change made on a keypad or in the Comelit app shows within this
   time.
9. **Safety**: see below.
10. **Language of the names**: French or English.

The PINs and the token are **secret fields**: kept by Gladys in its
database, never shown again in the interface, sent only to the bridge, the
Vedo or the intercom bridge. They never show in the logs nor in `/data`.
Beware: the bridge and the Vedo speak plain HTTP only, and the intercom
protocol is not protected either: **they travel in clear on your local
network**, like the session cookie the bridge gives after the login (whoever
reads it can drive the bridge while the session lasts). Protect your network (a separate guest Wi-Fi for the devices you
are not sure about).

The **Test the connection** button restarts what is stopped (refused PIN
included), waits for the connections and tells what was found.

## Safety

- **Arming is off by default**, **so is disarming**: two separate options.
  Once "Allow disarming" is checked, **every Gladys user, every scene and the
  Gladys mobile app can disarm without typing any code**: the PIN of the
  configuration is enough. Allow it only if your Gladys is well protected.
  Disarming also silences an alarm in progress.
- **Setting a thermostat is off by default.** The setpoint goes from 5 to
  30 °C; it is refused while the thermostat is off or in automatic mode (its
  program sets the target).
- The options are checked when the command arrives, in the queue, after the
  state is read again and right before the request is sent: an option
  switched off while a command waits its turn stops that command.
- Before each alarm, thermostat or shutter-stop command, the integration
  **reads the state from the bridge again** and decides on it, never on what
  it has in memory. Commands go one at a time.
- Arming is never forced: an area the Vedo will not arm as it is (open zone,
  anomaly) stays disarmed.
- A command that cannot leave in time (slow bridge, unreadable state) is
  refused with "nothing was sent". A command that left without a clear answer
  (no answer, unexpected answer) is reported "sent, without confirmation"
  and the state is read again: it is never reported "not sent". Only a clear
  refusal of the bridge (HTTP 4xx) is reported "refused".
- For the alarm, the HTTP answer proves nothing: the older Vedo firmware
  answers 200 and the new one 404 to every action (aiocomelit notes it). The
  integration reads the state at once and reports a success only when the
  state read **has changed** and shows the result (disarmed: no alarm nor
  delay running any more); otherwise "sent, without confirmation".
- Several shutter or thermostat commands arriving together ("close
  everything") share one read, made after they arrived, as long as no
  command went to that shutter since. The bridge calls follow one another
  without a pause; only the Vedo calls keep 250 ms apart, and the thermostats
  1.5 s, as aiocomelit does.
- During a "close everything", a shutter that is opening is refused (the
  command would stop it instead of closing it): send it again once stopped.
- Stopping a shutter sends the command of the other direction (that is how
  the bridge stops a shutter); no second stop goes until the bridge shows the
  shutter stopped (15 s at most), else it would start the other way; opening
  or closing that shutter is refused meanwhile too. Opening a closing shutter
  (or the reverse) is refused: stop it first.
- Every command, sent or refused, is written in the integration logs.

## Intercom doors

**Opening doors is off by default, and the protocol used is little known:
its author calls it "very alpha". Once the option is checked, every Gladys
user, every scene and the Gladys mobile app can open your doors and gates,
and nothing confirms that the door opened. Turn it on only if you accept this
risk, and test it at home.**

- You need the **user token** of the Comelit app: see the
  [comelit-client guide](https://github.com/madchicken/comelit-client/wiki/Get-your-user-token-for-ICONA-communication).
  This token opens your doors: treat it as a key.
- The doors are read from the address book of the intercom bridge
  ("opendoor"). Actuators and entrances are not supported in this version.
- Each opening opens a short connection and reads the configuration of the
  bridge again: the door must be in it, with the same address and output as
  at the discovery (kept in the parameters of the device). Otherwise: refused
  with "the intercom configuration changed, scan again", no frame, and the
  doors are read again. The integration then checks the option and the
  deadline right before the first opening frame, and writes the frames of
  comelit-client.
- The bridge gives no confirmation: **Gladys always answers "sent, without
  confirmation"**, even once every frame is written.
- A door is not opened again from Gladys within 10 seconds.
- If the bridge refuses the token, the intercom stops and does not try again
  by itself.

## Connection and refused PIN

- **One session with the bridge**: one request at a time, commands before
  reads, at least 250 ms between two Vedo calls.
- On a cut, the new tries are spaced: 10 s, 30 s, 1 min, 2 min, then every
  5 minutes.
- **If the bridge refuses its PIN, the integration stops** and does not try
  again by itself, even after a restart (a wrong PIN tried in a loop could
  lock the device). Same for the alarm PIN (only the alarm stops, the lights
  go on) and for the intercom token. Fix it and save, or click "Test the
  connection". The file `/data/comelit-state.json` keeps only the address
  concerned, never the PIN.
- A refusal is an HTTP 401 or 403 answer to the PIN posted, an answer
  without session cookie, or a session still missing 1.5 s later: a bridge slow to open the session may be taken
  for a refusal (the integration then stops, without a loop; "Test the
  connection" restarts it).

## Known limits

- Never tested with a real bridge (see above).
- Read at an interval: the bridge does not push its changes.
- Shutters: no position, only open, close, stop.
- Thermostats: only the temperature and the setpoint (no mode, no humidity);
  a device that is only a dehumidifier is left out.
- Irrigation and scenarios of the bridge: not supported.
- The zones do not tell which area they belong to: the zone given with
  "alarm triggered" is the first zone in alarm.
- An alarm already in progress at start fires no scene (only the changes
  seen do).

## Privacy

Everything stays on your network: the integration only talks to the bridge,
the Vedo and the intercom bridge.

## Licence

Apache-2.0. Logic ported from aiocomelit and comelit-client (Apache-2.0):
see `THIRD_PARTY_NOTICES.md`.
