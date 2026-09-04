import type { DynamicAgentDefinition, SpawnAgentsRequest } from "./types.js";

export interface AgentUpdate {
  definition: DynamicAgentDefinition;
  /** Omit to keep the agent's current Standard→agent permission. */
  standardCanTalk?: boolean;
}

export interface RuntimeAdapter {
  shutdown(reason: string): Promise<void>;
  status(): unknown;
  /** Durable agent runs in this workspace that can be resumed individually. */
  recoverableAgentRuns(): Array<Record<string, unknown>>;
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
  /** Starts every requested agent independently; the request itself is ephemeral. */
  spawnAgents(request: SpawnAgentsRequest): Promise<Array<Record<string, unknown>>>;
  resumeAgent(runId: string): Promise<void>;
  /** Accepts an agent UUID, an "agent:<uuid>" target, an alias, or a run id. */
  stopAgent(agentRef: string, reason?: string): Promise<void>;
  updateAgent(agentRef: string, update: AgentUpdate): Promise<Record<string, unknown>>;
  sendUserPrompt(target: string, content: string): Promise<string>;
  abort(target: string): Promise<void>;
  reloadMcp(target: string): Promise<number>;
  listTasks(target: string): Promise<unknown[]>;
  taskProgress(target: string, taskId: string): Promise<unknown>;
  cancelTask(target: string, taskId: string): Promise<boolean>;
  respondPermission(requestId: string, approved: boolean): boolean;
  cancelAllBackgroundAgents(target: string): Promise<number>;
}
