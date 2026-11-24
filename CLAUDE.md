# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js)
(v0.16),
its only runtime dependency. It started from the official JavaScript template.

## Commands

```bash
npm install
npm test                                  # node --test --test-timeout=60000
node --test test/app.test.js              # one file
node --test --test-name-pattern "shutter" # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/handlers.js                   the SDK handlers, shared with the tests
src/app.js                        ComelitApp: lifecycle, model, devices, states, events, commands
src/comelit/pages.js              the bridge and Vedo JSON pages (aiocomelit api.py, const.py)
src/comelit/client.js             one HTTP session per host: login, discovery, polling, actions
src/comelit/icona.js              the intercom bridge (ICONA, comelit-client): frames, doors
src/http.js                       one HTTP request (node:http), "sent or not" errors
src/json.js                       JSON parsed without prototype keys
src/devices.js                    model -> Gladys devices and states (pure)
src/publisher.js                  states and scene events under the Gladys rate limits
src/store.js                      /data: the stops after a refused PIN or token
src/config.js                     DEFAULTS (mirror the manifest defaults) + normalization
src/constants.js, src/i18n.js     keys, timings, limits; French and English texts
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, the SDK's fake Gladys + test/helpers/fakeComelit.js
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

Safety rules of this integration (see TODO.md "Decisions"): setting a
thermostat, disarming and opening a door stay off by default, each option
checked again right before the write (arming is always allowed); alarm and door commands are
push buttons, never switches; shutters are `shutter`, never switches; a
command decides on the state read from the bridge just before it, one at a
time per host (an arming goes first on the alarm's line, its read shared by
the arms arriving together, and an arm total leaves even on an unreadable
state); a command that may have left is never reported "not sent";
a refused PIN or token stops its session, never a loop; the acks never wait
for a publication; the PINs and the token are never logged nor written to
`/data`.

## Rules

- **Features follow the core model.** Every feature has a non-empty `name`, a
  numeric `min` and `max` (0/0 for text), boolean `read_only` and
  `has_feedback`: Gladys refuses it otherwise, and the SDK's fake Gladys
  (0.16.1) too; `test/helpers/coreFeature.js` checks every device of the
  discovery test (bridge, lights, plug, shutter, thermostat, areas, zones,
  doors).
  Devices carry `should_poll: false` (Gladys 5.3 polls a device with
  `poll_frequency` unless it says so).
- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the unique id the
  platform gives the device (serial, cloud id, MAC), never a label. Gladys keys
  devices, their history, scenes and dashboards on them: changing one creates a
  new device and orphans the old one. The same goes for every key users store:
  manifest `config_schema`, `actions`, widget and scene keys, feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log tokens, passwords or API keys.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the README's hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language. A field the
  older cores do not know needs a higher `gladys_version` minimum
  (`categories`: 4.86.0; `widgets`, `scene_triggers`, `scene_actions`,
  `type: "provider"`: 5.1.0). `test/manifest.test.js` ties the manifest to the
  code (defaults, action and scene handlers): change both sides together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync. A secret
  field is "kept by Gladys in its database, never shown again": Gladys
  stores it in clear, never say otherwise.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network (`test/http.test.js` uses a
  server on the loopback interface only).
