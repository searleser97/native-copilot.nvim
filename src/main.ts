#!/usr/bin/env node

import { homedir } from "node:os";
import { resolve } from "node:path";
import { argv, env, exit, kill, ppid, stderr } from "node:process";
import { FleetDatabase } from "./database.js";
import { Protocol, type IncomingCommand } from "./protocol.js";
import { CopilotRuntime, resolveRuntimeCommand } from "./runtime.js";
import type { RuntimeAdapter } from "./runtime-adapter.js";
import { ScriptedRuntime } from "./scripted-runtime.js";
import { PROTOCOL_VERSION, type DynamicAgentDefinition, type DynamicFleetDefinition } from "./types.js";

interface HostOptions {
  databasePath: string;
  runtimeCommandResolver: string | undefined;
  scriptedProfile: string | undefined;
  workspace: string;
}

function option(name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function hostOptions(): HostOptions {
  const workspace = resolve(
    option("--workspace") ?? env.NATIVE_COPILOT_WORKSPACE ?? process.cwd(),
  );
  const dataRoot =
    env.NATIVE_COPILOT_DATA_HOME ??
    (process.platform === "win32"
      ? resolve(env.LOCALAPPDATA ?? homedir(), "nvim-data")
      : resolve(env.XDG_DATA_HOME ?? resolve(homedir(), ".local", "share"), "nvim"));
  return {
    workspace,
    databasePath: resolve(
      option("--db") ??
        env.NATIVE_COPILOT_DATABASE ??
        resolve(dataRoot, "native-copilot", "state.sqlite"),
    ),
    runtimeCommandResolver: env.NATIVE_COPILOT_RUNTIME_COMMAND_RESOLVER,
    scriptedProfile: env.NATIVE_COPILOT_E2E_PROFILE,
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
  const runtimeCommand = options.scriptedProfile
    ? undefined
    : await resolveRuntimeCommand(options.runtimeCommandResolver, options.workspace);
  const db = new FleetDatabase(options.databasePath);
  const interruptedRuns = db.markInterruptedWork(
    "Owning Neovim host is no longer running",
    (ownerPid) => {
      try {
        kill(ownerPid, 0);
        return true;
      } catch {
        return false;
      }
    },
  );
  let runtime: RuntimeAdapter;
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
            databasePath: options.databasePath,
            interruptedRuns,
            standard: {
              id: "standard",
              displayName: "Copilot",
            },
            status: runtime.status(),
            recoverableFleets: runtime.recoverableFleetRuns(),
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
      case "sessions.list":
        protocol.send(
          "sessions.list",
          { sessions: await runtime.listSessions() },
          { requestId: command.id, done: true },
        );
        return;
      case "session.resume":
        await runtime.resumeStandardSession(requiredString(payload, "sessionId", command.type));
        protocol.send("request.complete", { type: command.type }, {
          requestId: command.id,
          done: true,
        });
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
      case "model.list": {
        const target = requiredString(payload, "target", command.type);
        const purpose = typeof payload.purpose === "string" ? payload.purpose : undefined;
        protocol.send(
          "model.list",
          {
            target,
            state: await runtime.modelState(target),
            ...(purpose === undefined ? {} : { purpose }),
          },
          { requestId: command.id, memberId: target, target: "status", done: true },
        );
        return;
      }
      case "model.switch": {
        const target = requiredString(payload, "target", command.type);
        const modelId = requiredString(payload, "modelId", command.type);
        protocol.send(
          "model.changed",
          { target, model: await runtime.switchModel(target, modelId) },
          { requestId: command.id, memberId: target, target: "conversation", done: true },
        );
        return;
      }
      case "mcp.list": {
        const target = requiredString(payload, "target", command.type);
        const purpose = typeof payload.purpose === "string" ? payload.purpose : undefined;
        const action = typeof payload.action === "string" ? payload.action : undefined;
        protocol.send(
          "mcp.list",
          {
            target,
            servers: await runtime.listMcp(target),
            ...(purpose === undefined ? {} : { purpose }),
            ...(action === undefined ? {} : { action }),
          },
          { requestId: command.id, memberId: target, target: "status", done: true },
        );
        return;
      }
      case "mcp.enable":
      case "mcp.disable": {
        const target = requiredString(payload, "target", command.type);
        const serverName = requiredString(payload, "serverName", command.type);
        protocol.send(
          "mcp.changed",
          {
            target,
            serverName,
            enabled: command.type === "mcp.enable",
            state: await runtime.setMcpEnabled(target, serverName, command.type === "mcp.enable"),
          },
          { requestId: command.id, memberId: target, target: "conversation", done: true },
        );
        return;
      }
      case "mcp.show": {
        const target = requiredString(payload, "target", command.type);
        const serverName = requiredString(payload, "serverName", command.type);
        const servers = await runtime.listMcp(target);
        protocol.send(
          "mcp.show",
          { target, serverName, servers },
          { requestId: command.id, memberId: target, target: "conversation", done: true },
        );
        return;
      }
      case "mcp.tools": {
        const target = requiredString(payload, "target", command.type);
        const serverName = requiredString(payload, "serverName", command.type);
        protocol.send(
          "mcp.tools",
          { target, serverName, tools: await runtime.listMcpTools(target, serverName) },
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
        if (typeof payload.definition !== "object" || payload.definition === null) {
          throw new Error(`${command.type} requires payload.definition`);
        }
        await runtime.startFleet(payload.definition as DynamicFleetDefinition);
        protocol.send("request.complete", { type: command.type }, {
          requestId: command.id,
          done: true,
        });
        return;
      case "fleet.resume":
        await runtime.resumeFleet(requiredString(payload, "runId", command.type));
        protocol.send("request.complete", { type: command.type }, {
          requestId: command.id,
          done: true,
        });
        return;
      case "fleet.stop":
        await runtime.stopFleet(
          requiredString(payload, "fleetId", command.type),
          "Fleet stopped by user",
        );
        protocol.send("request.complete", { type: command.type }, {
          requestId: command.id,
          done: true,
        });
        return;
      case "fleet.agent.add": {
        const fleetId = requiredString(payload, "fleetId", command.type);
        if (typeof payload.agent !== "object" || payload.agent === null) {
          throw new Error(`${command.type} requires payload.agent`);
        }
        const result = await runtime.mutateFleetAddOrUpdate(
          fleetId,
          payload.agent as DynamicAgentDefinition,
        );
        protocol.send("fleet.agent.updated", { fleetId, ...result }, {
          requestId: command.id,
          done: true,
        });
        return;
      }
      case "fleet.agent.remove": {
        const fleetId = requiredString(payload, "fleetId", command.type);
        const agentId = requiredString(payload, "agentId", command.type);
        const newEntryAgent =
          typeof payload.newEntryAgent === "string" ? payload.newEntryAgent : undefined;
        const result = await runtime.mutateFleetRemove(fleetId, agentId, newEntryAgent);
        protocol.send("fleet.agent.updated", { fleetId, ...result }, {
          requestId: command.id,
          done: true,
        });
        return;
      }
      case "fleet.agent.move": {
        const sourceFleetId = requiredString(payload, "sourceFleetId", command.type);
        const destinationFleetId = requiredString(payload, "destinationFleetId", command.type);
        const agentId = requiredString(payload, "agentId", command.type);
        const replacementEntryAgentId =
          typeof payload.replacementEntryAgentId === "string"
            ? payload.replacementEntryAgentId
            : undefined;
        const destinationAgent =
          typeof payload.destinationAgent === "object" && payload.destinationAgent !== null
            ? (payload.destinationAgent as DynamicAgentDefinition)
            : undefined;
        const result = await runtime.mutateFleetMove(
          sourceFleetId,
          destinationFleetId,
          agentId,
          {
            ...(replacementEntryAgentId ? { replacementEntryAgentId } : {}),
            ...(destinationAgent ? { destinationAgent } : {}),
          },
        );
        protocol.send("fleet.agent.moved", { ...result }, {
          requestId: command.id,
          done: true,
        });
        return;
      }
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
      case "mcp.reload": {
        const target = requiredString(payload, "target", command.type);
        const serverCount = await runtime.reloadMcp(target);
        protocol.send("request.complete", { type: command.type, target, serverCount }, {
          requestId: command.id,
          memberId: target,
          target: "status",
          done: true,
        });
        return;
      }
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
  const emit = (type: string, payload?: unknown, fields?: {
    requestId?: string;
    runId?: string;
    memberId?: string;
    target?: string;
    sequence?: number;
    done?: boolean;
  }) => {
    protocol.send(type, payload, fields);
  };
  runtime = options.scriptedProfile
    ? new ScriptedRuntime(options.workspace, db, emit, options.scriptedProfile)
    : new CopilotRuntime(options.workspace, db, emit, runtimeCommand);

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
    `native-copilot host failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
