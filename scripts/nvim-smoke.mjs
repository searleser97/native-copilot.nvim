import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const script of ["nvim_smoke.lua", "nvim_ui_smoke.lua"]) {
  const result = spawnSync("nvim", ["--headless", "--clean", "-l", resolve(root, "test", script)], {
    cwd: root,
    env: { ...process.env, NATIVE_COPILOT_ROOT: root },
    encoding: "utf8",
    windowsHide: true,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${script} failed with exit code ${result.status}`);
  }
}
