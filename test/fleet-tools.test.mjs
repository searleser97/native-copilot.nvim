import assert from "node:assert/strict";
import test from "node:test";
import { FLEET_TOOL_NAMES } from "../dist/runtime.js";

test("fleet tools distinguish real-team management from real-agent actions", () => {
  assert.deepEqual(FLEET_TOOL_NAMES, {
    spawnAgents: "real_team_spawn_agents",
    updateAgent: "real_team_update_agent",
    removeAgent: "real_team_remove_agent",
    listAgents: "real_team_list_agents",
    listRecipients: "real_agent_list_recipients",
    sendMessage: "real_agent_send_message",
    readActivity: "real_agent_read_activity",
    sendToAgent: "real_agent_send_to_agent",
  });
  assert.equal(
    Object.values(FLEET_TOOL_NAMES).some((name) => name.startsWith("native_copilot_")),
    false,
  );
});
