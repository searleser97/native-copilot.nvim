import { describe, expect, it } from "vitest";
import {
  configuredRuntimeConnection,
  instanceSessionId,
  permissionDecision,
  runtimeSessionOptions,
  usesApproveAll,
} from "../src/runtime.js";

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
        });
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
