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

### NC-004: Remove actor emoji from compact task rows

**Status:** Pending

Compact task rows should use their status indicator and `[task #T-...]` identifier without also
displaying the actor emoji. Keep the emoji on full `Task` participant headers.

**Acceptance criteria**

- Compact task start rows do not include the actor emoji.
- Full task completion, failure, and cancellation participant headers retain the Task actor emoji.
- Task status indicators and correlation identifiers remain unchanged.

### NC-005: Standardize lifecycle event labels

**Status:** Pending

Use a shared `[type][<runtime-id>]` format for task, tool, schedule, and other correlated lifecycle
events. Remove synthetic identifier prefixes such as `#T-`, `#C-`, and `#S-`, and do not surround
event labels with Markdown `**` markers.

**Acceptance criteria**

- Correlated rows render identifiers such as `[task][0]`, `[tool][toolu_123]`, and
  `[schedule][41]`.
- Synthetic `#T-`, `#C-`, and `#S-` prefixes are removed.
- Lifecycle event labels are not wrapped in Markdown bold markers.
- Start and terminal events display the same runtime identifier.
- Detail lookup and lifecycle correlation continue to work for every supported event type.
