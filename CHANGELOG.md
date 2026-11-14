# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- First version: the Danish electricity meters read through the official
  customer API of Eloverblik (Energinet DataHub) with the token the user creates
  on eloverblik.dk, read-only.
- One device per consumption metering point (type E17, 10 at most), offered in
  Discovery, named by the last 4 digits of its id only.
- The consumption published after the fact into the energy monitoring
  (`publishEnergyConsumption`, quarter hours added two by two, or each hour in
  two half hours when DataHub refuses quarter hours), 31 days back at the
  first read but never before the day the metering point became the user's
  (a point answered 30018/30010 asked again alone from a later day, a point in
  error asked again the next day), then the days not yet complete (and the last 3 again, for
  the estimates replaced by measures); an unavailable hour stays unknown,
  never 0.
- Pace and limits: one read a day from 09:00 (Denmark), again 4 hours later
  while yesterday is incomplete (4 a day at most), 30 requests a day at most
  counted in `/data` before each request, the data access token kept in memory
  20 hours and two token requests never closer than 5 minutes, pauses on 429
  and 5xx (15 minutes doubled up to 6 hours, a longer Retry-After honoured) kept across a
  restart.
- A refused token stops every request until a new token is saved or Test
  succeeds; the status shows the date the token ends.
- A test button: a data access token and the list of the metering points.
- The manifest declares `countries: ["DK"]` (Gladys 5.3.0 or later).
