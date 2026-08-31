# Backlog

## Timeline and task presentation

### NC-001: Render background work as correlated actor events

**Status:** Completed

Tasks, schedules, and asynchronous tool completions should behave like additional participants in
the conversation rather than mutable status rows whose original event time and state disappear.

**Target behavior**

- Emit a separate row for each meaningful lifecycle event: started, completed, failed, or cancelled.
- Prefix full task participant messages with `🧑‍💻` and schedule messages with `⏰`.
- Represent asynchronous shell launches as task lifecycle rows instead of redundant tool
  completion messages.
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

**Status:** Completed

Compact task rows should use their status indicator and `[task][<runtime-id>]` identifier without
also displaying the actor emoji. Keep the emoji on full `Task` participant headers.

**Acceptance criteria**

- Compact task start rows do not include the actor emoji.
- Full task completion, failure, and cancellation participant headers retain the Task actor emoji.
- Task status indicators and correlation identifiers remain unchanged.

### NC-005: Standardize lifecycle event labels

**Status:** Completed

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

### NC-006: Distinguish compact lifecycle rows without blockquotes

**Status:** Completed

Remove the `>` blockquote marker from compact tool and task lifecycle rows. Highlight the complete
row with the same foreground color used by the `Task` participant header instead.

**Acceptance criteria**

- Compact task and tool rows retain their existing indentation without a `>` marker.
- The complete compact row uses `NativeCopilotActorHeader`, including the end of the line.
- Environment, permission, and schedule row presentation remains unchanged.

### NC-007: Add Task-colored backgrounds to task participant messages

**Status:** Pending

Give full `Task` participant messages a background derived from the current foreground color of the
Task header. The background should visually group the header, lifecycle row, and task result while
remaining readable across color schemes.

**Acceptance criteria**

- Resolve the active `NativeCopilotActorHeader` color after setup and every `ColorScheme` change.
- Derive a readable background rather than hard-coding a theme-specific color.
- Apply the background to the complete Task participant message without affecting adjacent chat
  content.
- Preserve readable status indicators, task output, and timestamps in light and dark themes.
- Add automated and visible UI coverage.

### NC-008: Safely interleave task messages with streaming Copilot responses

**Status:** Pending

Validate and, if necessary, fix task participant messages that arrive while Copilot is still
streaming a response. The asynchronous event must not corrupt, split incorrectly, reorder, or
become absorbed into the active Copilot message.

**Acceptance criteria**

- A task terminal message arriving during an active Copilot response is rendered immediately and
  remains a separate participant message.
- Subsequent Copilot deltas continue in the correct response block without overwriting or moving
  the task message.
- Finalizing the Copilot response preserves chronological event order and spacing.
- Multiple task messages can arrive during one streamed response without duplication.
- Automated tests cover task completion, failure, and cancellation during streaming.
- A real configured `ai` test confirms the visible interleaving behavior.
