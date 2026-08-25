#!/usr/bin/env node

import { homedir } from "node:os";
import { resolve } from "node:path";
import { argv, env, exit, ppid, stderr } from "node:process";
import { fleetSummaries, loadConfig } from "./config.js";
import { FleetDatabase } from "./database.js";
import { Protocol, type IncomingCommand } from "./protocol.js";
import { CopilotRuntime } from "./runtime.js";
import { PROTOCOL_VERSION } from "./types.js";

interface HostOptions {
  configPath: string;
  databasePath: string;
  runtimeCommand: string | undefined;
  workspace: string;
}

function option(name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function hostOptions(): HostOptions {
  const workspace = resolve(option("--workspace") ?? env.COPILOT_FLEET_WORKSPACE ?? process.cwd());
  const configRoot =
    env.COPILOT_FLEET_CONFIG_HOME ??
    (process.platform === "win32"
      ? resolve(env.LOCALAPPDATA ?? homedir(), "nvim")
      : resolve(env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"), "nvim"));
  const dataRoot =
    env.COPILOT_FLEET_DATA_HOME ??
    (process.platform === "win32"
      ? resolve(env.LOCALAPPDATA ?? homedir(), "nvim-data")
      : resolve(env.XDG_DATA_HOME ?? resolve(homedir(), ".local", "share"), "nvim"));
  return {
    workspace,
    configPath: resolve(
      option("--config") ?? env.COPILOT_FLEET_CONFIG ?? resolve(configRoot, "copilot", "fleets.json"),
    ),
    databasePath: resolve(
      option("--db") ?? env.COPILOT_FLEET_DATABASE ?? resolve(dataRoot, "copilot-fleet", "state.sqlite"),
    ),
    runtimeCommand:
      env.COPILOT_FLEET_RUNTIME_COMMAND ?? env.NVIM_COPILOT_CMD ?? env.COPILOT_CLI_CMD,
  };
}

function objectPayload(command: IncomingCommand): Record<string, unknown> {
  if (typeof command.payload !== "object" || command.payload === null) {
    return {};
  }
  return command.payload as Record<string, unknown>;
}

function requiredString(
  payload: Record<string, unknown>,
  field: string,
  requestType: string,
): string {
  const value = payload[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${requestType} requires non-empty payload.${field}`);
  }
  return value;
}

async function main(): Promise<void> {
  const options = hostOptions();
  const config = await loadConfig(options.configPath, options.workspace);
  const db = new FleetDatabase(options.databasePath);
  const interruptedRuns = db.markInterruptedWork("Host restarted after an interrupted Neovim session");
  let runtime: CopilotRuntime;
  let protocol: Protocol;
  let closing: Promise<void> | undefined;

  const close = (reason: string, requestId?: string): Promise<void> => {
    if (closing) {
      return closing;
    }
    closing = (async () => {
      clearInterval(parentMonitor);
      await runtime.shutdown(reason);
      protocol.send(
        "host.shutdown",
        { reason },
        requestId === undefined ? { done: true } : { requestId, done: true },
      );
      protocol.stop();
      db.close();
    })();
    return closing;
  };

  const handle = async (command: IncomingCommand): Promise<void> => {
    const payload = objectPayload(command);
    switch (command.type) {
      case "hello":
        protocol.send(
          "hello",
          {
            protocolVersion: PROTOCOL_VERSION,
            pid: process.pid,
            workspace: options.workspace,
            configPath: options.configPath,
            databasePath: options.databasePath,
            interruptedRuns,
            fleets: fleetSummaries(config, options.workspace),
            standard: {
              id: config.standard.id,
              displayName: config.standard.displayName,
            },
            status: runtime.status(),
          },
          { requestId: command.id, done: true },
        );
        return;
      case "state.snapshot":
        protocol.send("state.snapshot", db.snapshot(), { requestId: command.id, done: true });
        return;
      case "runtime.status":
        protocol.send("runtime.status", runtime.status(), { requestId: command.id, done: true });
        return;
      case "models.list":
        protocol.send(
          "models.list",
          { models: await runtime.listModels() },
          { requestId: command.id, done: true },
        );
        return;
      case "commands.list": {
        const target = requiredString(payload, "target", command.type);
        const purpose = typeof payload.purpose === "string" ? payload.purpose : undefined;
        protocol.send(
          "commands.list",
          {
            target,
            commands: await runtime.listCommands(target),
            ...(purpose === undefined ? {} : { purpose }),
          },
          { requestId: command.id, done: true },
        );
        return;
      }
      case "command.invoke": {
        const target = requiredString(payload, "target", command.type);
        const name = requiredString(payload, "name", command.type);
        const input = typeof payload.input === "string" ? payload.input : undefined;
        protocol.send(
          "command.result",
          { target, name, result: await runtime.invokeCommand(target, name, input) },
          { requestId: command.id, memberId: target, target: "conversation", done: true },
        );
        return;
      }
      case "mode.standard":
        await runtime.openStandard();
        protocol.send("request.complete", { type: command.type }, {
          requestId: command.id,
          done: true,
        });
        return;
      case "fleet.start":
        await runtime.startFleet(requiredString(payload, "fleetId", command.type));
        protocol.send("request.complete", { type: command.type }, {
          requestId: command.id,
          done: true,
        });
        return;
      case "fleet.stop":
        await runtime.stopActive("Fleet stopped by user");
        await runtime.openStandard();
        protocol.send("request.complete", { type: command.type }, {
          requestId: command.id,
          done: true,
        });
        return;
      case "prompt.send":
        await runtime.sendUserPrompt(
          requiredString(payload, "target", command.type),
          requiredString(payload, "content", command.type),
        );
        protocol.send("request.complete", { type: command.type }, {
          requestId: command.id,
          done: true,
        });
        return;
      case "session.abort":
        await runtime.abort(requiredString(payload, "target", command.type));
        protocol.send("request.complete", { type: command.type }, {
          requestId: command.id,
          done: true,
        });
        return;
      case "tasks.list": {
        const target = requiredString(payload, "target", command.type);
        const purpose = typeof payload.purpose === "string" ? payload.purpose : undefined;
        protocol.send(
          "tasks.list",
          {
            target,
            tasks: await runtime.listTasks(target),
            ...(purpose === undefined ? {} : { purpose }),
          },
          { requestId: command.id, memberId: target, target: "status", done: true },
        );
        return;
      }
      case "tasks.progress": {
        const target = requiredString(payload, "target", command.type);
        const taskId = requiredString(payload, "taskId", command.type);
        protocol.send(
          "tasks.progress",
          { target, taskId, progress: await runtime.taskProgress(target, taskId) },
          { requestId: command.id, memberId: target, target: "status", done: true },
        );
        return;
      }
      case "tasks.cancel": {
        const target = requiredString(payload, "target", command.type);
        const taskId = requiredString(payload, "taskId", command.type);
        protocol.send(
          "tasks.cancelled",
          { target, taskId, cancelled: await runtime.cancelTask(target, taskId) },
          { requestId: command.id, memberId: target, target: "status", done: true },
        );
        return;
      }
      case "permission.respond": {
        const requestId = requiredString(payload, "requestId", command.type);
        const approved = payload.approved === true;
        protocol.send(
          "permission.resolved",
          { requestId, approved, applied: runtime.respondPermission(requestId, approved) },
          { requestId: command.id, target: "status", done: true },
        );
        return;
      }
      case "session.cancel-background": {
        const target = requiredString(payload, "target", command.type);
        protocol.send(
          "background.cancelled",
          { target, count: await runtime.cancelAllBackgroundAgents(target) },
          { requestId: command.id, memberId: target, target: "status", done: true },
        );
        return;
      }
      case "shutdown":
        await close("Neovim requested shutdown", command.id);
        return;
      default:
        throw new Error(`Unknown request type "${command.type}"`);
    }
  };

  protocol = new Protocol(handle, async () => {
    await close("stdin closed");
    exit(0);
  });
  runtime = new CopilotRuntime(
    config,
    options.workspace,
    db,
    (type, payload, fields) => {
      protocol.send(type, payload, fields);
    },
    options.runtimeCommand,
  );

  const parentMonitor = setInterval(() => {
    try {
      process.kill(ppid, 0);
    } catch {
      void close("Parent Neovim process exited").finally(() => exit(0));
    }
  }, 2_000);
  parentMonitor.unref();

  process.once("SIGINT", () => {
    void close("Host received SIGINT").finally(() => exit(0));
  });
  process.once("SIGTERM", () => {
    void close("Host received SIGTERM").finally(() => exit(0));
  });

  protocol.start();
  protocol.send("host.ready", {
    protocolVersion: PROTOCOL_VERSION,
    pid: process.pid,
    workspace: options.workspace,
  });
}

main().catch((error) => {
  stderr.write(
    `copilot-fleet host failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
