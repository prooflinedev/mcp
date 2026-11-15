import { once } from "node:events";

export const PROTOCOL = "2025-11-25";
const REQUEST_LIMIT = 8192;
const RESPONSE_LIMIT = 8 * 1024 * 1024;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value) => typeof value === "string" || Number.isSafeInteger(value);

class BridgeError extends Error {
  constructor(category, code = -32000, status) {
    super(`Proofline MCP ${category} failure${status ? ` (HTTP ${status})` : ""}.`);
    this.category = category;
    this.code = code;
    this.status = status;
  }
}

export function configuration(env) {
  const token = env.PROOFLINE_TOKEN;
  if (!token || /[\s\x00-\x1f\x7f]/u.test(token)) {
    throw new BridgeError("configuration: set PROOFLINE_TOKEN");
  }
  const raw = env.PROOFLINE_BASE_URL ?? "https://proofline.sh";
  let origin;
  try { origin = new URL(raw); } catch { throw new BridgeError("configuration: invalid origin"); }
  if (raw !== raw.trim() || origin.username || origin.password || origin.search || origin.hash ||
      origin.pathname !== "/" ||
      !(origin.protocol === "https:" || (origin.protocol === "http:" &&
        ["127.0.0.1", "[::1]"].includes(origin.hostname)))) {
    throw new BridgeError("configuration: require an HTTPS origin or loopback IP");
  }
  return { token, origin: origin.origin };
}

async function* frames(input) {
  let pending = Buffer.alloc(0);
  for await (const chunk of input) {
    let bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    while (bytes.length) {
      const newline = bytes.indexOf(10);
      const end = newline === -1 ? bytes.length : newline;
      if (pending.length + end > REQUEST_LIMIT) throw new BridgeError("input", -32600);
      pending = Buffer.concat([pending, bytes.subarray(0, end)]);
      if (newline === -1) break;
      yield pending;
      pending = Buffer.alloc(0);
      bytes = bytes.subarray(newline + 1);
    }
  }
  if (pending.length) throw new BridgeError("input", -32600);
}

async function send(output, message) {
  const line = `${JSON.stringify(message)}\n`;
  if (!output.write(line)) await once(output, "drain");
  return Buffer.byteLength(line) - 1;
}

async function post(frame, config, protocol, notification) {
  let response;
  try {
    response = await fetch(`${config.origin}/mcp`, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Origin: config.origin,
        ...(protocol ? { "MCP-Protocol-Version": protocol } : {}),
      },
      body: frame,
    });
    if (response.status !== (notification ? 202 : 200)) {
      await response.body?.cancel();
      throw new BridgeError("http", -32000, response.status);
    }
    if (response.headers.has("mcp-session-id") || (!notification &&
        response.headers.get("content-type")?.split(";")[0].trim() !== "application/json")) {
      await response.body?.cancel();
      throw new BridgeError("transport");
    }
    const chunks = [];
    let size = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > (notification ? 0 : RESPONSE_LIMIT)) throw new BridgeError("response");
        chunks.push(chunk);
      }
    }
    if (notification) return;
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch { throw new BridgeError("response"); }
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("transport");
  }
}

function failure(error, id) {
  return { jsonrpc: "2.0", id, error: {
    code: error.code, message: error.message,
    data: { category: error.category, ...(error.status ? { http_status: error.status } : {}) },
  } };
}

/** Serial, bounded bridge for Proofline's stateless JSON MCP endpoint. Never retries. */
export async function bridge(input, output, diagnostic, config, trace) {
  let protocol;
  let ready = false;
  let id = null;
  let notification = false;
  let entry = {};
  // Traces the message in hand once it is answered: what was asked and how it
  // ended, never parameters, results, ids or upstream text. A trace that fails
  // stops, and the session goes on.
  const record = (outcome, detail) => {
    try {
      trace?.({ ...entry, outcome, ...detail });
    } catch {
      trace = undefined;
      diagnostic.write("Proofline MCP trace failure. Tracing stopped.\n");
    }
    entry = {};
  };
  try {
    for await (const frame of frames(input)) {
      entry.request_bytes = frame.length;
      let request;
      try {
        request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
      } catch { throw new BridgeError("jsonrpc", -32700); }
      if (!object(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string" ||
          !request.method || "result" in request || "error" in request ||
          ("id" in request && !identity(request.id)) ||
          ("params" in request && !object(request.params) && !Array.isArray(request.params))) {
        throw new BridgeError("jsonrpc", -32600);
      }
      notification = !("id" in request);
      id = notification ? null : request.id;
      entry.method = request.method;
      if (request.method === "tools/call") entry.tool = request.params?.name;
      const initializing = request.method === "initialize";
      const initialized = request.method === "notifications/initialized";
      if (initializing ? protocol || notification :
          initialized ? !protocol || ready || !notification :
          !ready && !(protocol && request.method === "ping" && !notification)) {
        // A client may probe before the handshake, as Claude Code does with
        // `server/discover`. Refuse that message and keep the session. MCP
        // allows `ping` at any time, but the server refuses requests without
        // a negotiated version, so an early ping is answered here.
        const pong = !notification && !protocol && request.method === "ping";
        if (!notification) {
          entry.response_bytes = await send(output, pong ?
            { jsonrpc: "2.0", id, result: {} } : failure(new BridgeError("lifecycle"), id));
        }
        record(pong ? "ok" : "refused");
        id = null;
        notification = false;
        continue;
      }
      const started = performance.now();
      const response = await post(frame, config, protocol, notification)
        .finally(() => { entry.duration_ms = Math.round(performance.now() - started); });
      if (!notification) {
        if (!object(response) || response.jsonrpc !== "2.0" || response.id !== id ||
            ("result" in response) === ("error" in response) ||
            ("result" in response && !object(response.result)) ||
            ("error" in response && (!object(response.error) || !Number.isInteger(response.error.code) ||
              typeof response.error.message !== "string"))) {
          throw new BridgeError("response");
        }
        if (initializing && "result" in response) {
          if (response.result.protocolVersion !== PROTOCOL) throw new BridgeError("lifecycle");
          protocol = PROTOCOL;
        }
        entry.response_bytes = await send(output, response);
      }
      if (initialized) ready = true;
      record(response?.error ? "rpc_error" : response?.result.isError === true ? "tool_error" : "ok",
        { rpc_code: response?.error?.code });
      id = null;
      notification = false;
    }
    return 0;
  } catch (error) {
    const safe = error instanceof BridgeError ? error : new BridgeError("transport");
    if (!notification) {
      try {
        entry.response_bytes = await send(output, failure(safe, id));
      } catch { /* A closed output cannot receive the failure. */ }
    }
    record(safe.category, { http_status: safe.status });
    diagnostic.write(`${safe.message}\n`);
    return 1;
  }
}
