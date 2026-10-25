# Deployment preparation

These are portable examples. The public repository contains no live addresses, certificates, deployment credentials or production datasets.

## Isolate the application

Use a dedicated release directory, data directory, Compose project and object-store identity. Inventory existing services first. Reserve unused ports and apply changes only to the new application. The example Compose project is `sama-warehouse`, with HTTP bound to `127.0.0.1:18890` and gateway TCP to `127.0.0.1:18898`. Check for collisions before running it; do not run global Docker cleanup or change unrelated database/network volumes.

Use a supported Node 24 runtime with SQLite 3.51.3+. The Dockerfile builds dependencies with npm and copies the runtime into a non-root minimal image. Compose limits memory/CPU/PIDs, drops capabilities, uses a read-only root filesystem and rotates logs. Prepare the dedicated writable data directory for UID/GID 1001.

## Private OSS and credentials

1. Create a private Chengdu bucket with public access blocked. The current adapter is configured for this region.
2. Create a dedicated RAM identity. Copy `cloud/deploy/oss-ram-policy.example.json` and replace `YOUR_PRIVATE_BUCKET`. It grants Get/Put only under `soil-studio/`, with Delete only for media, exports and preflight objects; archives/backups do not receive deletion rights.
3. Store `accessKeyId` and `accessKeySecret` in a protected JSON file outside Git. The Windows `prepare-oss-secret.ps1` helper prompts without echoing secrets and restricts local ACLs. Mount the file with the Compose secret setting `SAMA_OSS_CREDENTIALS_FILE`. Never paste keys into issues or commits.
4. Set `OSS_BUCKET`, `SAMA_OBJECT_STORE=oss`, `OSS_ENDPOINT` and `OSS_CREDENTIALS_FILE` in the application environment. Use the internal endpoint only when the host network can reach it; use the public Chengdu endpoint for an external host. Do not mix file credentials with an ECS RAM role.
5. With the selected environment, run `node cloud/preflight-oss.mjs`. It tests a uniquely named object for upload, metadata, authenticated read, anonymous denial and cleanup. This command intentionally writes that test object.

Configure a seven-day lifecycle only for `soil-studio/exports/`. Decide archive/media/backup retention separately. Applying a short expiration rule to the entire prefix would break history and restore. Since authenticated application routes proxy access, no public bucket ACL, browser CORS or CDN is required for the current version.

## HTTPS and application settings

Copy `cloud/deploy/production.env.example` to an ignored local configuration and set a real `SAMA_PUBLIC_ORIGIN`. Use a domain with a trusted certificate, or a trusted IP certificate supported by your certificate provider. Production requires HTTPS; do not simply change the origin to public HTTP.

Review `cloud/deploy/nginx.example.conf` as a dedicated site, replace hostname/certificate paths and validate nginx configuration before reloading. Preserve the Host header for origin checks and disable proxy buffering for SSE. Provision certificate renewal separately.

From `cloud/`, build/start the dedicated service with Docker Compose and the production environment file. Inspect its health and logs before opening public access. Create the first administrator through `manage.mjs create-admin` in the same workspace/environment; self-registration never bootstraps an administrator. Clear bootstrap secrets afterwards.

## Gateway onboarding is a separate step

Create a gateway and sensor as administrator, grant the sensor to an account and bind a plant. Update the physical gateway with the generated registration packet only during a planned hardware check. Legacy `LOAM:` registrations are not automatically claimed by the new service.

The gateway protocol is plaintext TCP. Keep its listener private and arrange a protected network path before remote deployment. The example does not expose this port publicly or implement a VPN/TLS tunnel. Confirm the real firmware accepts the packet and verify fresh measurements after reconnecting. Deploying the website alone does not complete hardware acceptance.

## Backup, restore and updates

`node manage.mjs backup` creates a consistent database snapshot in the selected object store. The service also schedules daily backups. Preserve archives/media alongside database backups and test restoration on an isolated copy, including ownership, sample counts and referenced objects.

For each update, back up, build a new immutable image, run tests, migrate only the application's workspace, check health and verify login/history/export. Keep the previous image and a compatible recovery snapshot. Do not run old code against a newer database without checking schema compatibility. High-frequency hardware and concurrent photo workloads need capacity testing on the target machine.
