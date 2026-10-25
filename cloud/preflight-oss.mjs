// Explicit connectivity test: writes and removes one new object under preflight/.
// Does not open the database, start the collector, or touch existing objects.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createObjects } from "./lib/objects.mjs";
import { check } from "./lib/common.mjs";

check(process.env.SAMA_OBJECT_STORE === "oss", "SAMA_OBJECT_STORE must be oss");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "sama-oss-check-"));
const key = `soil-studio/preflight/${randomUUID()}.txt`;
let objects,
  attempted = false,
  failure = false;
try {
  objects = await createObjects(temporary);
  const payload = Buffer.from(`SAMA preflight ${randomUUID()}\n`);
  const file = path.join(temporary, "test.txt");
  await fs.writeFile(file, payload, { mode: 0o600 });
  attempted = true;
  await objects.put(key, file, { type: "text/plain" });
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of await objects.stream(key)) {
    bytes += chunk.length;
    check(bytes <= 4096, "Unexpected preflight response size");
    hash.update(chunk);
  }
  check(
    bytes === payload.length &&
      hash.digest("hex") === createHash("sha256").update(payload).digest("hex"),
    "OSS download verification failed",
  );
  console.log(
    "PASS: signed upload, HEAD metadata and streamed download verified.",
  );
  const endpoint = new URL(
    process.env.OSS_ENDPOINT || "https://oss-cn-chengdu-internal.aliyuncs.com",
  );
  endpoint.hostname = `${process.env.OSS_BUCKET}.${endpoint.hostname}`;
  endpoint.pathname = "/" + key;
  const anonymous = await fetch(endpoint, {
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  await anonymous.body?.cancel();
  check(
    anonymous.status === 403,
    "Anonymous access must return 403; review private bucket settings",
  );
  console.log("PASS: unsigned object access denied (403).");
} catch (error) {
  failure = true;
  // Never dump SDK request objects, headers, environment or credentials.
  const code = /^[A-Za-z0-9_-]+$/.test(error.code ?? "")
    ? error.code
    : "CHECK_FAILED";
  console.error(
    `FAIL: ${code}; HTTP status ${Number(error.status) || "unavailable"}. Review endpoint, RAM policy and bucket access settings.`,
  );
} finally {
  if (attempted && objects) {
    try {
      await objects.remove(key);
      console.log("PASS: preflight object removed.");
    } catch {
      failure = true;
      console.error(
        `FAIL: cleanup denied/unavailable; administrator should remove only ${key}`,
      );
    }
  }
  await fs.rm(temporary, { recursive: true, force: true });
  if (failure) process.exitCode = 1;
}
