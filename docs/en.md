# Eloverblik (Denmark)

Unofficial integration, not affiliated with Energinet nor with Eloverblik. It
reads the hourly electricity consumption of your Danish metering points through
the **official customer API of Eloverblik** (Energinet DataHub) and feeds the
energy monitoring of Gladys with it. Read-only: nothing is ever changed on your
account.

> This integration has never been tested with a real Eloverblik account: it is
> written from the official API description (Swagger). Feedback is welcome.

## What you need

- A Danish electricity metering point (consumption) and MitID to log in to
  [eloverblik.dk](https://eloverblik.dk/).
- Gladys 5.3.0 or later.

## Create the token

1. Log in to [eloverblik.dk](https://eloverblik.dk/) with MitID (private
   customer).
2. Make sure your metering points are linked to your account (they appear on
   the home page).
3. Open the **Data sharing** menu (_Datadeling_), then create a token for the
   API. Give it a name, for example "Gladys", and copy it: it is a long text in
   three parts separated by dots, shown only once.
4. In Gladys, open the integration, paste the token in **Eloverblik token**
   and save.

The token is valid for **one year**. The status of the integration shows the
date it ends: create a new one on eloverblik.dk before that date and save it
in Gladys.

The token is kept by Gladys in its database, never shown again, and sent only
to Eloverblik (`api.eloverblik.dk`). It is never written in the logs, the
status nor `/data`.

## Create the devices

After saving, the integration lists your **consumption** metering points (type
E17; production points are not read, 10 points at most). Open **Discovery**
and create the devices you want: each one is named "Eloverblik meter …1234"
(the last 4 digits of the metering point id only) and has a single feature,
**Consumption (30 min)**.

Only the created devices are read. The **Test the token** button asks for an
access token and lists your points (at most once a minute).

## How the data arrives

- Eloverblik publishes the consumption **one or two days late**. The
  integration reads once a day, from 09:00 (Danish time, a minute proper to
  your installation, up to 12:00), and asks only for the days not yet
  complete. While yesterday is incomplete, it reads again 4 hours later, 4
  times a day at most.
- At the first read, it takes **31 days** back. After a stop, it catches up at
  most 92 days back. The last 3 complete days are read again with the next
  days: an estimated value replaced by a measured one is corrected.
- Each hour is split in **two equal half hours** (the energy monitoring of
  Gladys works by half hours). An hour Eloverblik marks as not available
  (quality A02) or incomplete (A05) stays **unknown**: it is never counted as 0. A day with a missing hour is asked again for 10 days, then given up.
- The consumption goes into the energy monitoring with the date of each half
  hour (`publishEnergyConsumption`): there is no cumulative index, and no live
  value.

## Costs and energy contracts

This integration has no contract of its own. To see costs, attach an energy
contract to the consumption in Gladys, for example the Danish contract of the
**Energi Data Service** integration (grid tariffs, Energinet, elafgift and
DK1/DK2 spot prices). Danish tariffs that depend on the hour need the
30-minute consumption: this is what this integration publishes.

## Limits of the Eloverblik API

The integration stays far below the published limits: at most 30 requests a
day, one at a time, 2 seconds apart; the data access token (valid 24 hours) is
kept in memory and renewed after 20 hours; two token requests are never closer
than 5 minutes, even after a restart (the time is kept in `/data`; the limit
is 2 a minute per IP).

- **429 (too many requests)** or **503 (DataHub unavailable)** and other 5xx:
  every request pauses (the `Retry-After` of the answer when given, else 15
  minutes, doubled each time up to 6 hours). The pause survives a restart.
- **Refused token** (the token request answers 401, or 403 / an error code of
  the API): nothing is asked any more; the status says so. Save a new token,
  or press Test once the token works again.
- A 401 or 403 on a **data** route is not a refusal of your token: the access
  token is dropped and a new one is asked at the next read.
- An error on one metering point (no data, relation expired, ...) is shown in
  the status with its code (for example `E30015`); the other points go on.

## What `/data` keeps

`/data/eloverblik.json` keeps: the time of the last read and of the last token
request, the count of requests of the day, the pause, a mark of a refused
token (8 bits of a salted hash, nothing to find the token back from) and, per
metering point (named by a keyed hash, never its id), the last complete day.

## Troubleshooting

- **"Eloverblik lists no consumption metering point"**: link your metering
  points on eloverblik.dk (the token only sees the points linked to your
  account).
- **"Meter …1234: E20010"** (relation not found) or **E30016** (relation
  expired): link the metering point again on eloverblik.dk.
- **"E30015"**: no data for the period yet; it is asked again.
- **"not_listed"**: a created device is no longer among the metering points
  of the token.
- The Gladys time zone should be the Danish one (or the same clock): the days
  are Danish days.

## Data source

Data: Eloverblik, Energinet DataHub, your own meter data, read with the token
you created.
