# Eloverblik (Denmark) for Gladys Assistant

Unofficial [Gladys Assistant](https://gladysassistant.com) integration for the
Danish electricity meters, through the **official customer API of
[Eloverblik](https://eloverblik.dk/)** (Energinet DataHub). Not affiliated with
Energinet nor with Eloverblik. With the token you create on eloverblik.dk, it
reads the hourly consumption of each consumption metering point you create in
Discovery and publishes it after the fact into the energy monitoring of Gladys
(each hour in two half hours): Eloverblik serves the data one or two days late.

**Read-only**, one read a day (4 scheduled reads at most while yesterday is
incomplete, plus a read a minute after a new device, token or Test), at most
30 requests a day. Never tested with a real Eloverblik account yet.

Documentation: [English](docs/en.md) · [Français](docs/fr.md).

## Development

```bash
npm install
npm test            # node --test
npm run lint
npm run format:check
npm run mutants     # mutation check of the guards (scripts/mutants.json)
npm run cover       # regenerates cover.png
```

Rules for contributors and coding assistants: [CLAUDE.md](CLAUDE.md).
Open points and decisions: [TODO.md](TODO.md).

## Credits and license

Apache-2.0 ([LICENSE](LICENSE)). Written from the official API description of
Eloverblik; the Python client pyeloverblik (Apache-2.0) was read as an
example, none of its code is used: see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
