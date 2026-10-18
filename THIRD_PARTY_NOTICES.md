# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the projects below, all under the
Apache License 2.0 too (its full text is the `LICENSE` file of this
repository). The ported parts were rewritten, not copied; the changes are
described below.

## aiocomelit

<https://github.com/chemelli74/aiocomelit> (package `aiocomelit`, version
3.0.0, tag `v3.0.0`), the library of the Home Assistant Comelit integration.
Apache License 2.0. Its notice, at the top of each source file:

```
Copyright 2023 Simone Chemelli and contributors
SPDX-License-Identifier: Apache-2.0
```

Ported:

- `src/aiocomelit/api.py`, in `src/comelit/client.js` and
  `src/comelit/pages.js`: the login (`login.json`, `login.cgi` with the PIN
  in the body, the session cookie, the check of the session after the
  login), the Vedo pages (`area_desc`, `area_stat`, `zone_desc`,
  `zone_stat`), the area and zone states and their order, the detection of
  the new Vedo firmware (`index.shtml`) and its actions by POST, the actions
  `tot` / `dis` and their parameters.
- `src/aiocomelit/devices/bridge.py`, in the same files: the pages of the
  Serial Bridge (`icon_desc`, `icon_status`, `action.cgi`), the object types,
  the shutter states, the thermostat setpoint in tenths and the pause between
  two thermostat commands, the Vedo through the bridge (`vedo_` pages,
  `alm=` login).
- `src/aiocomelit/devices/vedo.py`: the Vedo IP (`code=` login, pages
  without prefix, `action.cgi`).
- `src/aiocomelit/const.py`: the zone status bits, the area state order, the
  pauses between calls and after a Vedo login.

Changed: one request on the wire at a time per host, never two closer than
250 ms, commands before polling; a refused PIN (no cookie, or no session
after a second look) stops the logins with no new try, persisted; growing
waits between sessions; a discovery that fails fails the session; the Vedo
behind a bridge never stops the bridge; every page field checked, JSON parsed
without prototype keys; actions never forced (`force=0`); a request that may
have left is reported "sent, without confirmation", never "not sent".

## Home Assistant, Comelit integration

<https://github.com/home-assistant/core>, `homeassistant/components/comelit`
(read at commit `5cfe9aa`), Apache License 2.0, by the Home Assistant
authors. Followed, not copied: the arming levels of an area (0 disarmed, 1
P1, 2 P2, 3 P1 + P2, 4 total) and the actions `p1` and `p12`; the thermostat
values (`val[0]`: temperature, mode, manual or automatic, setpoint); a
thermostat that is only a humidifier left out; the shutter stopped by a
command the other way.

## comelit-client

<https://github.com/madchicken/comelit-client> (package `comelit-client`,
version 3.0.0, commit `f2c7d3d`), by Pierpaolo Follia. Apache License 2.0.

Ported, in `src/comelit/icona.js`: the ICONA protocol of the intercom
bridge (`src/icona/packet.ts`, `src/icona/types.ts`,
`src/icona-bridge-client.ts`): the frame header, the channel frames
(`createBinaryPacketFromStrings`), the JSON frames, the channels `UAUT`,
`UCFG`, `INFO` and `CTPP`, the access, configuration and server-info
messages, the door address book, and the opening frames byte for byte; the
sequence of its `icona open-door` command (`src/bin/icona-cli.ts`).

Changed: one short session per operation; every answer awaited with a
timeout; frames bounded to 64 KB; JSON parsed without prototype keys; a
token answered with a response code other than 200 stops the intercom with
no new try, persisted; the door looked up in the configuration read in the
same session; the option and the deadline checked right before the first
opening frame; nothing written after Gladys got its answer.
