import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  fleetConfigSchema,
  fleetSummaries,
  validateConfig,
  validateFleet,
  validateHostConfig,
} from "../src/config.js";
import type { FleetConfig } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));

async function exampleConfig(): Promise<FleetConfig> {
  const text = await readFile(resolve(here, "..", "examples", "fleets.json"), "utf8");
  return fleetConfigSchema.parse(JSON.parse(text)) as FleetConfig;
}

describe("fleet configuration", () => {
  it("accepts the editable engineering example", async () => {
    const config = await exampleConfig();
    expect(validateConfig(config, "C:\\work")).toEqual([]);
    const result = validateFleet(config, "engineering", "C:\\work");
    expect(result.valid).toBe(true);
    expect(result.fleet?.members.get("planner")?.recipients).toContain("coordinator");
    expect(result.fleet?.members.get("planner")?.reasoningSummary).toBe("detailed");
    expect(result.fleet?.members.get("planner")?.permission?.commands).toBe(false);
    expect(result.fleet?.members.get("implementer")?.permission).toBeUndefined();
  });

  it("rejects a missing coordinator fallback edge", async () => {
    const config = await exampleConfig();
    config.fleets.engineering!.members.planner!.recipients = ["implementer"];
    const result = validateFleet(config, "engineering", "C:\\work");
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({
      path: "fleets.engineering.members.planner.recipients",
      message: 'must directly include coordinator "coordinator"',
    });
  });

  it("rejects permission elevation through path overrides", async () => {
    const config = await exampleConfig();
    config.fleets.engineering!.members.planner!.permissionNarrowing = {
      writePaths: ["C:\\outside"],
    };
    const result = validateFleet(config, "engineering", "C:\\work");
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes("exceeds"))).toBe(true);
  });

  it("defaults agents without permissions to unrestricted native behavior", async () => {
    const config = await exampleConfig();
    delete config.standard.permissions;
    delete config.standard.permissionProfile;
    delete config.agents.implementer!.permissions;
    delete config.agents.implementer!.permissionProfile;

    expect(validateConfig(config, "C:\\work")).toEqual([]);
    expect(
      validateFleet(config, "engineering", "C:\\work").fleet?.members.get("implementer")
        ?.permission,
    ).toBeUndefined();
  });

  it("rejects dangling recipients before startup", async () => {
    const config = await exampleConfig();
    config.fleets.engineering!.members.reviewer!.recipients.push("ghost");
    const result = validateFleet(config, "engineering", "C:\\work");
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes('unknown member "ghost"'))).toBe(
      true,
    );
  });

  it("keeps the host usable while marking an invalid Fleet", async () => {
    const config = await exampleConfig();
    config.fleets.engineering!.members.reviewer!.recipients.push("ghost");
    expect(validateHostConfig(config)).toEqual([]);
    expect(fleetSummaries(config, "C:\\work")).toContainEqual(
      expect.objectContaining({
        id: "engineering",
        valid: false,
        issues: expect.arrayContaining([
          expect.objectContaining({ message: 'references unknown member "ghost"' }),
        ]),
      }),
    );
  });
});
