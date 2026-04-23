import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCommand } from "../src/runtime.js";

test("resolveCommand finds executable fallback paths outside PATH", () => {
  const root = mkdtempSync(join(tmpdir(), "duo-runtime-"));
  const executable = join(root, "duo_fake_agent");
  writeFileSync(executable, "#!/usr/bin/env sh\nprintf ok\n", "utf8");
  chmodSync(executable, 0o755);

  assert.equal(resolveCommand("duo_fake_agent", [root]), executable);
});
