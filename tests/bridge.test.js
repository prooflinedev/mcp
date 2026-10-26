import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

const binary = process.env.PROOFLINE_MCP_TEST_BIN ?? fileURLToPath(new URL("../src/cli.js", import.meta.url));
const token = "test-token-never-print";
const protocol = "2025-11-25";
const initialize = { jsonrpc: "2.0", id: "init", method: "initialize", params: {
  protocolVersion: protocol, capabilities: {}, clientInfo: { name: "test-agent", version: "1" },
} };
const notification = { jsonrpc: "2.0", method: "notifications/initialized" };
const call = { jsonrpc: "2.0", id: 7, method: "tools/call", params: {
  name: "request_reverification", arguments: { review_id: "review", commit_sha: "a".repeat(40), finding_ids: ["finding"] },
} };
const json = (response, value) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };

async function server(t, responder) {
  const requests = [];
  const http = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    assert.equal(request.url, "/mcp");
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    assert.equal(request.headers.origin, origin);
    if (body.method === "initialize") {
      assert.equal(request.headers["mcp-protocol-version"], undefined);
      return json(response, { jsonrpc: "2.0", id: body.id, result: { protocolVersion: protocol, capabilities: { tools: {} } } });
    }
    assert.equal(request.headers["mcp-protocol-version"], protocol);
    if (body.method === "notifications/initialized") { response.writeHead(202); return response.end(); }
    responder(body, response);
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const origin = `http://127.0.0.1:${http.address().port}`;
  t.after(() => { http.closeAllConnections(); http.close(); });
  return { origin, requests };
}

async function run(origin, messages, env = {}) {
  const child = spawn(process.execPath, [binary], {
    env: { ...process.env, PROOFLINE_TOKEN: token, PROOFLINE_BASE_URL: origin, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.on("error", () => {});
  child.stdin.end(typeof messages === "string" ? messages : messages.map((message) => JSON.stringify(message) + "\n").join(""));
  const [code] = await once(child, "close");
  assert.ok(!stdout.includes(token) && !stderr.includes(token));
  return { code, stderr, responses: stdout.trim() ? stdout.trim().split("\n").map(JSON.parse) : [] };
}

test("packed stdio bridge preserves tools, untrusted results, incomplete status and tool refusals", async (t) => {
  const result = { content: [{ type: "text", text: '{"untrusted_text":"literal\\ntext"}' }],
    structuredContent: { status: "UNAVAILABLE", items: null, reason: "INCOMPLETE" }, isError: true };
  const tools = { tools: [{ name: "request_reverification", inputSchema: { type: "object" }, annotations: { readOnlyHint: false }, _meta: { untrustedContentHint: true } }] };
  const fixture = await server(t, (body, response) => json(response, {
    jsonrpc: "2.0", id: body.id, result: body.method === "tools/list" ? tools : result,
  }));
  const outcome = await run(fixture.origin, [initialize, notification, { jsonrpc: "2.0", id: 3, method: "tools/list" }, call]);
  assert.equal(outcome.code, 0);
  assert.equal(outcome.stderr, "");
  assert.equal(outcome.responses.length, 3);
  assert.deepEqual(outcome.responses[1].result, tools);
  assert.deepEqual(outcome.responses[2], { jsonrpc: "2.0", id: 7, result });
  assert.deepEqual(fixture.requests.at(-1), call);
});

test("HTTP refusals, redirects and malformed responses fail once without leaking bodies", async (t) => {
  for (const mode of ["503", "302", "wrong-id", "sse", "session", "oversize"]) {
    await t.test(mode, async (t) => {
      const fixture = await server(t, (body, response) => {
        if (mode === "503" || mode === "302") {
          response.writeHead(Number(mode), { Location: "https://must-not-follow.invalid", "Retry-After": "0" });
          return response.end("private-upstream-canary");
        }
        if (mode === "session") response.setHeader("MCP-Session-Id", "private-upstream-canary");
        if (mode === "sse") { response.writeHead(200, { "content-type": "text/event-stream" }); return response.end("private-upstream-canary"); }
        if (mode === "oversize") { response.writeHead(200, { "content-type": "application/json" }); return response.end("x".repeat(8 * 1024 * 1024 + 1)); }
        json(response, { jsonrpc: "2.0", id: mode === "wrong-id" ? 99 : body.id, result: { secret: "private-upstream-canary" } });
      });
      const outcome = await run(fixture.origin, [initialize, notification, call, call]);
      assert.equal(outcome.code, 1);
      assert.equal(outcome.responses.at(-1).id, 7);
      assert.equal(outcome.responses.at(-1).error.code, -32000);
      assert.equal(fixture.requests.length, 3);
      assert.ok(!JSON.stringify(outcome).includes("private-upstream-canary"));
    });
  }
});

test("invalid frames and lifecycle never reach the server", async (t) => {
  const fixture = await server(t, () => assert.fail("unexpected request"));
  for (const input of ["{\n", JSON.stringify(call) + "\n", " ".repeat(8193) + "\n", JSON.stringify(initialize), "[]\n"]) {
    const outcome = await run(fixture.origin, input);
    assert.equal(outcome.code, 1);
    assert.equal(outcome.responses.length, 1);
  }
  assert.equal(fixture.requests.length, 0);
  for (const env of [{ PROOFLINE_TOKEN: "" }, { PROOFLINE_BASE_URL: "http://example.com" }, { PROOFLINE_BASE_URL: "https://user:private-upstream-canary@example.com" }]) {
    const outcome = await run(fixture.origin, "", env);
    assert.equal(outcome.code, 1);
    assert.equal(outcome.responses.length, 0);
    assert.ok(!outcome.stderr.includes("private-upstream-canary"));
  }
});
