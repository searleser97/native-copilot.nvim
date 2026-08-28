import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { SessionConfig } from "@github/copilot-sdk";
import { validateFleet } from "../src/config.js";
import { FleetDatabase } from "../src/database.js";
import type { DynamicAgentDefinition, DynamicFleetDefinition, ResolvedFleet } from "../src/types.js";
import {
  additionalMcpServers,
  applyNativePolicy,
  configuredRuntimeConnection,
  CopilotRuntime,
  type FleetMoveParticipant,
  instanceSessionId,
  type NativePolicy,
  nativePolicy,
  nativeSessionScaffold,
  memberToolsWithinCeiling,
  parseTarget,
  permissionDecision,
  planFleetMove,
  qualifiedTarget,
  routeTarget,
  runtimeSessionOptions,
  resolveRuntimeCommand,
  sdkToolPatterns,
  STANDARD_TARGET,
  usesApproveAll,
} from "../src/runtime.js";

const runtimeDbPaths: string[] = [];

afterEach(() => {
  for (const path of runtimeDbPaths.splice(0)) {
    for (const suffix of ["", "-shm", "-wal"]) {
      if (existsSync(path + suffix)) {
        rmSync(path + suffix);
      }
    }
  }
});

function tempRuntimeDatabase(): FleetDatabase {
  const path = resolve(
    tmpdir(),
    `native-copilot-rt-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
  runtimeDbPaths.push(path);
  return new FleetDatabase(path);
}

function agentDefinition(
  id: string,
  canTalkTo: string[] = [],
  extra: Partial<DynamicAgentDefinition> = {},
): DynamicAgentDefinition {
  return {
    id,
    displayName: id,
    description: `${id} agent`,
    prompt: `You are the ${id} agent.`,
    canTalkTo,
    ...extra,
  };
}

function fleetDefinition(
  id: string,
  agents: DynamicAgentDefinition[],
  entryAgent: string,
): DynamicFleetDefinition {
  return {
    id,
    name: `${id} fleet`,
    description: `The ${id} collaboration.`,
    objective: `Complete the ${id} objective.`,
    entryAgent,
    agents,
  };
}

function fakeLive(opts: {
  target: string;
  memberId: string;
  fleetId: string;
  runId: string;
  sessionId: string;
  recipients?: string[];
}): Record<string, unknown> & { _disconnected: { value: boolean } } {
  const disconnected = { value: false };
  return {
    session: {
      sessionId: opts.sessionId,
      on: () => () => undefined,
      disconnect: async () => {
        disconnected.value = true;
      },
      abort: async () => undefined,
      getEvents: async () => [],
    },
    runId: opts.runId,
    memberId: opts.memberId,
    target: opts.target,
    fleetId: opts.fleetId,
    recipients: new Set(opts.recipients ?? []),
    modelId: undefined,
    aicUsed: 0,
    busy: false,
    foregroundBusy: false,
    sequence: 0,
    taskRefresh: 0,
    unsubscribe: () => undefined,
    _disconnected: disconnected,
  };
}

const readOnlyProfile = {
  id: "read-only",
  tools: { allow: ["*"], deny: ["shell"] },
  paths: { read: ["${workspace}"], write: [] },
  commands: false,
  network: false,
  gitWrite: false,
  externalActions: false,
};

describe("instanceSessionId", () => {
  it("reuses a session within one Neovim host instance", () => {
    const first = instanceSessionId("E:\\repo", "instance-a", "standard", "copilot");
    const second = instanceSessionId("E:\\repo", "instance-a", "standard", "copilot");

    expect(second).toBe(first);
  });

  describe("configuredRuntimeConnection", () => {
    it("uses the bundled runtime when no private launcher is configured", () => {
      expect(configuredRuntimeConnection(undefined, "win32")).toBeUndefined();
    });

    it(
      "invokes the command resolver in the workspace",
      async () => {
        const resolver =
          process.platform === "win32"
            ? "Write-Output \"& copilot.exe '--allow-all'\""
            : "printf \"%s\" \"copilot --allow-all\"";

        await expect(resolveRuntimeCommand(resolver, process.cwd())).resolves.toContain(
          "--allow-all",
        );
      },
      15_000,
    );

    it("rejects an empty resolver result", async () => {
      const resolver = process.platform === "win32" ? "Write-Output ''" : "printf ''";

      await expect(resolveRuntimeCommand(resolver, process.cwd())).rejects.toThrow(
        "returned an empty command",
      );
    });

    describe("runtimeSessionOptions", () => {
      it("translates the resolved Copilot command into SDK session policy", () => {
        expect(
          runtimeSessionOptions(
            "& copilot.exe '--allow-all' '--excluded-tools=ask_user' " +
              "'--disable-mcp-server' 'workspace-server' '--model' 'claude-sonnet-5'",
          ),
        ).toEqual({
          allowAll: true,
          availableTools: [],
          excludedTools: ["ask_user"],
          disabledMcpServers: ["workspace-server"],
          additionalMcpConfigs: [],
          model: "claude-sonnet-5",
        });
      });

      it("preserves quoted values and repeated MCP exclusions", () => {
        expect(
          runtimeSessionOptions(
            "copilot.exe --excluded-tools='ask_user,shell' " +
              "--disable-mcp-server one --disable-mcp-server='two servers'",
          ),
        ).toEqual({
          allowAll: false,
          availableTools: [],
          excludedTools: ["ask_user", "shell"],
          disabledMcpServers: ["one", "two servers"],
          additionalMcpConfigs: [],
        });
      });

      it("captures --additional-mcp-config as an inherited native MCP source", () => {
        expect(
          runtimeSessionOptions(
            "copilot.exe --additional-mcp-config ./.mcp.json " +
              "--additional-mcp-config='C:\\cfg\\extra.json'",
          ).additionalMcpConfigs,
        ).toEqual(["./.mcp.json", "C:\\cfg\\extra.json"]);
      });
    });

    it("forwards SDK runtime flags through a PowerShell launcher", () => {
      expect(
        configuredRuntimeConnection(
          "& 'E:\\private\\copilot.ps1'",
          "win32",
          undefined,
          "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        ),
      ).toEqual({
        kind: "stdio",
        path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        args: [
          "-NoLogo",
          "-NoProfile",
          "-Command",
          "& { & 'E:\\private\\copilot.ps1' @args }",
        ],
      });
    });

    it("forwards SDK runtime flags through a POSIX launcher", () => {
      expect(configuredRuntimeConnection("mycopilot", "linux", "/bin/zsh")).toEqual({
        kind: "stdio",
        path: "/bin/zsh",
        args: ["-lc", 'exec mycopilot "$@"', "copilot-runtime"],
      });
    });
  });

  it("starts a different session in a new Neovim host instance", () => {
    const first = instanceSessionId("E:\\repo", "instance-a", "standard", "copilot");
    const second = instanceSessionId("E:\\repo", "instance-b", "standard", "copilot");

    expect(second).not.toBe(first);
  });

  it("keeps Fleet members isolated within an instance", () => {
    const planner = instanceSessionId("E:\\repo", "instance-a", "engineering", "planner");
    const reviewer = instanceSessionId("E:\\repo", "instance-a", "engineering", "reviewer");

    expect(reviewer).not.toBe(planner);
  });

  it("uses the Native Copilot prefix for new session IDs", () => {
    expect(instanceSessionId("E:\\repo", "instance-a", "standard", "copilot")).toMatch(
      /^native-copilot-/,
    );
  });

  it("enforces the Fleet permission ceiling before managed approval", () => {
    const request = {
      kind: "shell" as const,
      commands: ["git status"],
      fullCommandText: "git status",
      managedApprovalRequired: true,
    };

    expect(permissionDecision(readOnlyProfile, "E:\\repo", request)).toEqual({
      kind: "reject",
      feedback: "Shell commands are disabled for this member.",
    });
  });

  it("allows ordinary requests inside a configured permission ceiling", () => {
    const request = {
      kind: "read" as const,
      path: "E:\\repo\\README.md",
      managedApprovalRequired: false,
    };

    expect(permissionDecision(readOnlyProfile, "E:\\repo", request)).toEqual({
      kind: "approve-once",
    });
  });

  it("allows managed requests inside the Fleet permission ceiling to reach the UI", () => {
    const request = {
      kind: "read" as const,
      path: "E:\\repo\\README.md",
      managedApprovalRequired: true,
    };

    expect(permissionDecision(readOnlyProfile, "E:\\repo", request)).toEqual({
      kind: "no-result",
    });
  });

  describe("usesApproveAll", () => {
    it("inherits approve-all from the resolved main command", () => {
      expect(usesApproveAll({ mode: "inherit" }, true)).toBe(true);
      expect(usesApproveAll(undefined, true)).toBe(true);
    });

    it("keeps prompt and restrictive profiles interactive", () => {
      expect(usesApproveAll({ mode: "prompt" }, true)).toBe(false);
      expect(usesApproveAll(readOnlyProfile, true)).toBe(false);
      expect(usesApproveAll({ mode: "inherit" }, false)).toBe(false);
    });
  });
});

describe("qualified Fleet targets", () => {
  it("qualifies a raw member id with its Fleet id", () => {
    expect(qualifiedTarget("fleet_a", "planner")).toBe("fleet_a/planner");
    expect(qualifiedTarget("fleet_b", "planner")).toBe("fleet_b/planner");
  });

  it("keeps a raw member id after round-tripping through a qualified target", () => {
    const target = qualifiedTarget("engineering", "reviewer");
    expect(parseTarget(target)).toEqual({ fleetId: "engineering", memberId: "reviewer" });
  });

  it("treats an unqualified target as the Standard supervisor", () => {
    expect(parseTarget(STANDARD_TARGET)).toEqual({ memberId: "standard" });
  });

  it("lets the same raw member id coexist across two Fleets without collision", () => {
    const first = qualifiedTarget("fleet_a", "planner");
    const second = qualifiedTarget("fleet_b", "planner");

    expect(first).not.toBe(second);
    expect(parseTarget(first).memberId).toBe(parseTarget(second).memberId);
    expect(parseTarget(first).fleetId).not.toBe(parseTarget(second).fleetId);
  });

  it("splits only on the first separator so member ids may contain none", () => {
    expect(parseTarget("fleet_a/planner")).toEqual({
      fleetId: "fleet_a",
      memberId: "planner",
    });
  });
});

describe("additionalMcpServers", () => {
  it("merges inline --additional-mcp-config JSON from one native source", () => {
    const servers = additionalMcpServers(
      [
        JSON.stringify({ mcpServers: { docs: { command: "docs-server" } } }),
        JSON.stringify({ servers: { search: { url: "http://localhost:9" } } }),
      ],
      "E:\\repo",
    );

    expect(servers).toEqual({
      docs: { command: "docs-server" },
      search: { url: "http://localhost:9" },
    });
  });

  it("surfaces an error for a non-object server entry instead of dropping it silently", () => {
    expect(() =>
      additionalMcpServers(
        [JSON.stringify({ mcpServers: { good: { command: "ok" }, bad: "nope" } })],
        "E:\\repo",
      ),
    ).toThrow(/server "bad" must be an object/);
  });

  it("surfaces invalid inline JSON rather than silently discarding the source", () => {
    expect(() => additionalMcpServers(['{ "mcpServers": '], "E:\\repo")).toThrow(
      /invalid JSON/,
    );
  });

  it("surfaces a non-object root config", () => {
    expect(() =>
      additionalMcpServers([JSON.stringify(["array is not a config"])], "E:\\repo"),
    ).toThrow(/must be a JSON object/);
  });

  it("surfaces a missing --additional-mcp-config file", () => {
    expect(() =>
      additionalMcpServers(["./definitely-missing.mcp.json"], "E:\\repo"),
    ).toThrow(/file not found/);
  });

  it("reads the Copilot CLI @file form without treating @ as part of the path", () => {
    const path = resolve(
      tmpdir(),
      `native-copilot-mcp-${process.pid}-${Date.now()}.json`,
    );
    runtimeDbPaths.push(path);
    writeFileSync(path, JSON.stringify({ mcpServers: { docs: { command: "docs-server" } } }));

    expect(additionalMcpServers([`@${path}`], "E:\\other-workspace")).toEqual({
      docs: { command: "docs-server" },
    });
  });
});

describe("applyNativePolicy", () => {
  const nativePolicyFixture: NativePolicy = {
    workingDirectory: "E:\\repo",
    allowAll: false,
    availableTools: ["read", "search"],
    excludedTools: ["shell"],
    disabledMcpServers: ["blocked"],
    mcpServers: { shared: { command: "shared-server" } },
    model: "claude-sonnet-5",
    reasoningEffort: "high",
  };

  it("gives an unnarrowed child the same native tool, MCP, and model defaults", () => {
    const config = {} as SessionConfig;
    applyNativePolicy(config, nativePolicyFixture);

    expect(config.availableTools).toEqual(["read", "search"]);
    expect(config.excludedTools).toEqual(["shell"]);
    expect(config.disabledMcpServers).toEqual(["blocked"]);
    expect(config.mcpServers).toEqual({ shared: { command: "shared-server" } });
    expect(config.model).toBe("claude-sonnet-5");
    expect(config.reasoningEffort).toBe("high");
  });

  it("preserves a child's deliberate narrowing while still applying native ceilings", () => {
    const config = {
      availableTools: ["read"],
      excludedTools: ["write"],
      disabledMcpServers: ["member-only"],
      mcpServers: { shared: { command: "member-override" } },
      model: "gpt-5.6-sol",
    } as unknown as SessionConfig;
    applyNativePolicy(config, { ...nativePolicyFixture, mcpServers: { shared: { command: "native-default" } } });

    // The narrowed allowlist is kept (native availableTools do not widen it back).
    expect(config.availableTools).toEqual(["read"]);
    // Native denies always merge as a ceiling on top of the child's own denies.
    expect(config.excludedTools).toEqual(["write", "shell"]);
    expect(config.disabledMcpServers).toEqual(["member-only", "blocked"]);
    // A server the child defines itself is a deliberate override and wins.
    expect(config.mcpServers).toEqual({ shared: { command: "member-override" } });
    // A model the child sets itself is a deliberate override and is not replaced.
    expect(config.model).toBe("gpt-5.6-sol");
  });
});

describe("nativePolicy", () => {
  it("composes the CLI session flags and --additional-mcp-config into one object", () => {
    const policy = nativePolicy(
      "copilot.exe --allow-all --excluded-tools=shell --model claude-sonnet-5 " +
        "--additional-mcp-config='" +
        JSON.stringify({ mcpServers: { docs: { command: "docs-server" } } }) +
        "'",
      "E:\\repo",
    );

    expect(policy).toEqual({
      workingDirectory: "E:\\repo",
      allowAll: true,
      availableTools: [],
      excludedTools: ["shell"],
      disabledMcpServers: [],
      mcpServers: { docs: { command: "docs-server" } },
      model: "claude-sonnet-5",
      reasoningEffort: undefined,
    });
  });

  it("normalizes a bare '*' tool pattern into SDK source-qualified patterns", () => {
    // SDK 1.0.11 rejects a bare "*"; the canonical policy must expand it before any
    // SessionConfig is derived from it.
    const policy = nativePolicy(
      "copilot.exe --available-tools='*' --excluded-tools='*'",
      "E:\\repo",
    );
    expect(policy.availableTools).toEqual(["builtin:*", "custom:*", "mcp:*"]);
    expect(policy.excludedTools).toEqual(["builtin:*", "custom:*", "mcp:*"]);
    expect(policy.availableTools).not.toContain("*");

    // The shared base built from the policy carries the normalized patterns too.
    const base = nativeSessionScaffold(policy);
    expect(base.availableTools).not.toContain("*");
    expect(base.availableTools).toEqual(["builtin:*", "custom:*", "mcp:*"]);
  });
});

describe("memberToolsWithinCeiling", () => {
  it("treats an empty native allowlist as unrestricted", () => {
    expect(memberToolsWithinCeiling([], ["mcp:anything", "builtin:read"])).toBe(true);
  });

  it("accepts a member allowlist that is a subset of the native ceiling", () => {
    expect(memberToolsWithinCeiling(["builtin:read", "builtin:search"], ["builtin:read"])).toBe(true);
  });

  it("accepts patterns covered by a native source wildcard", () => {
    expect(memberToolsWithinCeiling(["builtin:*"], ["builtin:read", "builtin:write"])).toBe(true);
  });

  it("expands a bare '*' native ceiling to cover every source", () => {
    expect(memberToolsWithinCeiling(["*"], ["builtin:read", "custom:x", "mcp:y"])).toBe(true);
  });

  it("rejects a member pattern outside the native ceiling", () => {
    expect(memberToolsWithinCeiling(["builtin:*"], ["mcp:secret"])).toBe(false);
    expect(memberToolsWithinCeiling(["builtin:read"], ["builtin:write"])).toBe(false);
  });

  it("rejects a member '*' that would widen a source-limited native ceiling", () => {
    // Native only permits builtin:*, so a member "*" (which covers custom+mcp) widens.
    expect(sdkToolPatterns(["*"])).toEqual(["builtin:*", "custom:*", "mcp:*"]);
    expect(memberToolsWithinCeiling(["builtin:*"], ["*"])).toBe(false);
  });
});

describe("nativeSessionScaffold", () => {
  const policy: NativePolicy = {
    workingDirectory: "E:\\repo",
    allowAll: false,
    availableTools: ["read", "search"],
    excludedTools: ["shell"],
    disabledMcpServers: ["blocked"],
    mcpServers: { shared: { command: "shared-server" } },
    model: "claude-sonnet-5",
    reasoningEffort: "high",
  };

  it("drives the Standard and child session configs from the same base definition", () => {
    // Both session builders start from this exact shared base.
    const standardBase = nativeSessionScaffold(policy);
    const memberBase = nativeSessionScaffold(policy);

    // Standard and members inherit an identical native base (working directory,
    // config/instruction discovery, session store, tool/MCP/model policy).
    expect(memberBase).toEqual(standardBase);
    expect(standardBase.workingDirectory).toBe("E:\\repo");
    expect(standardBase.enableConfigDiscovery).toBe(true);
    expect(standardBase.enableSessionStore).toBe(true);
    expect(standardBase.availableTools).toEqual(["read", "search"]);
    expect(standardBase.excludedTools).toEqual(["shell"]);
    expect(standardBase.disabledMcpServers).toEqual(["blocked"]);
    expect(standardBase.mcpServers).toEqual({ shared: { command: "shared-server" } });
    expect(standardBase.model).toBe("claude-sonnet-5");
    expect(standardBase.reasoningEffort).toBe("high");

    // A child overlay narrows the shared base without recreating it: the inherited
    // working directory, native excluded ceiling, and MCP servers remain intact.
    memberBase.availableTools = ["read"];
    expect(memberBase.workingDirectory).toBe(standardBase.workingDirectory);
    expect(memberBase.excludedTools).toEqual(standardBase.excludedTools);
    expect(memberBase.mcpServers).toEqual(standardBase.mcpServers);
  });
});

describe("planFleetMove", () => {
  function agent(
    id: string,
    canTalkTo: string[] = [],
    extra: Partial<DynamicAgentDefinition> = {},
  ): DynamicAgentDefinition {
    return {
      id,
      displayName: id,
      description: `${id} agent`,
      prompt: `You are the ${id} agent.`,
      canTalkTo,
      ...extra,
    };
  }

  function fleet(
    id: string,
    agents: DynamicAgentDefinition[],
    entryAgent: string,
  ): DynamicFleetDefinition {
    return {
      id,
      name: `${id} fleet`,
      description: `The ${id} collaboration.`,
      objective: `Complete the ${id} objective.`,
      entryAgent,
      agents,
    };
  }

  function participant(
    definition: DynamicFleetDefinition,
    mcpServers: string[] = [],
  ): FleetMoveParticipant {
    const validated = validateFleet(definition);
    if (!validated.fleet) {
      throw new Error(`invalid fixture: ${JSON.stringify(validated.issues)}`);
    }
    return { fleet: validated.fleet, mcpServers: new Set(mcpServers) };
  }

  function ids(resolved: ResolvedFleet): string[] {
    return [...resolved.members.keys()].sort();
  }

  it("moves an agent between Fleets sharing a raw member id without collision", () => {
    // Both Fleets contain a "planner"; moving "dev" must not disturb either planner.
    const source = participant(
      fleet("fleet_a", [agent("planner", ["dev"]), agent("dev")], "planner"),
    );
    const destination = participant(
      fleet("fleet_b", [agent("planner"), agent("reviewer")], "planner"),
    );

    const plan = planFleetMove(source, destination, "dev", {}, false);

    // Source loses dev and prunes the incoming canTalkTo reference on its planner.
    expect(ids(plan.sourceFleet)).toEqual(["planner"]);
    expect(plan.sourceFleet.members.get("planner")!.recipients.has("dev")).toBe(false);
    // Destination gains dev alongside its own same-role planner without colliding.
    expect(ids(plan.destinationFleet)).toEqual(["dev", "planner", "reviewer"]);
    expect(plan.affectedSourcePeers).toEqual(["planner"]);
    expect(plan.isEntry).toBe(false);
  });

  it("rejects moving an agent whose id already exists in the destination", () => {
    const source = participant(fleet("fleet_a", [agent("lead"), agent("dev")], "lead"));
    const destination = participant(fleet("fleet_b", [agent("dev")], "dev"));

    expect(() => planFleetMove(source, destination, "dev", {}, false)).toThrow(
      /already has an agent "dev"/,
    );
  });

  it("refuses to empty the source Fleet or move between identical Fleets", () => {
    const solo = participant(fleet("fleet_a", [agent("solo")], "solo"));
    const destination = participant(fleet("fleet_b", [agent("other")], "other"));
    expect(() => planFleetMove(solo, destination, "solo", {}, false)).toThrow(/final member/);

    const same = participant(fleet("fleet_a", [agent("lead"), agent("dev")], "lead"));
    expect(() => planFleetMove(same, same, "dev", {}, false)).toThrow(/must be different/);
  });

  it("rejects moving the entry agent unless a valid replacement is applied atomically", () => {
    const source = () =>
      participant(fleet("fleet_a", [agent("planner", ["dev"]), agent("dev")], "planner"));
    const destination = () => participant(fleet("fleet_b", [agent("host")], "host"));

    expect(() => planFleetMove(source(), destination(), "planner", {}, false)).toThrow(
      /without naming a replacementEntryAgentId/,
    );
    expect(() =>
      planFleetMove(source(), destination(), "planner", { replacementEntryAgentId: "planner" }, false),
    ).toThrow(/different agent/);
    expect(() =>
      planFleetMove(source(), destination(), "planner", { replacementEntryAgentId: "ghost" }, false),
    ).toThrow(/is not a member/);

    const plan = planFleetMove(
      source(),
      destination(),
      "planner",
      { replacementEntryAgentId: "dev" },
      false,
    );
    expect(plan.isEntry).toBe(true);
    expect(plan.sourceFleet.entryMember).toBe("dev");
    expect(ids(plan.sourceFleet)).toEqual(["dev"]);
  });

  it("filters the moved agent's canTalkTo to destination members by default", () => {
    // "shared" exists in both Fleets, "lead" only in the source.
    const source = participant(
      fleet(
        "fleet_a",
        [agent("lead", ["mover"]), agent("mover", ["lead", "shared"]), agent("shared")],
        "lead",
      ),
    );
    const destination = participant(
      fleet("fleet_b", [agent("shared"), agent("other")], "shared"),
    );

    const plan = planFleetMove(source, destination, "mover", {}, false);

    // Only the destination-valid peer survives; the source-only peer is dropped.
    expect(plan.destinationAgent.canTalkTo).toEqual(["shared"]);
    expect(plan.destinationFleet.members.get("mover")!.recipients).toEqual(new Set(["shared"]));
    expect(ids(plan.destinationFleet)).toEqual(["mover", "other", "shared"]);
  });

  it("accepts a complete destination override and enforces its id and validity", () => {
    const source = () =>
      participant(fleet("fleet_a", [agent("lead", ["mover"]), agent("mover")], "lead"));
    const destination = () =>
      participant(fleet("fleet_b", [agent("builder"), agent("tester")], "builder"));

    // A mismatched override id is rejected.
    expect(() =>
      planFleetMove(source(), destination(), "mover", {
        destinationAgent: agent("renamed", ["builder"]),
      }, false),
    ).toThrow(/must equal the moved agent id/);

    // A destination-valid override is used verbatim.
    const plan = planFleetMove(source(), destination(), "mover", {
      destinationAgent: agent("mover", ["builder"]),
    }, false);
    expect(plan.destinationAgent.canTalkTo).toEqual(["builder"]);
    expect(plan.destinationFleet.members.get("mover")!.recipients).toEqual(new Set(["builder"]));

    // An override referencing an unknown destination member fails validation.
    expect(() =>
      planFleetMove(source(), destination(), "mover", {
        destinationAgent: agent("mover", ["nonexistent"]),
      }, false),
    ).toThrow(/Destination fleet "fleet_b" move is invalid/);
  });

  it("enforces the destination MCP and permission ceilings", () => {
    const source = () =>
      participant(fleet("fleet_a", [agent("lead", ["mover"]), agent("mover")], "lead"));

    // Destination lacks the requested MCP server.
    const restricted = participant(fleet("fleet_b", [agent("builder")], "builder"), ["docs"]);
    expect(() =>
      planFleetMove(source(), restricted, "mover", {
        destinationAgent: agent("mover", [], { mcpServers: ["secrets"] }),
      }, false),
    ).toThrow(/unavailable in "fleet_b"/);

    // approveAll requires the main command to grant --allow-all.
    const destination = () => participant(fleet("fleet_b", [agent("builder")], "builder"));
    const approveAllOverride = agent("mover", [], {
      permissions: { mode: "approveAll" },
    });
    expect(() =>
      planFleetMove(source(), destination(), "mover", { destinationAgent: approveAllOverride }, false),
    ).toThrow(/require the main Copilot command to include --allow-all/);
    expect(
      planFleetMove(source(), destination(), "mover", { destinationAgent: approveAllOverride }, true)
        .destinationAgent.id,
    ).toBe("mover");
  });

  it("rejects a destination agent whose tool allowlist widens the native ceiling", () => {
    const source = () =>
      participant(fleet("fleet_a", [agent("lead", ["mover"]), agent("mover")], "lead"));
    const destination = () => participant(fleet("fleet_b", [agent("builder")], "builder"));
    const widenOverride = agent("mover", [], {
      permissions: {
        tools: { allow: ["mcp:secret"], deny: [] },
        paths: { read: [], write: [] },
        commands: false,
        network: false,
        gitWrite: false,
        externalActions: false,
      },
    });

    // Native ceiling only permits builtin:* — a member requesting mcp:secret widens it.
    expect(() =>
      planFleetMove(source(), destination(), "mover", { destinationAgent: widenOverride }, true, [
        "builtin:*",
      ]),
    ).toThrow(/outside the main session allowlist/);

    // The same override is accepted when the native ceiling actually covers it.
    expect(
      planFleetMove(source(), destination(), "mover", { destinationAgent: widenOverride }, true, [
        "mcp:*",
      ]).destinationAgent.id,
    ).toBe("mover");

    // An empty native ceiling is unrestricted, so any subset is allowed.
    expect(
      planFleetMove(source(), destination(), "mover", { destinationAgent: widenOverride }, true, [])
        .destinationAgent.id,
    ).toBe("mover");
  });

  it("does not mutate its input Fleet definitions", () => {
    const sourceDefinition = fleet(
      "fleet_a",
      [agent("planner", ["dev"]), agent("dev")],
      "planner",
    );
    const source = participant(sourceDefinition);
    const destination = participant(fleet("fleet_b", [agent("host")], "host"));

    planFleetMove(source, destination, "dev", {}, false);

    // The live source definition is untouched; the plan holds fresh copies.
    expect(source.fleet.definition.agents.map((a) => a.id)).toEqual(["planner", "dev"]);
    expect(source.fleet.members.get("planner")!.recipients.has("dev")).toBe(true);
  });
});

describe("routeTarget", () => {
  it("routes only the exact unqualified 'standard' id to the Standard supervisor", () => {
    expect(routeTarget(STANDARD_TARGET)).toEqual({ kind: "standard" });
  });

  it("routes a qualified id to its Fleet member", () => {
    expect(routeTarget("fleet_a/planner")).toEqual({
      kind: "fleet",
      fleetId: "fleet_a",
      memberId: "planner",
    });
  });

  it("routes a qualified 'standard' member to its Fleet, never the supervisor", () => {
    // The bug routed anything whose raw member id was "standard" to Standard.
    expect(routeTarget("fleet_b/standard")).toEqual({
      kind: "fleet",
      fleetId: "fleet_b",
      memberId: "standard",
    });
  });

  it("rejects malformed targets instead of silently falling back to Standard", () => {
    for (const malformed of ["bogus", "", "/planner", "fleet_a/"]) {
      expect(() => routeTarget(malformed)).toThrow(/not a valid Fleet-qualified member id/);
    }
  });
});

describe("control-plane events use Fleet-qualified targets", () => {
  it("routes MCP auth events to the qualified target, not the raw member id", async () => {
    const events: Array<{ type: string; fields?: { memberId?: string } }> = [];
    const db = tempRuntimeDatabase();
    const runtime = new CopilotRuntime("E:\\repo", db, (type, _payload, fields) => {
      events.push({ type, fields });
    });
    const handler = (runtime as unknown as {
      mcpAuthHandler: (uiTarget: string) => (request: { serverName: string }) => Promise<unknown>;
    }).mcpAuthHandler("fleet_a/planner");

    const result = await handler({ serverName: "some-other-server" });

    expect(result).toEqual({ kind: "cancelled" });
    const authEvent = events.find((event) => event.type === "environment.error");
    expect(authEvent?.fields?.memberId).toBe("fleet_a/planner");
    db.close();
  });

  it("routes permission requests to the qualified target, not the raw member id", () => {
    const events: Array<{ type: string; fields?: { memberId?: string } }> = [];
    const db = tempRuntimeDatabase();
    const runtime = new CopilotRuntime("E:\\repo", db, (type, _payload, fields) => {
      events.push({ type, fields });
    });
    // A default (no --allow-all) main command means the ceiling-less handler emits a
    // permission request rather than auto-approving.
    expect((runtime as unknown as { policy: NativePolicy }).policy.allowAll).toBe(false);
    const handler = (runtime as unknown as {
      permissionHandler: (
        permission: undefined,
        uiTarget: string,
      ) => (request: unknown) => unknown;
    }).permissionHandler(undefined, "fleet_b/dev");

    void handler({ toolName: "shell" });

    const request = events.find((event) => event.type === "permission.requested");
    expect(request?.fields?.memberId).toBe("fleet_b/dev");
    db.close();
  });
});

describe("mutateFleetAddOrUpdate rollback", () => {
  it("restores in-memory and durable state when reconnect fails", async () => {
    const db = tempRuntimeDatabase();
    const runtime = new CopilotRuntime("E:\\repo", db, () => undefined);
    const definition = fleetDefinition(
      "fleet_a",
      [agentDefinition("planner", ["dev"]), agentDefinition("dev")],
      "planner",
    );
    const resolved = validateFleet(definition).fleet;
    if (!resolved) throw new Error("fixture fleet is invalid");
    const context = { runId: "run-1", fleet: resolved, mcpServers: new Set<string>() };
    (runtime as unknown as { fleets: Map<string, unknown> }).fleets.set("fleet_a", context);
    const jsonBefore = JSON.stringify({ definition, mcpServers: [] });
    db.createRun("run-1", "fleet", "fleet_a", "E:\\repo", 1001, jsonBefore);

    // Force the fallible reconnect step to fail after the definition is applied.
    (runtime as unknown as { reconnectChangedPeers: () => Promise<string[]> }).reconnectChangedPeers =
      () => {
        throw new Error("reconnect boom");
      };

    await expect(
      runtime.mutateFleetAddOrUpdate("fleet_a", agentDefinition("reviewer", [], { autoStart: false })),
    ).rejects.toThrow("reconnect boom");

    // No partial in-memory state: the rejected agent never persists in the context.
    expect([...context.fleet.members.keys()].sort()).toEqual(["dev", "planner"]);
    // No partial durable state: the stored definition is rolled back.
    const stored = db.fleetRun("run-1", "E:\\repo")?.fleetDefinition;
    expect(stored).toBeDefined();
    const storedAgents = (JSON.parse(stored!).definition.agents as Array<{ id: string }>)
      .map((entry) => entry.id)
      .sort();
    expect(storedAgents).toEqual(["dev", "planner"]);
    db.close();
  });
});

describe("delayed task refresh", () => {
  it("re-lists tasks using the qualified target, not the raw member id", async () => {
    vi.useFakeTimers();
    try {
      const db = tempRuntimeDatabase();
      db.createRun("run-1", "fleet", "fleet_a", "E:\\repo", 1001);
      const runtime = new CopilotRuntime("E:\\repo", db, () => undefined);
      let listCalls = 0;
      const live = {
        session: {
          rpc: {
            tasks: {
              list: async () => {
                listCalls += 1;
                return { tasks: [] };
              },
            },
          },
        },
        runId: "run-1",
        // Raw id and Fleet-qualified target deliberately differ, as they do for any
        // real Fleet member. The live map is keyed by the qualified target.
        memberId: "planner",
        target: "fleet_a/planner",
        fleetId: "fleet_a",
        recipients: new Set<string>(),
        modelId: undefined,
        aicUsed: 0,
        busy: false,
        sequence: 0,
        taskRefresh: 0,
        unsubscribe: () => undefined,
      };
      (runtime as unknown as { live: Map<string, unknown> }).live.set("fleet_a/planner", live);

      (runtime as unknown as {
        handleSessionEvent: (live: unknown, event: unknown) => void;
      }).handleSessionEvent(live, { id: "event-1", type: "tool.execution_complete", data: {} });

      await vi.advanceTimersByTimeAsync(600);

      // Immediate refresh plus the delayed one: the delayed lookup only re-fires when
      // this.live.get(live.target) === live. A raw-id lookup would miss it (count 1).
      expect(listCalls).toBe(2);
      db.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("foreground idle translation", () => {
  it("emits foreground idle only for the root assistant loop", () => {
    const events: Array<{ type: string; payload: unknown }> = [];
    const db = tempRuntimeDatabase();
    const runtime = new CopilotRuntime("E:\\repo", db, (type, payload) => {
      events.push({ type, payload });
    });
    db.createRun("run-standard", "standard", null, "E:\\repo", 1001);
    db.upsertSession("run-standard", "standard", "session-standard", "connected");
    const live = fakeLive({
      target: "standard",
      memberId: "standard",
      fleetId: "",
      runId: "run-standard",
      sessionId: "session-standard",
    });
    live.busy = true;
    live.foregroundBusy = true;
    (runtime as unknown as { live: Map<string, unknown> }).live.set("standard", live);
    const handle = (runtime as unknown as {
      handleSessionEvent: (live: unknown, event: unknown) => void;
    }).handleSessionEvent.bind(runtime);

    handle(live, {
      id: "root-idle",
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "assistant.idle",
      ephemeral: true,
      data: {},
    });
    handle(live, {
      id: "subagent-idle",
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "assistant.idle",
      agentId: "background-agent",
      ephemeral: true,
      data: {},
    });
    handle(live, {
      id: "subagent-turn-start",
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "assistant.turn_start",
      agentId: "background-agent",
      data: { turnId: "subagent-turn" },
    });

    expect(events.filter((event) => event.type === "member.foreground_idle")).toHaveLength(1);
    expect(events.some((event) => event.type === "member.state")).toBe(false);
    expect(live.busy).toBe(true);
    expect(live.foregroundBusy).toBe(false);
    expect(
      (runtime.status() as { members: Array<{ id: string; state: string }> }).members.find(
        (member) => member.id === "standard",
      )?.state,
    ).toBe("idle");
    db.close();
  });
});

describe("in-process reconnect suppresses history replay", () => {
  it("reconnectFleetMember reuses the live recovered session id and suppresses history", async () => {
    const db = tempRuntimeDatabase();
    const runtime = new CopilotRuntime("E:\\repo", db, () => undefined);
    const definition = fleetDefinition(
      "fleet_a",
      [agentDefinition("planner", ["dev"]), agentDefinition("dev")],
      "planner",
    );
    const resolved = validateFleet(definition).fleet;
    if (!resolved) throw new Error("fixture fleet is invalid");
    const context = { runId: "run-1", fleet: resolved, mcpServers: new Set<string>() };
    const recovered = fakeLive({
      target: "fleet_a/planner",
      memberId: "planner",
      fleetId: "fleet_a",
      runId: "run-1",
      sessionId: "session-from-previous-host",
      recipients: ["dev"],
    });
    (runtime as unknown as { live: Map<string, unknown> }).live.set(
      "fleet_a/planner",
      recovered,
    );
    let captured: unknown[] | undefined;
    (runtime as unknown as { connectSession: (...args: unknown[]) => Promise<unknown> }).connectSession =
      (...args: unknown[]) => {
        captured = args;
        return Promise.resolve({});
      };

    await (runtime as unknown as {
      reconnectFleetMember: (context: unknown, memberId: string) => Promise<void>;
    }).reconnectFleetMember(context, "planner");

    expect(captured).toBeDefined();
    // connectSession(runId, target, memberId, fleetId, sessionId, config, recipients,
    //   resumeExisting, suppressHistory)
    expect(captured![1]).toBe("fleet_a/planner");
    expect(captured![4]).toBe("session-from-previous-host");
    expect(captured![7]).toBe(true); // resumeExisting
    expect(captured![8]).toBe(true); // suppressHistory — the UI buffer is retained
    expect(recovered._disconnected.value).toBe(true);
    db.close();
  });
});

describe("Fleet recovery policy enforcement", () => {
  it("rejects a persisted approve-all Fleet under a newly restrictive native policy", async () => {
    const db = tempRuntimeDatabase();
    const definition = fleetDefinition(
      "fleet_a",
      [
        agentDefinition("planner", [], {
          permissions: { mode: "approveAll" },
        }),
      ],
      "planner",
    );
    db.createRun(
      "run-1",
      "fleet",
      "fleet_a",
      "E:\\repo",
      1001,
      JSON.stringify({ definition, mcpServers: [] }),
    );
    db.finishRun("run-1", "interrupted", "test recovery");
    const runtime = new CopilotRuntime("E:\\repo", db, () => undefined, "copilot.exe");

    await expect(runtime.resumeFleet("run-1")).rejects.toThrow(
      "approveAll child permissions require",
    );
    expect(db.fleetRun("run-1", "E:\\repo")?.status).toBe("interrupted");
    db.close();
  });
});

describe("Fleet mutation serialization", () => {
  it("runs operations for the same Fleet one at a time", async () => {
    const db = tempRuntimeDatabase();
    const runtime = new CopilotRuntime("E:\\repo", db, () => undefined);
    const order: string[] = [];
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolveEntered) => {
      firstEntered = resolveEntered;
    });
    const gate = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate;
    });
    const withFleetLocks = (
      runtime as unknown as {
        withFleetLocks: <T>(fleetIds: string[], operation: () => Promise<T>) => Promise<T>;
      }
    ).withFleetLocks.bind(runtime);

    const first = withFleetLocks(["fleet_a"], async () => {
      order.push("first:start");
      firstEntered();
      await gate;
      order.push("first:end");
    });
    await entered;
    const second = withFleetLocks(["fleet_a"], async () => {
      order.push("second");
    });
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
    db.close();
  });
});

describe("member tool ceiling enforcement", () => {
  const wideningProfile = {
    tools: { allow: ["mcp:secret"], deny: [] },
    paths: { read: [], write: [] },
    commands: false,
    network: false,
    gitWrite: false,
    externalActions: false,
  };

  it("rejects an add_agent_to_fleet allowlist that widens the native ceiling", async () => {
    const db = tempRuntimeDatabase();
    // The native ceiling permits only builtin tools; a member requesting mcp widens it.
    const runtime = new CopilotRuntime(
      "E:\\repo",
      db,
      () => undefined,
      "copilot.exe --available-tools=builtin:read",
    );
    const definition = fleetDefinition(
      "fleet_a",
      [agentDefinition("planner", ["dev"]), agentDefinition("dev")],
      "planner",
    );
    const resolved = validateFleet(definition).fleet;
    if (!resolved) throw new Error("fixture fleet is invalid");
    const context = { runId: "run-1", fleet: resolved, mcpServers: new Set<string>() };
    (runtime as unknown as { fleets: Map<string, unknown> }).fleets.set("fleet_a", context);
    db.createRun("run-1", "fleet", "fleet_a", "E:\\repo", 1001, JSON.stringify({ definition, mcpServers: [] }));

    await expect(
      runtime.mutateFleetAddOrUpdate(
        "fleet_a",
        agentDefinition("reviewer", [], { autoStart: false, permissions: wideningProfile }),
      ),
    ).rejects.toThrow(/outside the main session allowlist/);
    // No partial state: the rejected agent never entered the context.
    expect([...context.fleet.members.keys()].sort()).toEqual(["dev", "planner"]);
    db.close();
  });

  it("accepts a narrowed allowlist within the native ceiling", async () => {
    const db = tempRuntimeDatabase();
    const runtime = new CopilotRuntime(
      "E:\\repo",
      db,
      () => undefined,
      "copilot.exe --available-tools=builtin:read --available-tools=builtin:search",
    );
    const definition = fleetDefinition(
      "fleet_a",
      [agentDefinition("planner", ["dev"]), agentDefinition("dev")],
      "planner",
    );
    const resolved = validateFleet(definition).fleet;
    if (!resolved) throw new Error("fixture fleet is invalid");
    const context = { runId: "run-1", fleet: resolved, mcpServers: new Set<string>() };
    (runtime as unknown as { fleets: Map<string, unknown> }).fleets.set("fleet_a", context);
    db.createRun("run-1", "fleet", "fleet_a", "E:\\repo", 1001, JSON.stringify({ definition, mcpServers: [] }));

    const narrowed = {
      tools: { allow: ["builtin:read"], deny: [] },
      paths: { read: [], write: [] },
      commands: false,
      network: false,
      gitWrite: false,
      externalActions: false,
    };
    // autoStart false + no live members means no SDK session is created here.
    const result = await runtime.mutateFleetAddOrUpdate(
      "fleet_a",
      agentDefinition("reviewer", [], { autoStart: false, permissions: narrowed }),
    );
    expect(result.action).toBe("added");
    expect([...context.fleet.members.keys()].sort()).toEqual(["dev", "planner", "reviewer"]);
    db.close();
  });
});

describe("live membership capture and restore", () => {
  it("restores a vanished member from its captured session id, leaving present members untouched", async () => {
    const db = tempRuntimeDatabase();
    db.createRun("run-1", "fleet", "fleet_a", "E:\\repo", 1001);
    const runtime = new CopilotRuntime("E:\\repo", db, () => undefined);
    const definition = fleetDefinition(
      "fleet_a",
      [agentDefinition("planner", ["dev"]), agentDefinition("dev")],
      "planner",
    );
    const resolved = validateFleet(definition).fleet;
    if (!resolved) throw new Error("fixture fleet is invalid");
    const context = { runId: "run-1", fleet: resolved, mcpServers: new Set<string>() };
    const liveMap = (runtime as unknown as { live: Map<string, unknown> }).live;
    const plannerLive = fakeLive({
      target: "fleet_a/planner",
      memberId: "planner",
      fleetId: "fleet_a",
      runId: "run-1",
      sessionId: "sess-planner",
      recipients: ["dev"],
    });
    liveMap.set("fleet_a/planner", plannerLive);
    liveMap.set(
      "fleet_a/dev",
      fakeLive({
        target: "fleet_a/dev",
        memberId: "dev",
        fleetId: "fleet_a",
        runId: "run-1",
        sessionId: "sess-dev",
      }),
    );

    const snapshot = (runtime as unknown as {
      captureLiveMembers: (ctx: unknown, ids: string[]) => unknown[];
    }).captureLiveMembers(context, ["planner", "dev"]);
    expect(snapshot).toHaveLength(2);

    // Simulate the dev live entry vanishing mid-failure.
    liveMap.delete("fleet_a/dev");

    const calls: unknown[][] = [];
    (runtime as unknown as { connectSession: (...args: unknown[]) => Promise<unknown> }).connectSession =
      (...args: unknown[]) => {
        calls.push(args);
        const [runId, target, memberId, fleetId, sessionId, , recipients] = args as [
          string,
          string,
          string,
          string,
          string,
          unknown,
          Set<string>,
        ];
        const live = fakeLive({ target, memberId, fleetId, runId, sessionId, recipients: [...recipients] });
        liveMap.set(target, live);
        return Promise.resolve(live);
      };

    await (runtime as unknown as {
      restoreLiveMembers: (ctx: unknown, snap: unknown) => Promise<void>;
    }).restoreLiveMembers(context, snapshot);

    // Only the missing member is reconnected, resuming its exact captured session id.
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toBe("fleet_a/dev");
    expect(calls[0]![4]).toBe("sess-dev");
    expect(calls[0]![7]).toBe(true); // resumeExisting
    expect(calls[0]![8]).toBe(true); // suppressHistory
    // The still-present planner entry is the original object, untouched.
    expect(liveMap.get("fleet_a/planner")).toBe(plannerLive);
    expect(liveMap.has("fleet_a/dev")).toBe(true);
    db.close();
  });
});

describe("mutateFleetRemove rollback", () => {
  it("restores the removed member's live session when a peer reconnect fails", async () => {
    const db = tempRuntimeDatabase();
    const runtime = new CopilotRuntime("E:\\repo", db, () => undefined);
    const definition = fleetDefinition(
      "fleet_a",
      [agentDefinition("planner", ["dev"]), agentDefinition("dev")],
      "planner",
    );
    const resolved = validateFleet(definition).fleet;
    if (!resolved) throw new Error("fixture fleet is invalid");
    const context = { runId: "run-1", fleet: resolved, mcpServers: new Set<string>() };
    (runtime as unknown as { fleets: Map<string, unknown> }).fleets.set("fleet_a", context);
    db.createRun("run-1", "fleet", "fleet_a", "E:\\repo", 1001, JSON.stringify({ definition, mcpServers: [] }));

    const liveMap = (runtime as unknown as { live: Map<string, unknown> }).live;
    liveMap.set(
      "fleet_a/planner",
      fakeLive({
        target: "fleet_a/planner",
        memberId: "planner",
        fleetId: "fleet_a",
        runId: "run-1",
        sessionId: "sess-planner",
        recipients: ["dev"],
      }),
    );
    liveMap.set(
      "fleet_a/dev",
      fakeLive({
        target: "fleet_a/dev",
        memberId: "dev",
        fleetId: "fleet_a",
        runId: "run-1",
        sessionId: "sess-dev",
      }),
    );

    let reconnectCalls = 0;
    (runtime as unknown as { reconnectChangedPeers: () => Promise<string[]> }).reconnectChangedPeers =
      () => {
        reconnectCalls += 1;
        if (reconnectCalls === 1) {
          throw new Error("reconnect boom");
        }
        return Promise.resolve([]);
      };
    (runtime as unknown as { connectSession: (...args: unknown[]) => Promise<unknown> }).connectSession =
      (...args: unknown[]) => {
        const [runId, target, memberId, fleetId, sessionId, , recipients] = args as [
          string,
          string,
          string,
          string,
          string,
          unknown,
          Set<string>,
        ];
        const live = fakeLive({ target, memberId, fleetId, runId, sessionId, recipients: [...recipients] });
        liveMap.set(target, live);
        return Promise.resolve(live);
      };

    await expect(runtime.mutateFleetRemove("fleet_a", "dev")).rejects.toThrow("reconnect boom");

    // The removed member's live session is restored and the definition rolled back.
    expect(liveMap.has("fleet_a/dev")).toBe(true);
    expect([...context.fleet.members.keys()].sort()).toEqual(["dev", "planner"]);
    const stored = db.fleetRun("run-1", "E:\\repo")?.fleetDefinition;
    const storedAgents = (JSON.parse(stored!).definition.agents as Array<{ id: string }>)
      .map((entry) => entry.id)
      .sort();
    expect(storedAgents).toEqual(["dev", "planner"]);
    db.close();
  });
});

describe("mutateFleetMove rollback", () => {
  function moveFixture(runtime: CopilotRuntime, db: FleetDatabase) {
    const sourceDefinition = fleetDefinition(
      "fleet_a",
      [agentDefinition("planner", []), agentDefinition("dev", ["tester"]), agentDefinition("tester")],
      "planner",
    );
    const destinationDefinition = fleetDefinition("fleet_b", [agentDefinition("builder")], "builder");
    const source = { runId: "run-a", fleet: validateFleet(sourceDefinition).fleet!, mcpServers: new Set<string>() };
    const destination = {
      runId: "run-b",
      fleet: validateFleet(destinationDefinition).fleet!,
      mcpServers: new Set<string>(),
    };
    const fleets = (runtime as unknown as { fleets: Map<string, unknown> }).fleets;
    fleets.set("fleet_a", source);
    fleets.set("fleet_b", destination);
    db.createRun("run-a", "fleet", "fleet_a", "E:\\repo", 1001, JSON.stringify({ definition: sourceDefinition, mcpServers: [] }));
    db.createRun("run-b", "fleet", "fleet_b", "E:\\repo", 1001, JSON.stringify({ definition: destinationDefinition, mcpServers: [] }));
    return { source, destination };
  }

  it("leaves the original session intact when the move fails before disconnecting it", async () => {
    const db = tempRuntimeDatabase();
    const runtime = new CopilotRuntime("E:\\repo", db, () => undefined);
    const { source, destination } = moveFixture(runtime, db);
    const liveMap = (runtime as unknown as { live: Map<string, unknown> }).live;
    const testerLive = fakeLive({
      target: "fleet_a/tester",
      memberId: "tester",
      fleetId: "fleet_a",
      runId: "run-a",
      sessionId: "sess-tester",
    });
    liveMap.set("fleet_a/tester", testerLive);
    liveMap.set(
      "fleet_a/dev",
      fakeLive({ target: "fleet_a/dev", memberId: "dev", fleetId: "fleet_a", runId: "run-a", sessionId: "sess-dev", recipients: ["tester"] }),
    );
    db.enqueueMessage("mv-1", "run-a", "dev", "tester", "agent", "pending work");

    // Fail on the very first reconnect (source peers), before the original is touched.
    (runtime as unknown as { reconnectChangedPeers: () => Promise<string[]> }).reconnectChangedPeers =
      () => {
        throw new Error("source reconnect boom");
      };

    await expect(runtime.mutateFleetMove("fleet_a", "fleet_b", "tester")).rejects.toThrow(
      "source reconnect boom",
    );

    // The original session is untouched (never detached or disconnected).
    expect(liveMap.get("fleet_a/tester")).toBe(testerLive);
    expect(testerLive._disconnected.value).toBe(false);
    expect(liveMap.has("fleet_b/tester")).toBe(false);
    // Contexts rolled back.
    expect([...source.fleet.members.keys()].sort()).toEqual(["dev", "planner", "tester"]);
    expect(destination.fleet.members.has("tester")).toBe(false);
    // Mailbox never settled because the move never committed.
    const message = db.snapshot().messages.find((entry) => entry.id === "mv-1");
    expect(message?.status).toBe("pending");
    db.close();
  });

  it("removes the destination session, restores the source, and un-settles mail when the move fails after connecting", async () => {
    const db = tempRuntimeDatabase();
    const runtime = new CopilotRuntime("E:\\repo", db, () => undefined);
    const { source, destination } = moveFixture(runtime, db);
    const liveMap = (runtime as unknown as { live: Map<string, unknown> }).live;
    liveMap.set(
      "fleet_a/tester",
      fakeLive({ target: "fleet_a/tester", memberId: "tester", fleetId: "fleet_a", runId: "run-a", sessionId: "sess-tester" }),
    );
    liveMap.set(
      "fleet_a/dev",
      fakeLive({ target: "fleet_a/dev", memberId: "dev", fleetId: "fleet_a", runId: "run-a", sessionId: "sess-dev", recipients: ["tester"] }),
    );
    db.upsertSession("run-a", "tester", "sess-tester", "connected");
    db.enqueueMessage("mv-1", "run-a", "dev", "tester", "agent", "pending work");
    db.enqueueMessage("mv-2", "run-a", "planner", "tester", "agent", "more work");

    let reconnectCalls = 0;
    (runtime as unknown as { reconnectChangedPeers: () => Promise<string[]> }).reconnectChangedPeers =
      () => {
        reconnectCalls += 1;
        if (reconnectCalls === 2) {
          // Fail on the destination reconnect, after the destination session connected
          // and the source mailbox was settled.
          throw new Error("destination reconnect boom");
        }
        return Promise.resolve([]);
      };
    (runtime as unknown as { connectSession: (...args: unknown[]) => Promise<unknown> }).connectSession =
      (...args: unknown[]) => {
        const [runId, target, memberId, fleetId, sessionId, , recipients] = args as [
          string,
          string,
          string,
          string,
          string,
          unknown,
          Set<string>,
        ];
        const live = fakeLive({ target, memberId, fleetId, runId, sessionId, recipients: [...recipients] });
        liveMap.set(target, live);
        return Promise.resolve(live);
      };

    await expect(runtime.mutateFleetMove("fleet_a", "fleet_b", "tester")).rejects.toThrow(
      "destination reconnect boom",
    );

    // No orphan destination session and no duplicate: exactly one live entry for tester.
    expect(liveMap.has("fleet_b/tester")).toBe(false);
    expect(liveMap.has("fleet_a/tester")).toBe(true);
    const testerLiveKeys = [...liveMap.keys()].filter((key) => key.endsWith("/tester"));
    expect(testerLiveKeys).toEqual(["fleet_a/tester"]);
    // Contexts rolled back.
    expect([...source.fleet.members.keys()].sort()).toEqual(["dev", "planner", "tester"]);
    expect(destination.fleet.members.has("tester")).toBe(false);
    // The settled source mailbox was restored to pending, not migrated or lost.
    const messages = db.snapshot().messages.filter((entry) => entry.id.startsWith("mv-"));
    expect(messages.every((entry) => entry.status === "pending")).toBe(true);
    // The persisted session record is back on the source run.
    const sessions = db.snapshot().sessions as Array<{ run_id: string; member_id: string }>;
    const testerSession = sessions.find((entry) => entry.member_id === "tester");
    expect(testerSession?.run_id).toBe("run-a");
    db.close();
  });
});
