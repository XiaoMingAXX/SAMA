# SAMA · cloud gateway prototype

**Soil Analysis and Monitoring Array** — an Innovation by Design project moving from displaying readings toward supporting better plant-care decisions.

The original **LOAM LAN dashboard** remains at the repository root. This iteration adds a [server-side gateway demonstration](cloud/README.md) under `cloud/`, so an outbound-connected Wi-Fi bridge can send observations to a central service.

The demonstration provides live readings, recent JSON history and CSV export. It does not yet separate users, plants or sensor ownership. These gaps motivate the next warehouse iteration.

For the LAN prototype, use Node.js 20+ and run `npm start`; open `http://localhost:3000`. Use `npm test` for the LAN tests. Both prototypes are for trusted isolated networks and have no account authentication.

History is reconstructed from existing source snapshots, with commit dates reflecting publication. No research outcome, measurement accuracy or commercial demand is claimed as validated.

MIT licensed; see [LICENSE](LICENSE).
