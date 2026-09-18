import assert from "node:assert/strict";
import test from "node:test";
import { AssistantResponseCorrelation } from "../dist/runtime.js";

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
