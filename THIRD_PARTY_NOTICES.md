# Third-party notices

## Eloverblik customer API

This integration calls the official customer API of Eloverblik, run by
Energinet DataHub (https://api.eloverblik.dk/customerapi/, Swagger
"Eloverblik.Api.CustomerApi" V1.0, read on 2026-11-14). It is written from that
description. The meter data are the user's own data, read with the token the
user created in the Eloverblik portal.

## pyeloverblik

The Python client pyeloverblik (https://github.com/JonasPed/pyeloverblik,
version 0.4.4, commit b13df56, Apache License 2.0, by JonasPed) was read as an
example of the token exchange and of the time series answers. No code of it is
copied nor shipped.

## Runtime dependency

- `@gladysassistant/integration-sdk` (Apache-2.0).
