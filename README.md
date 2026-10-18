# Comelit (SimpleHome, Vedo, intercom) for Gladys Assistant

External integration for [Gladys Assistant](https://gladysassistant.com):
**Comelit SimpleHome** (Serial Bridge: lights, plugs, shutters, thermostats),
the **Vedo** alarm (through the bridge or a Vedo IP) and, optionally, the
**intercom doors**, **locally**, without the Comelit cloud.

> **Never tested with a real bridge.** Unofficial, not affiliated with
> Comelit Group.

- Lights (`light`) and plugs (`switch`): on / off, with their state.
- Shutters as `shutter` (open, close, stop), never a switch.
- Thermostats: temperature and setpoint; **setting the setpoint is off by
  default**.
- Vedo areas: state, alarm, tamper; arm total, arm partial P1, arm partial
  P1 + P2 and disarm **buttons**; **arming and disarming are two options,
  both off by default**. Zones: open or closed (or motion, smoke, leak),
  alarm, excluded, tamper.
- Intercom doors: an "Open" **button** per door; **off by default** (read the
  warning in the guide).
- Scene triggers: alarm triggered, area armed, area disarmed.
- Safety: alarm, door and setpoint commands decided on the state read right
  before them, options checked again right before the write, one command at
  a time per host; the PINs and the token are secret fields, never logged
  nor written to `/data`; a refused PIN or token stops its session (no loop),
  even across restarts.

User guides: [français](docs/fr.md), [English](docs/en.md).

## Development

```bash
npm install
npm test               # node --test (Node 22 and 24), against an in-memory bridge
npm run lint
npm run format:check
npm run audit          # npm audit --omit=dev
npx github:GladysAssistant/integration-store .
```

Layout: `src/comelit/` (pages, HTTP session, ICONA intercom), `src/app.js`
(model, devices, states, scene events, commands), `src/devices.js`,
`src/publisher.js` (rate limits), `test/helpers/fakeComelit.js` (the
simulated bridge and intercom). See `CLAUDE.md` and `TODO.md`.

## Credits and licence

Apache-2.0 (`LICENSE`). The bridge and Vedo protocol is ported from
[aiocomelit](https://github.com/chemelli74/aiocomelit) 3.0.0 by Simone
Chemelli and contributors, the intercom protocol from
[comelit-client](https://github.com/madchicken/comelit-client) 3.0.0 by
Pierpaolo Follia (both Apache-2.0): see `THIRD_PARTY_NOTICES.md`.
