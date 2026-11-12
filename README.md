# Proofline MCP

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

## Development and releases

Run the verification suite locally before submitting a pull request:

```sh
npm run check
npm test
npm run test:package
```

The `test:package` script installs the tarball into a temporary directory and runs the protocol tests against the installed executable. CI uses pinned Actions. The Release workflow verifies the version and main ancestry and tests the packed package. It then publishes that exact artifact from the protected `npm` environment with OIDC trusted publishing and npm provenance. There is no publish-time build or long-lived npm token.

Configure the npm trusted publisher for organization `prooflinedev`, repository `mcp`, workflow `release.yml`, and environment `npm` with direct publishing enabled. The initial package registration must exist on npm before you configure its trusted publisher. Release tags use `v` followed by the version in `package.json`. A manual Release run defaults to qualification without publication.
