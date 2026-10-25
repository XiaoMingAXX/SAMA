# Preserved iteration history

The original working folder was not a Git repository. This repository reconstructs three source stages at publication time. Commit timestamps are publication timestamps; no original commit chronology is fabricated.

## lan-v1.1.0 — local observation prototype

Recovered from the existing LOAM Soil Studio package: browser UI, simulation, RS485/Modbus modules, FTX-W80 configuration and LAN tests. Original naming is preserved. The root test command is scoped to `tests/` so later cloud tests remain separate.

## cloud-v0.1.0 — outbound cloud gateway demonstration

Recovered from the cloud files in the same package. The old server snapshot was cross-checked against the retained v0.1 source reference. Adds central readings and recent JSON history, but no account/plant isolation. Historical README material is rewritten to remove private operational details.

## cloud-v0.2.0 — plant-centred warehouse

Preserves the current warehouse runtime and tests, adds public deployment templates, bilingual project documentation, MIT licensing and CI. The Windows launcher accepts an installed Node runtime instead of an IDE-specific fallback. The LAN test command uses an explicit test-file pattern for Node 24; its SSE integration test waits for both subscriptions and checks concurrent responses without assuming HTTP arrival order. Runtime data, credentials, old operational addresses, backup bundles and research participants' material are omitted from every stage.

The LAN application remains at the root; `cloud/` is the current warehouse. Checkout a tag in a separate workspace to inspect an earlier cloud version. Historical versions are prototypes and do not inherit current account protection.

## Continuing development

Make new commits from `main`, document the problem and observed behaviour, add meaningful tests for changes that affect data or permissions, and create a new release tag when a coherent iteration is ready. Do not overwrite the preserved stage tags.
