import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const entry = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));

test("the registry entry says what an agent can do within the registry's limit", () => {
  const { description } = entry;
  assert.ok(description.length <= 100, `${description.length} characters`);
  assert.match(description, /^[^.]+\.$/);
  for (const capability of ["Set up Proofline", "read and change settings with admin approval", "read, request and fix reviews"]) {
    assert.ok(description.includes(capability), capability);
  }
  assert.doesNotMatch(description, /[a-z]_[a-z]|[a-z]:[a-z]|\d|`/);
  assert.doesNotMatch(description, /\b(?:agent|model)s? (?:can |may )?(?:approve|authori[sz]e)/i);
});

test("the registry entry names the hosted endpoint", () => {
  assert.match(entry.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(entry.remotes, [{ type: "streamable-http", url: "https://proofline.sh/mcp" }]);
});
