import assert from "node:assert/strict";
import test from "node:test";
import {
  AssistantResponseCorrelation,
  compactHistoryEvents,
  parseAgentMessagePrompt,
} from "../dist/runtime.js";

test("keeps one logical response across changed SDK message IDs", () => {
  const correlation = new AssistantResponseCorrelation();

  assert.equal(correlation.delta("stream-message", "turn-1"), "stream-message");
  assert.equal(correlation.delta("stream-message", "turn-1"), "stream-message");
  assert.deepEqual(
    correlation.message("empty-message", "turn-1", ""),
    { responseId: "stream-message", render: false },
  );
  assert.deepEqual(
    correlation.message("final-message", "turn-1", "Completed response."),
    { responseId: "stream-message", render: true },
  );
  assert.equal(correlation.snapshot(), undefined);
});

test("does not correlate responses across turns", () => {
  const correlation = new AssistantResponseCorrelation();

  correlation.delta("first-stream", "turn-1");
  assert.deepEqual(
    correlation.message("second-message", "turn-2", "Different turn."),
    { responseId: "second-message", render: true },
  );
});

test("preserves an active correlation across connection replacement", () => {
  const original = new AssistantResponseCorrelation();
  original.delta("stream-message", "turn-1");

  const restored = new AssistantResponseCorrelation(original.snapshot());
  assert.deepEqual(
    restored.message("final-message", "turn-1", "Completed response."),
    { responseId: "stream-message", render: true },
  );
});

test("extracts durable agent prompts for attributed history replay", () => {
  const prompt =
    '<agent_message id="mail-1" source="planner">\n' +
    "Review the implementation.\n" +
    "</agent_message>\n\n" +
    "Process this durable message from another Copilot agent. Respond or act as appropriate.";
  assert.deepEqual(parseAgentMessagePrompt(prompt), {
    id: "mail-1",
    source: "planner",
    content: "Review the implementation.",
  });

  const [event] = compactHistoryEvents([{
    id: "sdk-user-message",
    type: "user.message",
    timestamp: "2026-09-22T20:00:00.000Z",
    data: { content: prompt },
  }]);
  assert.deepEqual(event.data, {
    content: "Review the implementation.",
    source: "agent-message",
    sourceAlias: "planner",
    agentMessageId: "mail-1",
  });
});
