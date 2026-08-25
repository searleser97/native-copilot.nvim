import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv.includes("--fleet") ? "fleet" : "standard";
const database = resolve(tmpdir(), `native-copilot-sdk-smoke-${process.pid}.sqlite`);
const child = spawn(
  process.execPath,
  [
    resolve(root, "dist", "main.js"),
    "--config",
    resolve(root, "examples", "fleets.json"),
    "--db",
    database,
    "--workspace",
    root,
  ],
  { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
);

const events = [];
const waiters = new Set();
let stderr = "";
let exited = false;

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
child.once("exit", () => {
  exited = true;
});

function dispatch(message) {
  events.push(message);
  for (const waiter of [...waiters]) {
    if (waiter.predicate(message)) {
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  }
}

createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
  try {
    dispatch(JSON.parse(line));
  } catch {
    stderr += `Invalid host output: ${line}\n`;
  }
});

function waitFor(predicate, label, timeoutMs = 120_000) {
  const existing = events.find(predicate);
  if (existing) {
    return Promise.resolve(existing);
  }
  return new Promise((resolvePromise, reject) => {
    const waiter = {
      predicate,
      resolve: resolvePromise,
      timer: setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`Timed out waiting for ${label}`));
      }, timeoutMs),
    };
    waiters.add(waiter);
  });
}

function send(type, payload = {}) {
  const id = randomUUID();
  child.stdin.write(`${JSON.stringify({ v: 1, id, type, payload })}\n`);
  return id;
}

async function request(type, payload = {}, timeoutMs) {
  const id = send(type, payload);
  await waitFor(
    (event) =>
      event.requestId === id &&
      (event.type === "request.complete" || event.type === "request.error"),
    `${type} completion`,
    timeoutMs,
  ).then((event) => {
    if (event.type === "request.error") {
      throw new Error(event.payload?.message ?? `${type} failed`);
    }
  });
}

async function shutdown() {
  if (exited) {
    return;
  }
  const id = send("shutdown");
  await waitFor(
    (event) => event.type === "host.shutdown" && event.requestId === id,
    "host shutdown",
    10_000,
  );
  child.stdin.end();
  if (!exited) {
    await new Promise((resolvePromise) => child.once("exit", resolvePromise));
  }
}

async function runStandard() {
  await request("mode.standard", {}, 120_000);
  const commandRequestId = send("commands.list", { target: "standard" });
  const commandList = await waitFor(
    (event) => event.type === "commands.list" && event.requestId === commandRequestId,
    "dynamic slash command list",
  );
  if (!Array.isArray(commandList.payload?.commands) || commandList.payload.commands.length === 0) {
    throw new Error("The active Copilot session returned no slash commands");
  }
  const commandsWithInputMetadata = commandList.payload.commands.filter(
    (command) =>
      command.input?.choices?.length > 0 ||
      command.input?.completion ||
      command.input?.hint,
  );
  if (commandsWithInputMetadata.length === 0) {
    throw new Error("The active Copilot session returned no argument-completion metadata");
  }
  const inspectionCommand = commandList.payload.commands.find((command) => command.name === "context");
  if (!inspectionCommand) {
    throw new Error("The active Copilot session did not expose the read-only /context smoke command");
  }
  const invokeRequestId = send("command.invoke", {
    target: "standard",
    name: inspectionCommand.name,
  });
  const commandResult = await waitFor(
    (event) => event.type === "command.result" && event.requestId === invokeRequestId,
    "slash command invocation",
  );
  if (!["text", "completed", "select-subcommand"].includes(commandResult.payload?.result?.kind)) {
    throw new Error(
      `Unexpected /context result: ${JSON.stringify(commandResult.payload?.result ?? null)}`,
    );
  }
  const modelRequestId = send("model.list", { target: "standard", purpose: "smoke" });
  const modelList = await waitFor(
    (event) => event.type === "model.list" && event.requestId === modelRequestId,
    "session model list",
  );
  if (!Array.isArray(modelList.payload?.state?.models) || !modelList.payload.state.current?.modelId) {
    throw new Error(`Invalid session model state: ${JSON.stringify(modelList.payload?.state ?? null)}`);
  }
  const currentModelId = modelList.payload.state.current.modelId;
  const switchRequestId = send("model.switch", {
    target: "standard",
    modelId: currentModelId,
  });
  const modelChanged = await waitFor(
    (event) => event.type === "model.changed" && event.requestId === switchRequestId,
    "session model switch",
  );
  if (modelChanged.payload?.model?.modelId !== currentModelId) {
    throw new Error(`Unexpected switched model: ${JSON.stringify(modelChanged.payload?.model ?? null)}`);
  }
  const mcpRequestId = send("mcp.list", { target: "standard", purpose: "smoke" });
  const mcpList = await waitFor(
    (event) => event.type === "mcp.list" && event.requestId === mcpRequestId,
    "session MCP list",
  );
  if (!Array.isArray(mcpList.payload?.servers)) {
    throw new Error(`Invalid MCP list: ${JSON.stringify(mcpList.payload ?? null)}`);
  }
  const marker = "native-copilot-standard-smoke-ok";
  await request("prompt.send", {
    target: "standard",
    content: `Reply with exactly this text and nothing else: ${marker}`,
  });
  const response = await waitFor(
    (event) =>
      event.type === "conversation.message" &&
      event.memberId === "standard" &&
      event.payload?.content?.includes(marker),
    "Standard Copilot response",
  );
  await waitFor(
    (event) =>
      event.type === "member.state" &&
      event.memberId === "standard" &&
      event.payload?.state === "idle",
    "Standard Copilot idle",
  );
  console.log(
    `standard smoke passed with ${commandList.payload.commands.length} dynamic commands and ` +
      `${commandsWithInputMetadata.length} argument schemas, ` +
      `${modelList.payload.state.models.length} models, and ` +
      `${mcpList.payload.servers.length} MCP servers: ` +
      response.payload.content.trim(),
  );
}

async function runFleet() {
  await request("fleet.start", { fleetId: "engineering" }, 180_000);
  const commandRequestId = send("commands.list", { target: "coordinator" });
  const commandList = await waitFor(
    (event) => event.type === "commands.list" && event.requestId === commandRequestId,
    "Fleet member slash command list",
  );
  if (!Array.isArray(commandList.payload?.commands) || commandList.payload.commands.length === 0) {
    throw new Error("The Fleet member session returned no slash commands");
  }
  const marker = "reviewer-mailbox-smoke-ok";
  await request("prompt.send", {
    target: "coordinator",
    content:
      "Use send_message to send the reviewer member this exact instruction: " +
      `"Reply with exactly ${marker} and nothing else." ` +
      "After the tool succeeds, reply with exactly coordinator-mailbox-sent.",
  });
  await waitFor(
    (event) =>
      event.type === "mailbox.delivered" &&
      event.payload?.source === "coordinator" &&
      event.payload?.target === "reviewer",
    "coordinator-to-reviewer mailbox delivery",
  );
  const response = await waitFor(
    (event) =>
      event.type === "conversation.message" &&
      event.memberId === "reviewer" &&
      event.payload?.content?.includes(marker),
    "reviewer mailbox response",
    180_000,
  );
  await waitFor(
    (event) =>
      event.type === "member.state" &&
      event.memberId === "reviewer" &&
      event.payload?.state === "idle",
    "reviewer idle",
  );
  console.log(
    `fleet mailbox smoke passed with ${commandList.payload.commands.length} dynamic commands: ` +
      response.payload.content.trim(),
  );
}

try {
  await waitFor((event) => event.type === "host.ready", "host readiness", 10_000);
  if (mode === "fleet") {
    await runFleet();
  } else {
    await runStandard();
  }
  await shutdown();
  if (child.exitCode !== 0) {
    throw new Error(`Host exited with code ${child.exitCode}`);
  }
} catch (error) {
  try {
    await shutdown();
  } catch {
    if (!exited) {
      child.kill();
    }
  }
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`.trim());
} finally {
  for (const suffix of ["", "-shm", "-wal"]) {
    const path = database + suffix;
    if (existsSync(path)) {
      rmSync(path);
    }
  }
}
