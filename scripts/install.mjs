import { spawnSync } from "node:child_process";

// TCP-only installations do not require a compiler or the KoutenDB library.
if (process.env.KOUTENDB_BUILD_NATIVE === "1") {
  const result = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "build:native"],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
  process.exit(result.status ?? 1);
}
