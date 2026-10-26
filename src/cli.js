#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { bridge, configuration } from "./bridge.js";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log("Usage: proofline-mcp\n\nSet PROOFLINE_TOKEN to a scoped Proofline token.\nOptional: PROOFLINE_BASE_URL (default https://proofline.sh).\nReads MCP JSON-RPC from stdin and writes responses to stdout.\nRequires Node.js 22 or later.");
} else if (args.length === 1 && args[0] === "--version") {
  console.log(JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version);
} else if (args.length) {
  console.error("Unknown arguments. Run proofline-mcp --help.");
  process.exitCode = 1;
} else {
  try {
    const config = configuration(process.env);
    process.exitCode = await bridge(process.stdin, process.stdout, process.stderr, config);
    process.stdin.destroy();
  } catch {
    console.error("Proofline MCP configuration invalid. Set PROOFLINE_TOKEN and use an HTTPS origin for PROOFLINE_BASE_URL.");
    process.exitCode = 1;
  }
}
