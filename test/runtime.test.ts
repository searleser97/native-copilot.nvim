import { describe, expect, it } from "vitest";
import { instanceSessionId } from "../src/runtime.js";

describe("instanceSessionId", () => {
  it("reuses a session within one Neovim host instance", () => {
    const first = instanceSessionId("E:\\repo", "instance-a", "standard", "copilot");
    const second = instanceSessionId("E:\\repo", "instance-a", "standard", "copilot");

    expect(second).toBe(first);
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
});
