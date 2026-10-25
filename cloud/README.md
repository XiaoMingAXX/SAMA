# SAMA Cloud Warehouse v0.2.0

Multi-user plant records, configurable recording segments, photographs, historical queries, exports and versioned context snapshots. See [the project overview](../README.md) and [HTTP API](API.md).

## Local preview

Use Node.js 24.15+ with SQLite 3.51.3+. From this directory:

```sh
npm ci --include=optional --ignore-scripts
node manage.mjs demo
node server.mjs
```

Open `http://127.0.0.1:3180`. The demo initializer only accepts an empty workspace. Read the generated credentials from `data-v2/preview-credentials.txt`; simulated readings are labelled. Defaults use local object storage and loopback HTTP/TCP ports 3180/3189. Keep the working directory running to collect observations.

On Windows, after dependency installation:

```powershell
.\start-local.ps1 -InitDemo
# Optional: -NodePath 'C:\Program Files
odejs
ode.exe'
.\start-local.ps1 -Stop
```

The script uses `.preview/data/`, writes logs/PID state under `.preview/`, and only stops the process whose executable, command line and start time match its record. It requires an installed supported Node runtime; it does not depend on an IDE bundle.

For custom settings, copy `.env.example` to ignored `.env`, edit it, and run `node --env-file=.env server.mjs`. Use the same environment for management commands. `CLOUD_DATA_DIR` selects the workspace; one collector may open each workspace.

## Administrator and user accounts

Self-registration creates ordinary accounts. No public request can create the initial administrator. For an empty non-demo workspace, set `SAMA_ADMIN_USERNAME` and a strong `SAMA_ADMIN_PASSWORD` (10–128 characters) in the current process, run `node manage.mjs create-admin`, then remove the password environment variable. Supply secrets interactively or through your secret manager, not shell history.

Administrators can create accounts, reset passwords, disable accounts and manage all plants/devices. Ordinary users see their own records. Administrators lease a sensor to one account at a time; users bind it to their plants. Transferring a sensor ends its active binding and recording without transferring the previous user's historical data.

## Recording, history and photos

Live polling does not imply long-term retention. Save one fresh sample, run a segment, or schedule start/end times. Each segment controls interval, stabilization and full-resolution capture. Full resolution means actual successful readings and frames; offline gaps are not fabricated. Server-side recording continues after the browser closes.

Recent samples are stored in SQLite, then uploaded as verified gzip NDJSON archive blocks. Rows are removed from hot storage only after archive confirmation. Historical jobs combine hot and archived observations. Export CSV, NDJSON or ZIP, optionally with processed photos. CSV provides units, UTC and SGT and escapes formula-like text; exports across blocks are not guaranteed globally time-sorted.

Initial limits: 500,000 scanned rows per job, 256 MiB output, 3 concurrent jobs per account, 300 rows per history page. Hot detail defaults to 24 hours, active database budget to 4 GiB and disk reserve to 512 MiB. Local object storage still consumes local disk.

JPEG/PNG/WebP uploads: 10 MiB and 24 MP maximum. The service strips EXIF and generates up to 1600 px display images and 360 px thumbnails; originals are not retained. HEIC must be converted. Display-image quota is 2 GiB per account, with at most 10 unfinished uploads. Photos can describe a plant, a daily state or a specific sample.

## Future analysis interface

Create a job with `POST /api/v1/plants/:id/context-snapshots`, poll `GET /api/v1/jobs/:id`, then fetch `GET /api/v1/context-snapshots/:snapshotId`.

`sama.plant-context.v1` fixes the time range/cutoff, profile revisions, sensor metadata and bindings, units, statistics/buckets, care events, photo references and limitations. Analysis snapshots exclude demo samples by default. Authentication currently uses the user's application session. Separate model-service credentials and advice generation are future work; no observations are currently sent to an external model.

## Deployment and maintenance

Follow [deployment preparation](../docs/DEPLOYMENT.md). Templates are examples, not a live server configuration. Production requires HTTPS and private OSS. The adapter currently uses the Chengdu region; select public or internal endpoints appropriate to your host.

`node preflight-oss.mjs` checks a unique test object without opening the database or collector. `node manage.mjs backup` writes a consistent SQLite snapshot to the selected object store; the service also schedules daily backups. Keep object archives/media as well as database backups, and verify restore separately.

`node manage.mjs import-legacy <file.json>` imports the old cloud JSON array (up to 10,000 rows), idempotently, into an existing administrator's unassigned legacy data. Set `SAMA_ADMIN_USERNAME`; historical plant identities are not guessed.

Run `npm test` here for the nine warehouse tests; root tests cover the LAN application. See [validation scope](../docs/VALIDATION.md).
