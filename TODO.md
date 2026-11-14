# TODO

## Before announcing

- [ ] Test on a real Gladys 5.3+ with a real Eloverblik token: Test button,
      Discovery, a device created, 31 days in the energy monitoring, a contract
      of the Energi Data Service integration attached, a day later.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store
      (after the first release: the store validator needs the GHCR image).

## To confirm on a real account (built from the Swagger only)

- [ ] The answer of GetToken with an expired or deactivated token: 401 assumed
      (Swagger), or a 200 with `errorCode` 50001 (handled as a refusal too).
- [ ] The name of the portal menu where the token is created (docs say "Data
      sharing" / _Datadeling_).
- [ ] The resolution of the periods with `Hour` aggregation since the 15-minute
      settlement (PT1H assumed; PT15M and PT30M are handled too).
- [ ] `timeInterval.start/end` in UTC with `Z` (Swagger); one period per local
      day.
- [ ] `dateTo` exclusive (pyeloverblik asks yesterday..today for yesterday).
- [ ] The `id` of each result is the metering point id asked.
- [ ] Whether `includeAll=false` lists every metering point the token sees.

## Ideas

- Production metering points (E18) as a dated production feature.
- The charges (`getcharges`) as information, once the energy contracts of
  Gladys can take Danish grid tariffs from the integration.
- Danish texts (manifest and docs).

## Decisions

- **Versions**: 0.1.0 set once by hand when leaving the template (package,
  lock file, manifest, image tag); the Release workflow owns them from now on.
- **SDK** `^0.16.0` (latest on npm on 2026-11-14), Gladys `>=5.3.0` for
  `countries: ["DK"]` (Louis' rule of 2026-11-12); categories `energy`; no
  keywords.
- **Reused project**: no maintained JavaScript client; the integration is
  written from the official Swagger. pyeloverblik (Apache-2.0, JonasPed,
  0.4.4) read as an example only (`THIRD_PARTY_NOTICES.md`).
- **One feature**, the 30-minute consumption fed by `publishEnergyConsumption`
  (no index: a day late, it would pile a day into one half hour; no daily
  feature: a daily total is priced as one interval). Each hour in two equal
  halves; quarter hours added two by two.
- **The metering points** come from the API (no field in the form): consumption
  ones (E17), 10 at most (the advised bundle), one request for all of them.
  Only the created devices are read. The ids live in memory only; device ids
  are HMAC keys under an `id_key` stored in the Gladys config (as
  gladys-myelectricaldata).
- **Tokens**: the user's token never leaves memory; the data access token is
  kept 20 h (valid 24 h) in memory only; two GetToken at least 5 minutes apart,
  a restart included (time in /data). Refusal only from GetToken (401, a JSON
  403, codes 50000/50001), kept as 8 bits of a salted hash, lifted by a new
  token or a Test that succeeds. A 403 page of a proxy is `token_forbidden`
  (passing). A 401/403 of a data route drops the access token only.
- **Pace**: one read a day at 09:00 + a minute proper to the installation
  (0..179), again 4 h later while yesterday is incomplete, 4 reads a day at
  most, 1 h between two reads at least (a new device: 1 minute), 30 requests a
  day at most counted in /data before each request. 429 and 5xx (503 "DataHub
  unavailable") pause everything: Retry-After, else 15 min doubled up to 6 h,
  at least 1 min.
- **Days**: 31 days at the first read, 92 at most after a stop, the last 3
  complete days read again; a day with a missing half hour is asked again for
  10 days, then given up. A metering point answered with an error code keeps
  its mark (its days stay asked).
- **The token expiry** (`exp` of the JWT, read without checking the signature)
  is shown in the status only, never used for a decision.
- **Energy contracts**: none of its own; the Danish delegated contract of
  gladys-energi-data-service prices this consumption. What the engine cannot
  express (Danish tariffs priced by the integration itself) is left to it.
