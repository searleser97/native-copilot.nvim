import type { DynamicAgentDefinition, DynamicFleetDefinition } from "./types.js";
import type { FleetMoveOptions } from "./runtime.js";

export interface RuntimeAdapter {
  shutdown(reason: string): Promise<void>;
  status(): unknown;
  recoverableFleetRuns(): Array<Record<string, unknown>>;
  listModels(): Promise<unknown[]>;
  listSessions(): Promise<unknown[]>;
  resumeStandardSession(sessionId: string): Promise<void>;
  listCommands(target: string): Promise<unknown[]>;
  invokeCommand(target: string, name: string, input?: string): Promise<unknown>;
  modelState(target: string): Promise<unknown>;
  switchModel(target: string, modelId: string): Promise<unknown>;
  reasoningState(target: string): Promise<unknown>;
  setReasoningEffort(target: string, reasoningEffort: string): Promise<unknown>;
  listMcp(target: string): Promise<unknown[]>;
  setMcpEnabled(target: string, serverName: string, enabled: boolean): Promise<unknown>;
  listMcpTools(target: string, serverName: string): Promise<unknown[]>;
  openStandard(): Promise<void>;
  startFleet(definition: DynamicFleetDefinition): Promise<void>;
  resumeFleet(runId: string): Promise<void>;
  stopFleet(fleetIdOrRunId: string, reason?: string): Promise<void>;
  mutateFleetAddOrUpdate(
    fleetId: string,
    agentDefinition: DynamicAgentDefinition,
  ): Promise<Record<string, unknown>>;
  mutateFleetRemove(
    fleetId: string,
    agentId: string,
    newEntryAgent?: string,
  ): Promise<Record<string, unknown>>;
  mutateFleetMove(
    sourceFleetId: string,
    destinationFleetId: string,
    agentId: string,
    options?: FleetMoveOptions,
  ): Promise<Record<string, unknown>>;
  sendUserPrompt(target: string, content: string): Promise<string>;
  abort(target: string): Promise<void>;
  reloadMcp(target: string): Promise<number>;
  listTasks(target: string): Promise<unknown[]>;
  taskProgress(target: string, taskId: string): Promise<unknown>;
  cancelTask(target: string, taskId: string): Promise<boolean>;
  respondPermission(requestId: string, approved: boolean): boolean;
  cancelAllBackgroundAgents(target: string): Promise<number>;
}
