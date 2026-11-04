import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

const [mode, directory] = process.argv.slice(2);
if (!["select", "verify"].includes(mode) || !directory) {
  throw new Error("Expected select or verify and a package directory");
}
const { name, version } = JSON.parse(await readFile("package.json", "utf8"));
const [filename, ...other] = await readdir(directory);
if (
  !/^\d+\.\d+\.\d+$/.test(version) ||
  filename !== `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz` ||
  other.length
) {
  throw new Error("Expected one tarball for the checked package version");
}
const data = await readFile(join(directory, filename));
const integrity = `sha512-${createHash("sha512").update(data).digest("base64")}`;
const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`;

async function published() {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`npm lookup returned HTTP ${response.status}`);
  const metadata = await response.json();
  if (metadata.name !== name || metadata.version !== version || metadata.dist?.integrity !== integrity) {
    throw new Error("Published npm tarball differs from the checked release");
  }
  return true;
}

if (mode === "select") {
  console.log((await published()) ? "present" : "missing");
} else {
  for (let attempt = 0; !(await published()); attempt++) {
    if (attempt === 5) throw new Error("Published npm tarball is missing");
    await setTimeout(5000);
  }
}
