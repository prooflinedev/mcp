import { appendFileSync, createReadStream, openSync, statSync } from "node:fs";

const NAME_LIMIT = 128;
const LINE_LIMIT = 4096;
const named = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= NAME_LIMIT ? value : undefined;
const printable = (text) =>
  text.replace(/[^\x20-\x7e]/gu, (character) => `\\u{${character.codePointAt(0).toString(16)}}`);

/**
 * Returns the writer of a trace file, or nothing without a path. A line holds
 * the fields named here and no others.
 */
export function tracer(path) {
  if (!path) return;
  // A terminal or a pipe may be the protocol stream, and either can block the bridge.
  if (statSync(path, { throwIfNoEntry: false })?.isFile() === false) {
    throw new Error("The trace is not a regular file.");
  }
  const file = openSync(path, "a", 0o600);
  return (entry) => appendFileSync(file, `${JSON.stringify({
    time: new Date().toISOString(), method: named(entry.method), tool: named(entry.tool),
    outcome: entry.outcome, duration_ms: entry.duration_ms ?? 0, request_bytes: entry.request_bytes,
    response_bytes: entry.response_bytes ?? 0, http_status: entry.http_status, rpc_code: entry.rpc_code,
  })}\n`);
}

/** Returns the entry a line holds, or nothing when the line is not one. */
function parse(line) {
  if (line.length > LINE_LIMIT) return;
  try {
    const entry = JSON.parse(line);
    const names = [entry?.method, entry?.tool].every((name) => name === undefined || named(name));
    const duration = Number.isFinite(entry?.duration_ms) && entry.duration_ms >= 0;
    if (names && duration && typeof entry.outcome === "string") return entry;
  } catch { /* Counted with the other malformed lines. */ }
}

/** Prints calls, failures and durations for each tool, and for each method that is not a tool call. */
export async function summary(path, output, diagnostic) {
  const rows = new Map();
  let malformed = 0;
  const read = (line) => {
    if (!line.trim()) return;
    const entry = parse(line);
    if (!entry) { malformed++; return; }
    const tool = entry.method === "tools/call" && entry.tool !== undefined;
    const key = tool ? `tools/call ${entry.tool}` : entry.method ?? "(no method)";
    if (!rows.has(key)) rows.set(key, { tool, failures: 0, durations: [] });
    if (entry.outcome !== "ok") rows.get(key).failures++;
    rows.get(key).durations.push(entry.duration_ms);
  };
  try {
    let rest = "";
    for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop().slice(0, LINE_LIMIT + 1); // An overlong line stays overlong, and bounded.
      lines.forEach(read);
    }
    read(rest);
  } catch (error) {
    const code = /^E\w+$/.test(error?.code) ? ` (${error.code})` : "";
    diagnostic.write(`Proofline MCP trace summary failed: cannot read the file${code}.\n`);
    return 1;
  }
  const skipped = malformed ? `${malformed} malformed line${malformed === 1 ? "" : "s"} skipped.` : "";
  if (!rows.size) {
    diagnostic.write(
      `Proofline MCP trace summary failed: no valid line in the file.${skipped && ` ${skipped}`}\n`);
    return 1;
  }
  // Tools first, then the other methods; within each, the most called first.
  const sorted = [...rows].sort(([a, one], [b, other]) =>
    other.tool - one.tool || other.durations.length - one.durations.length || (a < b ? -1 : 1));
  const total = {
    failures: sorted.reduce((sum, [, row]) => sum + row.failures, 0),
    durations: sorted.flatMap(([, row]) => row.durations),
  };
  const table = [...sorted, ["total", total]].map(([key, { failures, durations }]) => {
    durations.sort((a, b) => a - b);
    const middle = durations.length >> 1;
    const median = durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2;
    return [printable(key), durations.length, failures, Math.round(median), Math.round(durations.at(-1))];
  });
  const cells = [["message", "calls", "failures", "median ms", "max ms"], ...table]
    .map((row) => row.map(String));
  const widths = cells[0].map((_, column) =>
    cells.reduce((width, row) => Math.max(width, row[column].length), 0));
  const lines = cells.map((row) => row.map((cell, column) =>
    column ? cell.padStart(widths[column]) : cell.padEnd(widths[column])).join("  "));
  output.write(`${lines.concat(skipped || []).join("\n")}\n`);
  return 0;
}
