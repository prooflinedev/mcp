import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const temporary = mkdtempSync(join(tmpdir(), "proofline-mcp-pack-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
try {
  execFileSync(npm, ["pack", "--ignore-scripts", "--pack-destination", temporary], { stdio: "inherit" });
  const archive = readdirSync(temporary).find((name) => name.endsWith(".tgz"));
  if (!archive) throw new Error("npm pack produced no archive");
  execFileSync(npm, ["install", "--prefix", temporary, "--ignore-scripts", "--no-audit", "--no-fund", join(temporary, archive)], { stdio: "inherit" });
  const binary = join(temporary, "node_modules", "@proofline", "mcp", "src", "cli.js");
  execFileSync(process.execPath, ["--test", resolve("tests/bridge.test.js")], {
    stdio: "inherit", env: { ...process.env, PROOFLINE_MCP_TEST_BIN: binary },
  });
  execFileSync(process.execPath, [binary, "--version"], { stdio: "inherit" });
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
