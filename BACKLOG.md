# Backlog

## Timeline and task presentation

### NC-001: Render background work as correlated actor events

**Status:** Completed

Tasks, schedules, and asynchronous tool completions should behave like additional participants in
the conversation rather than mutable status rows whose original event time and state disappear.

**Target behavior**

- Emit a separate row for each meaningful lifecycle event: started, completed, failed, or cancelled.
- Prefix task events with `🧑‍💻` and schedule events with `⏰`.
- Render asynchronous tool completions under a `🛠️ Tool` actor while keeping calls compact.
- Include the same short identifier on every event for one task, schedule, or asynchronous tool.
- Keep start rows concise and place output/error summaries on terminal rows.
- Preserve the full event payload in the detail view.
- Link successful and failed shell tool completions back to their background task when a task ID is
  available.

**Acceptance criteria**

- Start and terminal events occupy separate chronological rows.
- Related rows expose the same visible identifier.
- Completed, failed, and cancelled events are visually distinct.
- Opening a terminal row exposes full output or error details when available.
- Automated and real UI tests cover task, schedule, and asynchronous tool lifecycle events.

### NC-002: Fold consecutive reasoning as one block

**Status:** Completed

Consecutive reasoning messages in one response must share one fold even when each message is
streamed and later replaced by its final content.

**Acceptance criteria**

- Adjacent reasoning messages produce one fold start.
- Closing that fold hides every consecutive reasoning message.
- Opening it restores all messages in their original order.
- Replacing streamed content does not move the fold start to the latest message.

### NC-003: Keep startup environment rows together

**Status:** Completed

Late MCP connection events, including `github-mcp-server`, must remain in the startup environment
block instead of appearing after the first user message.

**Acceptance criteria**

- Every startup environment row appears before the first user heading.
- A late MCP connection is inserted after the existing environment rows.
- Updating an existing environment component does not duplicate or move its row.
