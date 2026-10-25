import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createObjects } from "../lib/objects.mjs";

test("OSS adapter uses a credential file, signed requests and verified object lifecycle", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sama-oss-sdk-"));
  const items = new Map(),
    methods = [];
  const server = http.createServer(async (req, res) => {
    try {
      assert.match(req.headers.authorization, /^OSS4-HMAC-SHA256 /);
      methods.push(req.method);
      const key = req.url;
      if (req.method === "PUT") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        assert.equal(req.headers["x-oss-object-acl"], "private");
        items.set(key, {
          data: Buffer.concat(chunks),
          hash: req.headers["x-oss-meta-sha256"],
        });
        res.setHeader("ETag", '"local-test"');
        res.end();
      } else if (req.method === "DELETE") {
        items.delete(key);
        res.writeHead(204).end();
      } else {
        const item = items.get(key);
        if (!item) return res.writeHead(404).end();
        res.setHeader("x-oss-meta-sha256", item.hash);
        res.setHeader("Content-Length", item.data.length);
        res.end(req.method === "HEAD" ? undefined : item.data);
      }
    } catch {
      res.writeHead(500).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const credentialFile = path.join(directory, "credentials.json");
  await fs.writeFile(
    credentialFile,
    JSON.stringify({
      accessKeyId: "test-only-id",
      accessKeySecret: "test-only-secret",
    }),
  );
  const env = {
    SAMA_OBJECT_STORE: "oss",
    OSS_BUCKET: "test-only-bucket",
    OSS_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
    OSS_CREDENTIALS_FILE: credentialFile,
  };
  const objects = await createObjects(directory, env);
  const file = path.join(directory, "sample.txt");
  await fs.writeFile(file, "verified local SDK test");
  const key = "soil-studio/preflight/test.txt";
  assert.deepEqual(await objects.put(key, file), { bytes: 23 });
  const chunks = [];
  for await (const chunk of await objects.stream(key)) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), "verified local SDK test");
  await objects.remove(key);
  assert.equal(items.size, 0);
  assert.deepEqual(methods, ["PUT", "HEAD", "GET", "DELETE"]);
  await assert.rejects(
    () =>
      createObjects(directory, { ...env, OSS_RAM_ROLE_NAME: "cannot-combine" }),
    /either/,
  );
  await fs.writeFile(credentialFile, "invalid json");
  await assert.rejects(() => createObjects(directory, env), /parse OSS/);
});
