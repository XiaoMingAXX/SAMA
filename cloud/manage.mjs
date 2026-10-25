import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Database } from "./lib/database.mjs";
import { createObjects } from "./lib/objects.mjs";
import { History } from "./lib/history.mjs";
import { check, passwordHash, token } from "./lib/common.mjs";
const root = path.dirname(fileURLToPath(import.meta.url)),
  directory = path.resolve(
    process.env.CLOUD_DATA_DIR ?? path.join(root, "data-v2"),
  );
const db = new Database(directory);
try {
  const command = process.argv[2];
  if (command === "create-admin") {
    check(
      process.env.SAMA_ADMIN_USERNAME && process.env.SAMA_ADMIN_PASSWORD,
      "Set SAMA_ADMIN_USERNAME and SAMA_ADMIN_PASSWORD in the local process environment.",
    );
    const user = await db.call("createUser", {
      bootstrap: true,
      input: {
        username: process.env.SAMA_ADMIN_USERNAME,
        name: process.env.SAMA_ADMIN_NAME ?? "Administrator",
      },
      hash: await passwordHash(process.env.SAMA_ADMIN_PASSWORD),
    });
    console.log(`Administrator created: ${user.username}`);
  } else if (command === "demo") {
    check(
      (await db.call("userCount")) === 0,
      "Demo initialization requires an empty local database.",
    );
    const password = token().slice(0, 24),
      user = await db.call("createUser", {
        bootstrap: true,
        input: { username: "local-admin", name: "Local administrator" },
        hash: await passwordHash(password),
      }),
      gateway = await db.call("createGateway", {
        user,
        input: { name: "Local simulated gateway", simulated: true },
        secret: token(),
      }),
      sensor = await db.call("createSensor", {
        user,
        input: {
          gatewayId: gateway.id,
          ownerId: user.id,
          name: "Demo soil probe",
          address: 2,
          intervalMs: 1000,
        },
      }),
      plant = await db.call("createPlant", {
        user,
        input: {
          name: "演示兰花 · Demo orchid",
          code: "DEMO-001",
          profile: {
            species: "Orchid (simulated)",
            location: "Local preview",
            substrate: "Demo only",
            notes: "本地模拟数据，用于体验流程，不代表真实植物。",
          },
        },
      });
    await db.call("bindSensor", {
      user,
      id: sensor.id,
      input: { plantId: plant.id },
    });
    await db.call("createRecording", {
      user,
      input: {
        sensorId: sensor.id,
        name: "Local demo recording",
        intervalMs: 5000,
      },
    });
    const credentials = path.join(directory, "preview-credentials.txt");
    fs.writeFileSync(
      credentials,
      `Local preview only\nUsername: ${user.username}\nPassword: ${password}\n`,
      { mode: 0o600 },
    );
    console.log(
      `Local simulated workspace created. Credentials: ${credentials}`,
    );
  } else if (command === "backup") {
    const objects = await createObjects(directory);
    console.log(
      JSON.stringify(await new History(db, objects, directory).backup()),
    );
  } else if (command === "import-legacy") {
    check(
      process.env.SAMA_ADMIN_USERNAME,
      "Set SAMA_ADMIN_USERNAME to the administrator receiving unassigned legacy data.",
    );
    const user = await db.call("loginUser", {
      name: process.env.SAMA_ADMIN_USERNAME,
    });
    check(user?.role === "admin", "Administrator required");
    const source = path.resolve(process.argv[3] ?? "");
    check(fs.statSync(source).isFile(), "A legacy JSON file is required");
    const rows = JSON.parse(fs.readFileSync(source, "utf8"));
    check(
      Array.isArray(rows) && rows.length <= 10000,
      "Expected the old cloud JSON array (up to 10,000 rows)",
    );
    console.log(JSON.stringify(await db.call("importLegacy", { user, rows })));
  } else
    throw new Error(
      "Commands: create-admin | demo | backup | import-legacy <source.json>",
    );
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
