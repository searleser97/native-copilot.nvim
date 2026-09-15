import assert from "node:assert/strict";
import test from "node:test";
import { FLEET_TOOL_NAMES } from "../dist/runtime.js";

test("fleet tools expose one-agent provisioning and session-owned rules", () => {
  assert.deepEqual(FLEET_TOOL_NAMES, {
    create: "real_agent_create",
    get: "real_agent_get",
    list: "real_agent_list",
    getRules: "real_agent_get_rules",
    updateRules: "real_agent_update_rules",
    remove: "real_agent_remove",
    listRecipients: "real_agent_list_recipients",
    sendMessage: "real_agent_send_message",
    readActivity: "real_agent_read_activity",
  });
  assert.equal(
    Object.values(FLEET_TOOL_NAMES).some(
      (name) => name.startsWith("native_copilot_") || name.startsWith("real_team_"),
    ),
    false,
  );
});
