# Contributing

Describe the user situation and expected behaviour before proposing a change. Keep simulation and physical observations distinguishable. Changes to sampling, ownership or exports should preserve provenance and explain migration implications.

Use Node.js 24.15+ with SQLite 3.51.3+, install cloud dependencies with `npm ci --prefix cloud --include=optional --ignore-scripts`, then run `npm test` and `npm --prefix cloud test`. Add focused tests when changing data integrity, permissions or protocol behaviour.

Never commit `.env`, credentials, databases, real photos, raw participant data or production logs. Use fake fixtures in tests and generic addresses in examples. Do not bundle vendor manuals or course handouts. Existing published tags preserve source stages; make new commits and new tags for later iterations.

Contributions are provided under the repository's MIT license.
