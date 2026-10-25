# Validation scope and known limits

## Automated software checks

The LAN suite contains 18 tests for localization, protocol/configuration validation, transport and HTTP behaviour. The warehouse suite contains 9 integration tests covering authorization and CSRF, exclusive sensor use and transfers, recording and exports, processed photos, SSE, hot/cold history pagination, injected storage failures, TCP request serialization, database backup/restore and OSS SDK credential-file handling with test doubles.

Local tests use explicit fixtures and simulated data. OSS mock tests do not prove connectivity or permissions for another deployment; run the explicit preflight in that environment. CI runs the same two suites on Linux with Node 24. Runtime dependency installation includes optional native packages required by Sharp.

## What remains to validate

- Probe calibration, units/model support and representative measurement in orchid substrates. Software register decoding alone does not validate agronomic accuracy.
- Physical gateway firmware behaviour with the current registration packet and a protected remote connection.
- Sustained acquisition and concurrent uploads at the planning scale of fewer than ten gateways/sensors and roughly 500 plant profiles. This is not an accepted load-test result.
- User comprehension and whether the records lead to useful next checks or improved care outcomes.
- Model-service authentication, model selection, grounded advice quality, uncertainty and user feedback. No model is currently called.

## Current product boundaries

No automatic camera capture, retained original photographs, HEIC decoder, autonomous watering/dosing or validated disease diagnosis. Live observations outside active recordings are not retained automatically. Offline periods remain gaps. Probe rotation does not create continuous monitoring of every plant.

Jobs are bounded to 500,000 scanned samples and 256 MiB outputs. Hot data defaults to 24 hours; archives provide older detail. CSV consumers may need to sort across blocks by UTC timestamp and sample ID. Local object mode consumes local disk and is intended for development.

MIT licensing does not grant rights to private participant material or third-party documentation, which is not included.
