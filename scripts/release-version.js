import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(version) ||
    !["refs/heads/main", `refs/tags/v${version}`].includes(process.env.GITHUB_REF)) {
  throw new Error("Release requires main or a tag matching the package version.");
}
execFileSync("git", ["fetch", "--quiet", "origin", "main"], { stdio: "inherit" });
execFileSync("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"], { stdio: "inherit" });
console.log(`Release version: ${version}`);
