import fs from "node:fs";
import path from "node:path";
import { check, token } from "./common.mjs";
// Only the collector holds this lock. Offline management/online backup use SQLite transactions.
export function acquireCollectorLock(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "collector.lock"),
    nonce = token();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce }));
      fs.closeSync(fd);
      return () => {
        try {
          if (JSON.parse(fs.readFileSync(file, "utf8")).nonce === nonce)
            fs.unlinkSync(file);
        } catch {}
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const previous = JSON.parse(fs.readFileSync(file, "utf8"));
      check(
        Number.isSafeInteger(previous.pid) && previous.pid > 0,
        "Invalid collector lock; inspect the local data directory",
        500,
      );
      let alive = true;
      try {
        process.kill(previous.pid, 0);
      } catch (e) {
        if (e.code === "ESRCH") alive = false;
      }
      check(
        !alive,
        "Another collector is already using this data directory",
        409,
      );
      fs.unlinkSync(file);
    }
  }
  throw new Error("Could not acquire the collector lock");
}
