import { describe, expect, it } from "vitest";
import { dynamicFleetSchema, validateFleet } from "../src/config.js";
import type { DynamicFleetDefinition } from "../src/types.js";

const exampleFleet: DynamicFleetDefinition = {
  id: "engineering_review",
  name: "Engineering Review",
  description: "Plans, implements, and reviews an engineering change.",
  objective: "Complete the requested engineering change.",
  entryAgent: "planner",
  agents: [
    {
      id: "planner",
      displayName: "Planner",
      description: "Plans the change.",
      prompt: "Investigate and send a plan to the implementer.",
      permissions: { mode: "prompt" },
      canTalkTo: ["implementer", "reviewer"],
    },
    {
      id: "implementer",
      displayName: "Implementer",
      description: "Implements the change.",
      prompt: "Implement and send the result to the reviewer.",
      permissions: { mode: "inherit" },
      canTalkTo: ["planner", "reviewer"],
    },
    {
      id: "reviewer",
      displayName: "Reviewer",
      description: "Reviews the change.",
      prompt: "Review and report findings.",
      permissions: { mode: "prompt" },
      canTalkTo: ["planner", "implementer"],
    },
  ],
};

describe("dynamic fleet configuration", () => {
  it("resolves runtime-defined agents and peer communication", () => {
    const definition = structuredClone(exampleFleet);
    const result = validateFleet(definition);

    expect(result.valid).toBe(true);
    expect(result.fleet?.entryMember).toBe("planner");
    expect(result.fleet?.members.get("planner")?.recipients).toEqual(
      new Set(["implementer", "reviewer"]),
    );
    expect(result.fleet?.members.get("implementer")?.permission).toEqual({ mode: "inherit" });
  });

  it("rejects duplicate runtime agent IDs", () => {
    const definition = structuredClone(exampleFleet);
    definition.agents[1]!.id = "planner";

    expect(validateFleet(definition).issues).toContainEqual({
      path: "fleet.agents.1.id",
      message: 'duplicates agent "planner"',
    });
  });

  it("rejects peer tools targeting unknown agents", () => {
    const definition = structuredClone(exampleFleet);
    definition.agents[0]!.canTalkTo.push("tester");

    expect(validateFleet(definition).issues).toContainEqual({
      path: "fleet.agents.0.canTalkTo",
      message: 'references unknown agent "tester"',
    });
  });

  it("uses tool-safe agent IDs", () => {
    const definition = structuredClone(exampleFleet);
    definition.agents[0]!.id = "planning-agent";

    expect(dynamicFleetSchema.safeParse(definition).success).toBe(false);
  });

  it("accepts an LLM-generated fleet with explicit permissions and MCP selection", () => {
    const definition: DynamicFleetDefinition = {
      id: "focused_test",
      name: "Focused Test",
      description: "A generated implementation and test fleet.",
      objective: "Implement and test the requested change.",
      entryAgent: "builder",
      agents: [
        {
          id: "builder",
          displayName: "Builder",
          description: "Builds the change.",
          prompt: "Implement the requested change.",
          permissions: { mode: "approveAll" },
          mcpServers: ["myado"],
          canTalkTo: ["tester"],
        },
        {
          id: "tester",
          displayName: "Tester",
          description: "Tests the change.",
          prompt: "Test the implementation.",
          permissions: { mode: "prompt" },
          canTalkTo: ["builder"],
        },
      ],
    };

    expect(validateFleet(definition)).toEqual(
      expect.objectContaining({ valid: true, issues: [] }),
    );
  });
});
