import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  dynamicFleetSchema,
  fleetConfigSchema,
  validateConfig,
  validateFleet,
} from "../src/config.js";
import type { DynamicFleetDefinition, FleetConfig } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));

async function exampleConfig(): Promise<FleetConfig> {
  const text = await readFile(resolve(here, "..", "examples", "fleets.json"), "utf8");
  return fleetConfigSchema.parse(JSON.parse(text)) as FleetConfig;
}

describe("dynamic fleet configuration", () => {
  it("treats configured fleets as examples instead of predefined launch targets", async () => {
    const config = await exampleConfig();
    expect(validateConfig(config)).toEqual([]);
    expect(config.fleetExamples).toHaveLength(1);
    expect(config).not.toHaveProperty("fleets");
    expect(config).not.toHaveProperty("agents");
  });

  it("resolves runtime-defined agents and peer communication", async () => {
    const definition = (await exampleConfig()).fleetExamples[0]!;
    const result = validateFleet(definition);

    expect(result.valid).toBe(true);
    expect(result.fleet?.entryMember).toBe("planner");
    expect(result.fleet?.members.get("planner")?.recipients).toEqual(
      new Set(["implementer", "reviewer"]),
    );
    expect(result.fleet?.members.get("implementer")?.permission).toEqual({ mode: "inherit" });
  });

  it("rejects duplicate runtime agent IDs", async () => {
    const definition = structuredClone((await exampleConfig()).fleetExamples[0]!);
    definition.agents[1]!.id = "planner";

    expect(validateFleet(definition).issues).toContainEqual({
      path: "fleet.agents.1.id",
      message: 'duplicates agent "planner"',
    });
  });

  it("rejects peer tools targeting unknown agents", async () => {
    const definition = structuredClone((await exampleConfig()).fleetExamples[0]!);
    definition.agents[0]!.canTalkTo.push("tester");

    expect(validateFleet(definition).issues).toContainEqual({
      path: "fleet.agents.0.canTalkTo",
      message: 'references unknown agent "tester"',
    });
  });

  it("uses tool-safe agent IDs", async () => {
    const definition = structuredClone((await exampleConfig()).fleetExamples[0]!);
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
