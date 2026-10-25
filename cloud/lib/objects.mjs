import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID, createHash } from "node:crypto";
import OSS from "ali-oss";
import { check } from "./common.mjs";
export async function fileDigest(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
export class LocalObjects {
  constructor(directory) {
    this.directory = path.resolve(directory);
    fs.mkdirSync(this.directory, { recursive: true });
    this.kind = "local";
  }
  target(key) {
    check(
      /^soil-studio\/[a-zA-Z0-9_./-]+$/.test(key) &&
        !key.split("/").includes(".."),
      "Invalid object key",
    );
    const resolved = path.resolve(this.directory, key);
    check(
      resolved.startsWith(this.directory + path.sep),
      "Invalid object path",
    );
    return resolved;
  }
  async put(key, file, { sha256 } = {}) {
    const destination = this.target(key);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await pipeline(
        fs.createReadStream(file),
        fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      );
      if (sha256)
        check(
          (await fileDigest(temporary)) === sha256,
          "Object checksum mismatch",
          502,
        );
      await fsp.rename(temporary, destination);
    } finally {
      await fsp.rm(temporary, { force: true });
    }
    return { bytes: (await fsp.stat(destination)).size };
  }
  async stream(key) {
    const file = this.target(key);
    await fsp.access(file);
    return fs.createReadStream(file);
  }
  async remove(key) {
    await fsp.rm(this.target(key), { force: true });
  }
}
async function roleCredentials(name) {
  const endpoint = "http://100.100.100.200/latest/";
  const r = await fetch(endpoint + "api/token", {
    method: "PUT",
    headers: { "X-aliyun-ecs-metadata-token-ttl-seconds": "300" },
    signal: AbortSignal.timeout(3000),
  });
  check(r.ok, "ECS metadata token unavailable", 503);
  const token = await r.text();
  const response = await fetch(
    endpoint + "meta-data/ram/security-credentials/" + encodeURIComponent(name),
    {
      headers: { "X-aliyun-ecs-metadata-token": token },
      signal: AbortSignal.timeout(3000),
    },
  );
  check(response.ok, "ECS RAM credentials unavailable", 503);
  const value = await response.json();
  check(
    value.Code === "Success" &&
      value.AccessKeyId &&
      value.AccessKeySecret &&
      value.SecurityToken,
    "Invalid ECS role credentials",
    503,
  );
  return {
    accessKeyId: value.AccessKeyId,
    accessKeySecret: value.AccessKeySecret,
    stsToken: value.SecurityToken,
  };
}
export async function createObjects(directory, env = process.env) {
  if (env.SAMA_OBJECT_STORE !== "oss")
    return new LocalObjects(path.join(directory, "objects"));
  const role = env.OSS_RAM_ROLE_NAME;
  let fileCredentials;
  if (env.OSS_CREDENTIALS_FILE) {
    check(!role, "Choose either an OSS credential file or ECS RAM role");
    const stat = await fsp.stat(env.OSS_CREDENTIALS_FILE);
    check(stat.isFile() && stat.size <= 8192, "Invalid OSS credential file");
    let value;
    try {
      value = JSON.parse(await fsp.readFile(env.OSS_CREDENTIALS_FILE, "utf8"));
    } catch {
      throw new Error("Unable to parse OSS credential file");
    }
    check(
      typeof value.accessKeyId === "string" &&
        typeof value.accessKeySecret === "string" &&
        value.accessKeyId.length > 0 &&
        value.accessKeySecret.length > 0,
      "OSS credential file requires accessKeyId and accessKeySecret",
    );
    fileCredentials = {
      accessKeyId: value.accessKeyId,
      accessKeySecret: value.accessKeySecret,
      ...(value.securityToken ? { stsToken: value.securityToken } : {}),
    };
  }
  const credentials = role
    ? await roleCredentials(role)
    : (fileCredentials ?? {
        accessKeyId: env.OSS_ACCESS_KEY_ID,
        accessKeySecret: env.OSS_ACCESS_KEY_SECRET,
        stsToken: env.OSS_SECURITY_TOKEN,
      });
  check(
    credentials.accessKeyId && credentials.accessKeySecret,
    "Configure dedicated OSS credentials or an ECS RAM role",
  );
  check(env.OSS_BUCKET, "OSS_BUCKET is required");
  const client = new OSS({
    region: "oss-cn-chengdu",
    endpoint:
      env.OSS_ENDPOINT || "https://oss-cn-chengdu-internal.aliyuncs.com",
    bucket: env.OSS_BUCKET,
    authorizationV4: true,
    secure: true,
    timeout: 30000,
    ...credentials,
    ...(role
      ? {
          refreshSTSToken: () => roleCredentials(role),
          refreshSTSTokenInterval: 60000,
        }
      : {}),
  });
  return {
    kind: "oss",
    async put(key, file, { sha256, type = "application/octet-stream" } = {}) {
      check(key.startsWith("soil-studio/"), "Invalid object prefix");
      const bytes = (await fsp.stat(file)).size;
      const hash = sha256 || (await fileDigest(file));
      await client.put(key, file, {
        mime: type,
        meta: { sha256: hash },
        headers: { "x-oss-object-acl": "private" },
      });
      const head = await client.head(key);
      check(
        head.status === 200 && head.meta?.sha256 === hash,
        "OSS verification failed",
        502,
      );
      return { bytes };
    },
    async stream(key) {
      check(key.startsWith("soil-studio/"), "Invalid object prefix");
      return (await client.getStream(key)).stream;
    },
    async remove(key) {
      check(key.startsWith("soil-studio/"), "Invalid object prefix");
      await client.delete(key);
    },
  };
}
