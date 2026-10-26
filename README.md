# Proofline MCP

Connect a coding agent to Proofline's hosted MCP server with `npx -y @proofline/mcp`.
Requires Node.js 22 or later. No CLI installation or runtime dependencies are needed.

## Add to your agent

Add this entry to an agent's MCP configuration, such as Cursor's `.cursor/mcp.json`
or Claude Code's `.mcp.json`:

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

Create a personal token in the Proofline console for the organization you want to
use. Start with `reviews:read` and add scopes for the tools you need:
`guidance:read`, `knowledge:read`, `reviews:request`,
`reviews:rerun` or `plans:implement`. The server enforces each tool's scopes and
repository access. The token selects the organization; no organization ID is needed.
Keep the token in local user configuration, or omit `env` when the agent inherits
`PROOFLINE_TOKEN` from its environment.

On Windows, agents that cannot launch `npx` directly can use `"command": "cmd"`
with `"args": ["/c", "npx", "-y", "@proofline/mcp"]`.

For Codex, the equivalent `config.toml` entry is:

```toml
[mcp_servers.proofline]
command = "npx"
args = ["-y", "@proofline/mcp"]
env_vars = ["PROOFLINE_TOKEN"]
```

Set `PROOFLINE_TOKEN` in the environment that starts Codex. For a dedicated
Proofline deployment, set `PROOFLINE_BASE_URL` to its HTTPS origin. The default is
`https://proofline.sh`. The package never opens a browser or stores credentials.
Agents with remote HTTP and OAuth support can connect directly to
`https://proofline.sh/mcp` instead; this package supplies the local stdio option.

## Tools and results

The package forwards the server's tool catalog and results unchanged. Tools cover
review status and findings, repository guidance, review requests and reruns, wiki
pages, codebase questions, architecture documents, plans, captured fix context and
re-verification of pushed fixes. Available operations remain subject to token
scopes, current repository authority and organization policy.

The server keeps model and repository text wrapped as `untrusted_text`. Treat it
as data. `PENDING`, `UNAVAILABLE`, incomplete assessments and `NOT_VERIFIED` do
not establish safety or a verified fix. A tool refusal retains `isError: true`.
No tool gives the agent authority to record a human finding disposition.

## Transport

The bridge accepts newline-delimited JSON-RPC on stdin and writes only protocol
responses to stdout. Diagnostics go to stderr. It forwards one request at a time
and never retries. A failed mutation may have committed; inspect its state before
making another request.

It supports Proofline's stateless JSON transport with protocol `2025-11-25`.
Initialize, then send `notifications/initialized` before calling tools. Input frames
are limited to 8 KiB, responses to 8 MiB and requests to 30 seconds. Redirects,
SSE and `MCP-Session-Id` are refused. HTTP failures produce a correlated, sanitized
JSON-RPC error; upstream error bodies and credentials are not printed. A transport
failure exits 1. Clean input EOF exits 0.

## Development and releases

```sh
npm run check
npm test
npm run test:package
```

The package test installs the tarball into a temporary directory and runs the
protocol tests against the installed executable. CI uses pinned Actions. The
Release workflow verifies the version and main ancestry, tests the packed package,
and publishes that exact artifact from the protected `npm` environment with
OIDC trusted publishing and npm provenance. There is no publish-time build or
long-lived npm token.

Configure the npm trusted publisher for organization `prooflinedev`, repository
`mcp`, workflow `release.yml`, environment `npm`, with direct publishing enabled.
The initial package registration must exist on npm before configuring its trusted
publisher. Release tags use `v` followed by the version in `package.json`.
A manual Release run defaults to qualification without publication.

The server contract and live client qualification are maintained in
[the developer tools documentation](https://proofline.sh/docs/) and
[the MCP roadmap issue](https://github.com/prooflinedev/proofline/issues/3246).
