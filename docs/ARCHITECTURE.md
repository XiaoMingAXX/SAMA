# Observation warehouse architecture

The system is a single Node.js collector/web service, a worker-backed SQLite database and an object-store adapter. It is designed for a modest prototype deployment; a separate analytical warehouse cluster is not required at this stage.

## Identity and provenance

Accounts own plants, care events, photos and recorded observations. A gateway identifies a physical connection; a sensor identifies a probe on its Modbus bus. An administrator grants a time-bounded exclusive sensor lease to one account. That user binds the sensor to a plant. Reassignment closes existing bindings/recordings while preserving the original user's history.

A recording segment fixes the sensor, plant, owner, interval, stabilization and full-resolution choice. Readings retain source information and successful raw frames/registers where configured. Simulated readings are labelled; analysis snapshots exclude them by default.

## Collection and persistence

The gateway opens a TCP connection. The current packet is `SAMA:<gateway-id>:<secret>`; credentials are generated and rotated by an administrator. This is plaintext authentication, not encryption. Requests on a shared physical bus are serialized, with independent queues for separate gateways.

Actual successful readings enter SQLite before archival. Gzip NDJSON blocks are uploaded and verified; the database commits their manifest before eligible hot rows are cleaned. Unconfirmed uploads cannot justify sample removal. History/export jobs combine hot rows and archive manifests with bounded scan/output limits. A single-workspace lock prevents competing collectors.

Private OSS stores objects under `soil-studio/`. The prefix is retained for storage compatibility despite the public SAMA name. The current adapter uses `oss-cn-chengdu`. The development adapter implements the same object operations on local disk.

## Browser and later analysis

The browser uses session cookies, CSRF-checked mutations and owner-scoped server-sent events. Photos/downloads are proxied through the authenticated application; browser CORS access to the bucket is unnecessary. Photo processing strips EXIF and retains processed display/thumbnail images rather than original uploads.

`sama.plant-context.v1` snapshots capture a fixed range/cutoff, profile revisions, binding history, sensor metadata/units, summaries/series, care events, photo references and limitations. They are the input boundary for later model work. The repository does not yet implement model calls, separate service tokens, advice evaluation or automatic care actions.

## Recovery boundaries

SQLite runs in WAL mode with FULL synchronous writes. Daily consistent database backups are separate from immutable sample archives. Recovery needs both a suitable database snapshot and the referenced object set. Verify restore in an isolated directory and reconcile the backup cutoff before changing a live instance. Object retention must not delete referenced archives/media.

Storage guards reserve local disk and bound active database growth. They stop further recording when necessary; they do not fabricate gaps or silently declare failed samples archived. The current tests include low-space archival recovery and backup restoration.
