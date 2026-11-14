# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

It reads the Danish electricity metering points of the user through the
official customer API of **Eloverblik** (`api.eloverblik.dk/customerapi`,
Swagger V1.0): GetToken trades the token the user created in the portal for a
data access token (24 h), the list of the metering points, and the hourly time
series, published after the fact with `publishEnergyConsumption` (each hour in
two half hours). **Read-only.** Unofficial: not affiliated with Energinet.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/model.test.js            # one file
node --test --test-name-pattern "429"     # tests whose name matches
npm run audit                             # npm audit --omit=dev
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run mutants                           # mutation check (scripts/mutants.json)
npx github:GladysAssistant/integration-store .   # store admission checks
```

## Architecture

```
index.js                          SDK wiring only
src/handlers.js                   the SDK handlers, registered before connect()
src/app.js                        EloverblikApp: pace, tokens, refusal, pauses, /data,
                                  Discovery, the consumption published, status, test button
src/eloverblik/client.js          the only network access (bounded, one request at a time)
src/eloverblik/model.js           answers -> token, metering points, 30-minute slots (pure)
src/devices.js                    the device of a metering point (pure)
src/time.js                       local time of Denmark (Europe/Copenhagen), pure
src/config.js                     the form, normalized; the expiry of the token (status only)
src/store.js                      /data/eloverblik.json
src/constants.js                  endpoint, pace, limits, bounds, manifest keys
src/i18n.js                       runtime texts (en/fr)
gladys-assistant-integration.json manifest: config, action, countries
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys
scripts/                          cover.png generator, mutation runner and list
```

## Rules

- **Keys are forever too**: the external ids `mp:<hash>` (16 hex of an
  HMAC-SHA-256 of the metering point id under the `id_key` kept in the Gladys
  config outside the form, see `keyOf`; never an unkeyed hash, never the key
  in /data or a log), the `FEATURE` keys of `src/devices.js`, the manifest keys.
- **Never a token nor a metering point id** in a log, the status, an error
  message, an id or `/data` (the last 4 digits only, in names). The ids go in
  the request body, never in a URL.
- **Read-only**: never add a write to the user's account.
- **Be polite with Eloverblik**: one read a day (4 at most while yesterday is
  incomplete), at most 30 requests a day counted in /data before each request,
  one request at a time, 2 s apart; the data access token kept in memory 20 h;
  two GetToken never closer than 5 minutes (kept in /data); 429 and 5xx pause
  everything (Retry-After, 15 min doubled up to 6 h, kept in /data).
- **Refusal** only from GetToken (401, a 403 of the API, error codes 50000 /
  50001); a 401/403 of a data route only drops the access token.
- **Energy**: no index, never `publishStates`; an unavailable or incomplete
  hour (A02, A05) stays unknown, never 0; a day is complete when every half
  hour is known.
- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`. Gladys keys devices, their history,
  scenes and dashboards on them: changing one creates a new device and orphans
  the old one. The same goes for every key users store: manifest
  `config_schema`, `actions`, feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md`. Never write a version heading.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`.
  The catalog `description` holds 10 to 100 characters per language.
  `countries: ["DK"]` needs `gladys_version >= 5.3.0`.
- **User-facing text** is bilingual (English and French), kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network (local servers only).
