// Opt-in live diagnostic: real model calls and native hooks, never part of npm test.
// Requires --cli <executable>; --sdk <dist/index.js> can inspect an unpacked release.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const cli = option("--cli");
assert.ok(cli, "Pass --cli explicitly; this probe never attaches to an existing host.");
const sdkModule = option("--sdk");
const { CopilotClient, RuntimeConnection } = await import(
  sdkModule ? pathToFileURL(resolve(sdkModule)).href : "@github/copilot-sdk"
);
const sdkPackage = sdkModule
  ? join(dirname(resolve(sdkModule)), "..", "package.json")
  : resolve("node_modules", "@github", "copilot-sdk", "package.json");
const sdkVersion = JSON.parse(readFileSync(sdkPackage, "utf8")).version;
const artifacts = resolve(".e2e-artifacts", "native-file-hooks-lifecycle");
mkdirSync(artifacts, { recursive: true });
const repository = mkdtempSync(join(artifacts, "probe-"));
execFileSync("git", ["init", "--quiet", repository]);
mkdirSync(join(repository, ".github", "hooks"), { recursive: true });
const traceFile = join(repository, "native-hooks.jsonl");
const recorder = join(repository, "record-hook.cjs");
writeFileSync(recorder, `
const fs = require("node:fs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const payload = JSON.parse(input);
  fs.appendFileSync(process.argv[2], JSON.stringify({
    observedAt: new Date().toISOString(), event: process.argv[3],
    hookProcessId: process.pid, hookCwd: process.cwd(), payload
  }) + "\\n");
});
`);
const hookNames = ["sessionStart", "userPromptSubmitted", "agentStop", "sessionEnd", "errorOccurred"];
writeFileSync(join(repository, ".github", "hooks", "trace.json"), JSON.stringify({
  version: 1,
  hooks: Object.fromEntries(hookNames.map(name => [name, [{
    type: "command",
    powershell: `& '${process.execPath.replaceAll("'", "''")}' '${recorder.replaceAll("'", "''")}' '${traceFile.replaceAll("'", "''")}' '${name}'`,
    timeoutSec: 10,
  }]])),
}, null, 2));

const records = [];
const snapshots = [];
let client;
let session;
let sessionId;
let toolErrors = 0;
const trace = () => existsSync(traceFile)
  ? readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
function record(operation, extra = {}) {
  records.push({ observedAt: new Date().toISOString(), operation, ...extra });
}
function snapshot(phase) {
  const hooks = trace();
  const row = {
    phase, sessionId,
    starts: hooks.filter(h => h.event === "sessionStart").length,
    ends: hooks.filter(h => h.event === "sessionEnd").length,
    stops: hooks.filter(h => h.event === "agentStop").length,
    errors: hooks.filter(h => h.event === "errorOccurred").length,
  };
  snapshots.push(row);
  console.log(JSON.stringify(row));
}
const config = {
  workingDirectory: repository,
  enableConfigDiscovery: false,
  enableFileHooks: true,
  mcpServers: {},
  disabledMcpServers: ["github-mcp-server"],
  availableTools: ["lifecycle_probe_error"],
  model: option("--model"),
  streaming: true,
  onPermissionRequest: () => ({ kind: "denied-interactively-by-user" }),
  tools: [{
    name: "lifecycle_probe_error",
    description: "Harmless diagnostic tool that always throws an expected error.",
    skipPermission: true,
    defer: "never",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      toolErrors += 1;
      throw new Error("EXPECTED_LIFECYCLE_PROBE_TOOL_ERROR");
    },
  }],
  onEvent: (event) => {
    if (["session.start", "session.resume", "session.idle", "session.error",
      "assistant.turn_start", "assistant.turn_end", "assistant.idle", "abort",
      "hook.start", "hook.end"].includes(event.type)) {
      record(event.type, { timestamp: event.timestamp, data: event.data });
    }
  },
};
async function start() {
  client = new CopilotClient({
    workingDirectory: repository,
    connection: RuntimeConnection.forStdio({ path: resolve(cli) }),
  });
  await client.start();
  record("client.start", { status: await client.getStatus(), sdkVersion });
}
async function prompt(phase, text) {
  record("session.send", { phase });
  await session.sendAndWait({ prompt: text }, 90000);
  snapshot(phase);
}
async function disconnect() {
  record("session.disconnect");
  await session.disconnect();
  snapshot("after-disconnect");
}

let failure;
try {
  await start();
  record("session.create");
  session = await client.createSession(config);
  sessionId = session.sessionId;
  snapshot("after-create");
  await prompt("first-turn", "Reply exactly FIRST. Do not use tools.");
  await prompt("second-turn-same-session", "Reply exactly SECOND. Do not use tools.");

  let unsubscribe = () => {};
  let timeout;
  let abortRequest;
  const aborted = new Promise((resolveAbort, rejectAbort) => {
    timeout = setTimeout(() => rejectAbort(new Error("Abort probe timed out")), 90000);
    unsubscribe = session.on(event => {
      if (event.type === "assistant.turn_start" && !abortRequest) {
        record("session.abort");
        abortRequest = session.abort();
        abortRequest.catch(rejectAbort);
      }
      if (event.type === "session.idle" && abortRequest) resolveAbort();
    });
  });
  try {
    record("session.send", { phase: "abort-turn" });
    await session.send({ prompt: "Count from 1 to 10000, one integer per line. Do not use tools." });
    await aborted;
    await abortRequest;
  } finally {
    clearTimeout(timeout);
    unsubscribe();
  }
  snapshot("after-aborted-turn");
  await prompt("after-abort-same-session", "Reply exactly STILL_VALID. Do not use tools.");
  await prompt("recoverable-tool-error",
    "Call lifecycle_probe_error exactly once. Its error is expected. After that reply exactly ERROR_HANDLED.");
  assert.equal(toolErrors, 1, "The error probe must actually invoke its harmless tool");
  await prompt("after-error-same-session", "Reply exactly STILL_VALID. Do not use tools.");
  await disconnect();
  record("client.stop");
  await client.stop();
  snapshot("after-client-stop");

  for (const suppressResumeEvent of [true, false]) {
    await start();
    record("session.resume", { suppressResumeEvent });
    session = await client.resumeSession(sessionId, { ...config, suppressResumeEvent });
    assert.equal(session.sessionId, sessionId);
    await prompt(`cold-resume-suppressed-${suppressResumeEvent}`,
      "Reply exactly RESUMED. Do not use tools.");
    if (suppressResumeEvent) await disconnect();
    record("client.stop");
    await client.stop();
    snapshot(suppressResumeEvent ? "after-resumed-client-stop" : "after-client-stop-with-live-session");
  }
  const hooks = trace();
  const starts = hooks.filter(h => h.event === "sessionStart");
  assert.equal(starts.length, 3, "One authentic startup per fresh/cold connection");
  assert.deepEqual(starts.map(h => h.payload.source), ["new", "resume", "resume"]);
  assert.ok(hooks.some(h => h.event === "sessionEnd"), "Native end hooks must run");
  assert.ok(records.some(row => row.operation === "abort"), "The runtime must acknowledge the abort");
  for (const hook of hooks) {
    assert.equal(hook.payload.sessionId, sessionId, "Authentic hook identity must match the SDK session");
    assert.equal(resolve(hook.payload.cwd), repository, "Native hook cwd must be the isolated repository");
  }
  if (process.argv.includes("--expect-persistent")) {
    const first = snapshots.find(row => row.phase === "first-turn");
    const second = snapshots.find(row => row.phase === "second-turn-same-session");
    assert.equal(first.ends, 0, "Persistent sessionEnd must not fire at first end_turn");
    assert.equal(second.ends, 0, "Persistent sessionEnd must not fire at second end_turn");
    assert.equal(snapshots.find(row => row.phase === "after-aborted-turn").ends, 0,
      "An aborted turn must not end a persistent session");
    assert.equal(snapshots.find(row => row.phase === "after-error-same-session").ends, 0,
      "A recoverable tool error must not end a persistent session");
    assert.equal(snapshots.find(row => row.phase === "after-disconnect").ends, 1,
      "Explicit disconnect must deliver the deferred native sessionEnd once");
  }
} catch (error) {
  failure = error;
} finally {
  try {
    if (client) await client.stop();
    if (sessionId) {
      await start();
      record("session.delete", { sessionId });
      await client.deleteSession(sessionId);
      await client.stop();
    }
  } catch (cleanupError) {
    failure = failure
      ? new AggregateError([failure, cleanupError], "Probe and cleanup failed")
      : cleanupError;
  }
  const output = join(repository, "result.json");
  writeFileSync(output, JSON.stringify({
    sdkVersion, cli: resolve(cli), repository, sessionId, toolErrors, snapshots, records, hooks: trace(),
    error: failure ? String(failure) : undefined,
  }, null, 2));
  console.log(`Evidence: ${output}`);
}
if (failure) throw failure;
