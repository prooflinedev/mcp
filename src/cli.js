#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { bridge, configuration } from "./bridge.js";
import { summary, tracer } from "./trace.js";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log("Usage: proofline-mcp\n       proofline-mcp --trace-summary <file>\n\nSet PROOFLINE_TOKEN to a scoped Proofline token.\nOptional: PROOFLINE_BASE_URL (default https://proofline.sh).\nOptional: PROOFLINE_MCP_TRACE, a file that gets one JSON line for each message:\nits method, tool name, outcome, duration and sizes, never its content.\nReads MCP JSON-RPC from stdin and writes responses to stdout.\nWith --trace-summary <file>, prints calls, failures and durations for each tool instead.\nRequires Node.js 22 or later.");
} else if (args.length === 1 && args[0] === "--version") {
  console.log(JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version);
} else if (args.length === 2 && args[0] === "--trace-summary") {
  process.exitCode = await summary(args[1], process.stdout, process.stderr);
} else if (args.length) {
  console.error("Unknown arguments. Run proofline-mcp --help.");
  process.exitCode = 1;
} else {
  try {
    const config = configuration(process.env);
    const trace = tracer(process.env.PROOFLINE_MCP_TRACE);
    process.exitCode = await bridge(process.stdin, process.stdout, process.stderr, config, trace);
    process.stdin.destroy();
  } catch {
    console.error("Proofline MCP configuration invalid. Set PROOFLINE_TOKEN and use an HTTPS origin for PROOFLINE_BASE_URL." +
      (process.env.PROOFLINE_MCP_TRACE ? " PROOFLINE_MCP_TRACE must name a regular file that can be appended to." : ""));
    process.exitCode = 1;
  }
}
