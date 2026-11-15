import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function run(origin, messages, env = {}, cwd, wrapper = []) {
  const [command, ...args] = [...wrapper, process.execPath, binary];
  const child = spawn(command, args, {
    env: { ...process.env, PROOFLINE_TOKEN: token, PROOFLINE_BASE_URL: origin, PROOFLINE_MCP_TRACE: undefined, ...env },
    cwd, stdio: ["pipe", "pipe", "pipe"],
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

function cli(...args) {
  const { status, stdout, stderr } = spawnSync(process.execPath, [binary, ...args], { encoding: "utf8" });
  return { status, stdout, stderr };
}

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), "proofline-mcp-trace-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const entries = (file) => readFileSync(file, "utf8").trimEnd().split("\n").map(JSON.parse);
const size = (message) => message ? Buffer.byteLength(JSON.stringify(message)) : 0;

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
  for (const input of ["{\n", " ".repeat(8193) + "\n", JSON.stringify(initialize), "[]\n"]) {
    const outcome = await run(fixture.origin, input);
    assert.equal(outcome.code, 1);
    assert.equal(outcome.responses.length, 1);
  }
  const early = await run(fixture.origin, [call]);
  assert.equal(early.code, 0, "a lifecycle refusal is not fatal");
  assert.equal(early.responses[0].error.data.category, "lifecycle");
  assert.equal(fixture.requests.length, 0);
  for (const env of [{ PROOFLINE_TOKEN: "" }, { PROOFLINE_BASE_URL: "http://example.com" }, { PROOFLINE_BASE_URL: "https://user:private-upstream-canary@example.com" }]) {
    const outcome = await run(fixture.origin, "", env);
    assert.equal(outcome.code, 1);
    assert.equal(outcome.responses.length, 0);
    assert.ok(!outcome.stderr.includes("private-upstream-canary"));
  }
});

test("pre-initialize probes are answered without ending the session", async (t) => {
  const tools = { tools: [] };
  const fixture = await server(t, (body, response) => json(response, { jsonrpc: "2.0", id: body.id, result: tools }));
  const outcome = await run(fixture.origin, [
    { jsonrpc: "2.0", id: "server-discover-probe-1", method: "server/discover" },
    { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "server-discover-probe-1" } },
    { jsonrpc: "2.0", id: "early-ping", method: "ping" },
    initialize, notification, { jsonrpc: "2.0", id: 3, method: "tools/list" },
  ]);
  assert.equal(outcome.code, 0);
  assert.equal(outcome.stderr, "");
  assert.equal(outcome.responses.length, 4);
  assert.equal(outcome.responses[0].id, "server-discover-probe-1");
  assert.equal(outcome.responses[0].error.code, -32000);
  assert.equal(outcome.responses[0].error.data.category, "lifecycle");
  assert.deepEqual(outcome.responses[1], { jsonrpc: "2.0", id: "early-ping", result: {} });
  assert.equal(outcome.responses[2].id, "init");
  assert.deepEqual(outcome.responses[3], { jsonrpc: "2.0", id: 3, result: tools });
  assert.deepEqual(fixture.requests.map((request) => request.method), ["initialize", "notifications/initialized", "tools/list"]);
});

test("an opt-in trace records the method, tool, outcome, wait and sizes of every message", async (t) => {
  const trace = join(temporary(t), "trace.jsonl");
  const tools = { tools: [{ name: "request_reverification", inputSchema: { type: "object" } }] };
  const fixture = await server(t, (body, response) => {
    if (body.id === 10) { response.writeHead(503); return response.end("private-upstream-canary"); }
    const answer = () => json(response, { jsonrpc: "2.0", id: body.id, ...(body.id === 9 ?
      { error: { code: -32602, message: "private-upstream-canary" } } :
      { result: body.method === "tools/list" ? tools : { content: [], isError: body.id === 8 } }) });
    if (body.id === 7) setTimeout(answer, 60); else answer();
  });
  const messages = [
    { jsonrpc: "2.0", id: "probe", method: "server/discover" },
    { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "probe" } },
    { jsonrpc: "2.0", id: "early-ping", method: "ping" },
    initialize, notification, { jsonrpc: "2.0", id: 3, method: "tools/list" },
    call, { ...call, id: 8 }, { ...call, id: 9, params: { name: "n".repeat(128) } }, { ...call, id: 10 },
  ];
  const started = Date.now();
  const outcome = await run(fixture.origin, messages, { PROOFLINE_MCP_TRACE: trace });
  assert.equal(outcome.code, 1, "the HTTP refusal ends the session, as it does without a trace");
  const lines = entries(trace);
  assert.deepEqual(lines.map(({ time, duration_ms, ...rest }) => rest), [
    { method: "server/discover", outcome: "refused" },
    { method: "notifications/cancelled", outcome: "refused" },
    { method: "ping", outcome: "ok" },
    { method: "initialize", outcome: "ok" },
    { method: "notifications/initialized", outcome: "ok" },
    { method: "tools/list", outcome: "ok" },
    { method: "tools/call", tool: "request_reverification", outcome: "ok" },
    { method: "tools/call", tool: "request_reverification", outcome: "tool_error" },
    { method: "tools/call", tool: "n".repeat(128), outcome: "rpc_error", rpc_code: -32602 },
    { method: "tools/call", tool: "request_reverification", outcome: "http", http_status: 503 },
  ].map((expected, index) => ({ ...expected, request_bytes: size(messages[index]),
    response_bytes: size(outcome.responses.find((response) => response.id === messages[index].id)) })));
  assert.match(readFileSync(trace, "utf8"), /^\{"time":"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z","method":"server\/discover","outcome":"refused","duration_ms":0,"request_bytes":\d+,"response_bytes":\d+\}\n/);
  assert.ok(lines.every((line) => Date.parse(line.time) >= started && Date.parse(line.time) <= Date.now()));
  assert.ok(lines.every((line) => Number.isSafeInteger(line.duration_ms) && line.duration_ms >= 0));
  assert.deepEqual(lines.slice(0, 3).map((line) => line.duration_ms), [0, 0, 0], "nothing was forwarded");
  assert.ok(lines[6].duration_ms >= 50, "the wait on the server is measured");
  if (process.platform !== "win32") assert.equal(statSync(trace).mode & 0o777, 0o600);
  assert.deepEqual(await run(fixture.origin, messages), outcome, "the trace changes nothing the agent sees");
  assert.equal(entries(trace).length, 10);
  await run(fixture.origin, messages, { PROOFLINE_MCP_TRACE: trace });
  assert.equal(entries(trace).length, 20, "a later session appends to the same file");
});

test("the trace names the failure category of input that is not a request", async (t) => {
  const trace = join(temporary(t), "trace.jsonl");
  const fixture = await server(t, () => assert.fail("unexpected request"));
  for (const input of ["{\n", "[]\n", " ".repeat(8193) + "\n"]) await run(fixture.origin, input, { PROOFLINE_MCP_TRACE: trace });
  assert.deepEqual(entries(trace).map(({ time, response_bytes, ...rest }) => rest), [
    { outcome: "jsonrpc", duration_ms: 0, request_bytes: 1 },
    { outcome: "jsonrpc", duration_ms: 0, request_bytes: 2 },
    { outcome: "input", duration_ms: 0 },
  ]);
  assert.equal(fixture.requests.length, 0);
});

test("sessions that share a trace file append whole lines", async (t) => {
  const trace = join(temporary(t), "trace.jsonl");
  const fixture = await server(t, () => assert.fail("unexpected request"));
  const probes = Array.from({ length: 100 }, (_, id) => ({ jsonrpc: "2.0", id, method: "server/discover" }));
  await Promise.all(Array.from({ length: 4 }, () => run(fixture.origin, probes, { PROOFLINE_MCP_TRACE: trace })));
  assert.equal(entries(trace).filter((line) => line.outcome === "refused").length, 400);
});

test("the trace never holds the token, parameters, results, ids or upstream text", async (t) => {
  const trace = join(temporary(t), "trace.jsonl");
  const secrets = { review_id: "canary-argument", commit_sha: "c".repeat(40), finding_ids: ["canary-finding"] };
  const fixture = await server(t, (body, response) => {
    if (body.id === "canary-id-4") { response.writeHead(403, { "X-Canary": "canary-header" }); return response.end("canary-body"); }
    json(response, { jsonrpc: "2.0", id: body.id, ...(body.id === "canary-id-2" ?
      { error: { code: -32602, message: "canary-error", data: { detail: "canary-data" } } } :
      { result: { content: [{ type: "text", text: "canary-result" }], structuredContent: { status: "canary-status" } } }) });
  });
  const outcome = await run(fixture.origin, [initialize, notification,
    { jsonrpc: "2.0", id: "canary-id-1", method: "tools/call", params: { name: "request_reverification", arguments: secrets, _meta: { progressToken: "canary-meta" } } },
    { jsonrpc: "2.0", id: "canary-id-2", method: "tools/call", params: { name: "canary-name-" + "x".repeat(117), arguments: secrets } },
    { jsonrpc: "2.0", id: "canary-id-3", method: "canary-method/" + "x".repeat(115), params: { name: "canary-not-a-tool" } },
    { jsonrpc: "2.0", id: "canary-id-4", method: "tools/call", params: { name: { text: "canary-object" }, arguments: secrets } },
  ], { PROOFLINE_MCP_TRACE: trace });
  assert.equal(outcome.code, 1);
  assert.equal(outcome.responses.length, 5, "the agent still receives every answer");
  const text = readFileSync(trace, "utf8");
  for (const secret of [token, "canary", secrets.commit_sha, "test-agent"]) assert.ok(!text.includes(secret), secret);
  assert.deepEqual(entries(trace).map((line) => [line.method, line.tool, line.outcome]), [
    ["initialize", undefined, "ok"], ["notifications/initialized", undefined, "ok"],
    ["tools/call", "request_reverification", "ok"], ["tools/call", undefined, "rpc_error"],
    [undefined, undefined, "ok"], ["tools/call", undefined, "http"],
  ]);
});

test("without PROOFLINE_MCP_TRACE no file is touched and no message changes", async (t) => {
  const directory = temporary(t);
  const fixture = await server(t, (body, response) => json(response, { jsonrpc: "2.0", id: body.id, result: {} }));
  for (const env of [{}, { PROOFLINE_MCP_TRACE: "" }]) {
    const outcome = await run(fixture.origin, [initialize, notification, call], env, directory);
    assert.deepEqual([outcome.code, outcome.stderr, outcome.responses.length], [0, "", 2]);
    const invalid = await run(fixture.origin, "", { ...env, PROOFLINE_TOKEN: "" }, directory);
    assert.equal(invalid.stderr, "Proofline MCP configuration invalid. Set PROOFLINE_TOKEN and use an HTTPS origin for PROOFLINE_BASE_URL.\n");
  }
  assert.deepEqual(readdirSync(directory), []);
});

test("a trace path that cannot be opened is a configuration failure before any request", async (t) => {
  const directory = temporary(t);
  const fixture = await server(t, () => assert.fail("unexpected request"));
  const paths = [join(directory, "missing", "trace.jsonl"), directory, ...(process.platform === "win32" ? [] : ["/dev/null", "/dev/stdout"])];
  for (const path of paths) {
    const outcome = await run(fixture.origin, [initialize, notification, call], { PROOFLINE_MCP_TRACE: path });
    assert.equal(outcome.code, 1);
    assert.equal(outcome.responses.length, 0, "nothing reaches stdout, the trace least of all");
    assert.equal(outcome.stderr, "Proofline MCP configuration invalid. Set PROOFLINE_TOKEN and use an HTTPS origin for PROOFLINE_BASE_URL. PROOFLINE_MCP_TRACE must name a regular file that can be appended to.\n");
  }
  assert.equal(fixture.requests.length, 0);
  assert.deepEqual(readdirSync(directory), []);
});

// A file size limit of zero lets the bridge open the trace and refuses every write to it.
const limit = ["sh", "-c", 'ulimit -f 0 && exec "$@"', "sh"];
const limited = process.platform !== "win32" && spawnSync(limit[0], [...limit.slice(1), "true"]).status === 0;

test("a trace write that fails stops the trace and nothing else", { skip: !limited }, async (t) => {
  const trace = join(temporary(t), "trace.jsonl");
  const tools = { tools: [] };
  const fixture = await server(t, (body, response) => json(response, { jsonrpc: "2.0", id: body.id, result: tools }));
  const outcome = await run(fixture.origin, [initialize, notification, { jsonrpc: "2.0", id: 3, method: "tools/list" }],
    { PROOFLINE_MCP_TRACE: trace }, undefined, limit);
  assert.equal(outcome.code, 0);
  assert.equal(outcome.stderr, "Proofline MCP trace failure. Tracing stopped.\n");
  assert.deepEqual(outcome.responses[1], { jsonrpc: "2.0", id: 3, result: tools });
  assert.equal(readFileSync(trace, "utf8"), "");
});

test("--trace-summary prints calls, failures and durations for each tool and method", (t) => {
  const directory = temporary(t);
  const file = join(directory, "trace.jsonl");
  const line = (method, tool, outcome, duration_ms) => JSON.stringify({
    time: "2026-01-01T00:00:00.000Z", method, tool, outcome, duration_ms, request_bytes: 1, response_bytes: 1 });
  writeFileSync(file, [
    line("initialize", undefined, "ok", 30),
    line("tools/call", "get_review_status", "ok", 40),
    "{not json",
    line("tools/call", "get_review_status", "http", 300),
    line("tools/call", "get_review_status", "ok", 80),
    "",
    line("tools/call", "request_reverification", "tool_error", 120),
    line("tools/call", "request_reverification", "ok", undefined),
    line("ping", undefined, "ok", 1) + " ".repeat(4096),
    line("tools/call", "bell\u0007", "ok", 5),
    line("server/discover", undefined, "refused", 0),
  ].join("\n"));
  assert.deepEqual(cli("--trace-summary", file), { status: 0, stderr: "", stdout: [
    "message                            calls  failures  median ms  max ms",
    "tools/call get_review_status           3         1         80     300",
    "tools/call bell\\u{7}                   1         0          5       5",
    "tools/call request_reverification      1         1        120     120",
    "initialize                             1         0         30      30",
    "server/discover                        1         1          0       0",
    "total                                  7         3         40     300",
    "3 malformed lines skipped.",
    "",
  ].join("\n") });
  assert.deepEqual(cli("--trace-summary", join(directory, "missing.jsonl")), {
    status: 1, stdout: "", stderr: "Proofline MCP trace summary failed: cannot read the file (ENOENT).\n" });
  writeFileSync(file, "{not json\n\n");
  assert.deepEqual(cli("--trace-summary", file), {
    status: 1, stdout: "", stderr: "Proofline MCP trace summary failed: no valid line in the file. 1 malformed line skipped.\n" });
  assert.match(cli("--help").stdout, /PROOFLINE_MCP_TRACE[^]*--trace-summary <file>/);
});
