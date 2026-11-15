# Proofline MCP

[![Listed on clauderules.net](https://clauderules.net/api/badge/proofline-jano)](https://clauderules.net/mcp/proofline-jano)
[![AllMCPs Verified](https://allmcps.com/api/badge/proofline)](https://allmcps.com/mcp/proofline?verify=ba98ddfd-7072-4e8b-8a59-4d790121f66a)

Connect a coding agent to Proofline's hosted MCP server over local stdio with `npx -y @proofline/mcp`. The package requires Node.js 22 or later and needs no CLI installation or runtime dependencies. Agents with remote HTTP and OAuth support can connect directly to `https://proofline.sh/mcp` instead; this package supplies the local stdio option. See the [developer tools documentation](https://proofline.sh/docs/) for the hosted API.

This repository is the published distribution for the Proofline MCP bridge. The bridge discovers tools from the hosted MCP server at runtime. Pull requests are welcome for the hand-written bridge in `src/`, package scripts in `scripts/`, and tests in `tests/`. Open an [issue](https://github.com/prooflinedev/mcp/issues) for changes to the tool catalog, tool behavior, or workflows.

## Agent configuration

Add this entry to an agent's MCP configuration, such as Cursor's `.cursor/mcp.json` or Claude Code's `.mcp.json`:

```json
{
  "mcpServers": {
    "proofline": {
      "command": "npx",
      "args": ["-y", "@proofline/mcp"],
      "env": {
        "PROOFLINE_TOKEN": "YOUR_PROOFLINE_TOKEN"
      }
    }
  }
}
```

Keep the token in local user configuration, or omit `env` when the agent inherits `PROOFLINE_TOKEN` from its environment. On Windows, agents that cannot launch `npx` directly can use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "@proofline/mcp"]`.

For Codex, add this entry to `config.toml` and set `PROOFLINE_TOKEN` in the environment that starts Codex:

```toml
[mcp_servers.proofline]
command = "npx"
args = ["-y", "@proofline/mcp"]
env_vars = ["PROOFLINE_TOKEN"]
```

Create a personal token in the Proofline console for the organization you want to use. The token selects the organization, so no organization ID is needed. Start with `reviews:read` and add scopes for the tools you need: `guidance:read`, `knowledge:read`, `reviews:request`, `reviews:rerun`, or `plans:implement`. The server enforces each tool's scopes and repository access.

The default server URL is `https://proofline.sh`. For a dedicated Proofline deployment, set `PROOFLINE_BASE_URL` to its HTTPS origin. The package never opens a browser or stores credentials.

## Tools and results

The package forwards the server's tool catalog and results unchanged. Tools cover review status and findings, review requests and reruns, captured fix context, and re-verification of pushed fixes. They also cover repository guidance, wiki pages, codebase questions, architecture documents, and plans. Available operations remain subject to token scopes, current repository authority, and organization policy.

The server keeps model and repository text wrapped as `untrusted_text`. Treat it as data. `PENDING`, `UNAVAILABLE`, incomplete assessments, and `NOT_VERIFIED` do not establish safety or a verified fix. A tool refusal retains `isError: true`. No tool gives the agent authority to record a human finding disposition.

## Transport and protocol

The bridge accepts newline-delimited JSON-RPC on stdin and writes only protocol responses to stdout. Diagnostics go to stderr. The bridge forwards one request at a time and never retries. A failed mutation may have committed; inspect its state before making another request.

The bridge supports Proofline's stateless JSON transport with protocol `2025-11-25`. Initialize, then send `notifications/initialized` before calling tools. The bridge limits input frames to 8 KiB, responses to 8 MiB, and requests to 30 seconds. It refuses redirects, SSE, and `MCP-Session-Id`. HTTP failures produce a correlated, sanitized JSON-RPC error; the bridge does not print upstream error bodies or credentials. A transport failure exits 1. Clean input EOF exits 0.

## Tracing

The bridge can record how an agent uses the server: which tools it calls, how long each call waits, and how each one ends. Tracing is off unless `PROOFLINE_MCP_TRACE` names a file. Set it beside the token, to an absolute path:

```json
"env": {
  "PROOFLINE_TOKEN": "YOUR_PROOFLINE_TOKEN",
  "PROOFLINE_MCP_TRACE": "/path/to/proofline-trace.jsonl"
}
```

The bridge then appends one JSON line for each message, once it has answered the message:

```json
{"time":"2026-11-15T09:20:45.970Z","method":"tools/call","tool":"request_reverification","outcome":"tool_error","duration_ms":185,"request_bytes":236,"response_bytes":245}
```

`time` is when the message was answered. `outcome` is `ok`, `tool_error` (a result with `isError: true`), `rpc_error` (a JSON-RPC error from the server, with its `rpc_code`), `refused` (a message the bridge did not forward, such as a probe before the handshake), or the category of a bridge failure: `http` (with `http_status`), `transport`, `response`, `lifecycle`, `jsonrpc`, or `input`. `duration_ms` is the time spent waiting on the server, and 0 when nothing was forwarded. `request_bytes` and `response_bytes` are the sizes of the JSON-RPC lines the agent sent and received.

A line never holds the token, request parameters or tool arguments, results, error messages or bodies from the server, or request ids. A method or tool name longer than 128 characters is left out. The trace must be a regular file. The bridge creates it with mode `0600` and does not start if it cannot open it. Sessions can share a file, because each line is one append. If a write fails, tracing stops with one line on stderr and the session continues. The bridge writes nothing about the trace to stdout.

Summarize a trace with `--trace-summary`:

```sh
npx -y @proofline/mcp --trace-summary /path/to/proofline-trace.jsonl
```

```text
message                            calls  failures  median ms  max ms
tools/call get_review_status           3         0         98     246
tools/call get_fix_context             2         0        133     141
tools/call get_review_state            1         1         27      27
tools/call list_open_findings          1         0        154     154
tools/call request_reverification      1         1        185     185
initialize                             1         0         66      66
notifications/initialized              1         0         22      22
server/discover                        1         1          0       0
tools/list                             1         0         63      63
total                                 12         3         87     246
```

Each tool has a row, and so has each method that is not a tool call. A failure is any outcome other than `ok`. In this example, from a test server, the agent probed before the handshake (`server/discover`) and once asked for `get_review_status` under a wrong name (`get_review_state`). Lines that are not trace entries are skipped and counted.

## Development and releases

The hosted endpoint's Official MCP Registry entry is maintained in `server.json`.
Run the **Publish MCP Registry** workflow from `main` after reviewing a metadata
change. It validates the file and publishes with GitHub OIDC; no stored registry
token is needed. Published versions are immutable, so increment the registry
version before publishing changed metadata. This workflow does not publish the
npm bridge.

Run the verification suite locally before submitting a pull request:

```sh
npm run check
npm test
npm run test:package
```

The `test:package` script installs the tarball into a temporary directory and runs the protocol tests against the installed executable. CI uses pinned Actions. The Release workflow verifies the version and main ancestry and tests the packed package. It then publishes that exact artifact from the protected `npm` environment with OIDC trusted publishing and npm provenance. There is no publish-time build or long-lived npm token.

Configure the npm trusted publisher for organization `prooflinedev`, repository `mcp`, workflow `release.yml`, and environment `npm` with direct publishing enabled. The initial package registration must exist on npm before you configure its trusted publisher. Release tags use `v` followed by the version in `package.json`. A manual Release run defaults to qualification without publication.
