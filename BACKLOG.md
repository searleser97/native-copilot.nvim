# Backlog

## Timeline and task presentation

### NC-001: Render background work as correlated actor events

**Status:** Completed

Tasks, schedules, and asynchronous tool completions should behave like additional participants in
the conversation rather than mutable status rows whose original event time and state disappear.

**Target behavior**

- Emit a separate row for each meaningful lifecycle event: started, completed, failed, or cancelled.
- Prefix full task participant messages with `📝` and schedule messages with `⏰`.
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

Compact task rows should use their status indicator and searchable `[task_<hash>]` identifier
without also displaying the actor emoji. Keep the emoji on full `Task` participant headers.

**Acceptance criteria**

- Compact task start rows do not include the actor emoji.
- Full task completion, failure, and cancellation participant headers retain the Task actor emoji.
- Task status indicators and correlation identifiers remain unchanged.

### NC-005: Standardize lifecycle event labels

**Status:** Completed

Use concise searchable identifiers for correlated lifecycle events. Tool rows use the native call
ID directly, Task rows use a deterministic `[task_<hash>]` display ID, and other event kinds retain
their typed identifier format. Do not surround event labels with Markdown `**` markers.

**Acceptance criteria**

- Correlated rows render identifiers such as `[task_a94a8fe5ccb19ba6]`, `[toolu_123]`, and
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

**Status:** Completed

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

**Status:** Completed

Validate and, if necessary, fix task participant messages that arrive while Copilot is still
streaming a response. The asynchronous event must not corrupt, split incorrectly, reorder, or
become absorbed into the active Copilot message.

This immediate-interleaving behavior was later superseded by NC-009.

**Acceptance criteria**

- A task terminal message arriving during an active Copilot response is rendered immediately and
  remains a separate participant message.
- Subsequent Copilot deltas continue in the correct response block without overwriting or moving
  the task message.
- Finalizing the Copilot response preserves chronological event order and spacing.
- Multiple task messages can arrive during one streamed response without duplication.
- Automated tests cover task completion, failure, and cancellation during streaming.
- A real configured `ai` test confirms the visible interleaving behavior.

### NC-009: Defer terminal actor messages until Copilot finishes

**Status:** Completed

Do not insert full Task or Tool participant messages into the middle of an actively streaming
Copilot response. Queue those asynchronous terminal messages and render them immediately after the
current Copilot message completes. Scheduler events retain their immediate delivery behavior
because they can introduce a new scheduled user turn.

**Acceptance criteria**

- A terminal actor event received during streaming is retained without appearing inside the
  partial Copilot text.
- Copilot finishes its response without a task message splitting a sentence, word, list item, or
  Markdown block.
- Deferred actor messages render immediately after response completion in their original arrival
  order and retain their original event timestamps.
- Multiple completion, failure, and cancellation events are not duplicated or lost.
- Events received while no Copilot response is active continue to render immediately.
- Automated and real configured `ai` tests cover the deferred rendering behavior.

### NC-010: Use a distinct purple Task message background

**Status:** Completed

Replace the current Task participant background with a clearly purple treatment that remains
distinct from the user-message background while adapting to light and dark color schemes.

**Acceptance criteria**

- Task participant messages are visibly purple rather than resembling the user-message background.
- The Task header, status row, timestamp, and result text remain readable.
- The treatment remains distinct in both light and dark themes.
- User, Copilot, and Task message backgrounds cannot be confused at a glance.
- Automated and visible UI tests cover the resulting colors.

### NC-011: Evaluate emoji-only participant headers

**Status:** Completed

Consider removing the `You`, `Copilot`, and `Task` text labels from conversation headers because
the existing `👨`, `🤖`, and `📝` emojis may already identify each participant clearly.

The selected design uses emoji-only defaults for You, Copilot, and Task. Tool and Scheduler retain
text labels for operational clarity, and every participant heading remains configurable.

**Acceptance criteria**

- Compare emoji-only headers against the current emoji-plus-label format.
- Preserve timestamps, accessibility, scanability, and unambiguous actor identity.
- Ensure Scheduler and Tool participant headers remain coherent with the chosen format.
- Update all rendering and tests only after the preferred design is confirmed.

## Prompt submission

### NC-012: Submit prompts with `<C-s>` in insert mode

**Status:** Completed

Add an insert-mode `<C-s>` mapping to submit the current Native Copilot prompt without requiring
the user to leave insert mode.

**Acceptance criteria**

- `<C-s>` submits the active prompt while the cursor is in the prompt buffer's insert mode.
- Existing normal-mode submission behavior remains unchanged.
- The mapping is buffer-local and does not affect ordinary editing buffers.
- Visible E2E coverage submits at least one prompt through the insert-mode mapping.

### NC-013: Expose prompt submission for user-defined mappings

**Status:** Completed

Determine whether Native Copilot exposes a stable public function or `<Plug>` mapping that users
can call from their own normal- and insert-mode keybindings. If it does not, design and expose one
instead of requiring users to invoke internal callbacks.

**Acceptance criteria**

- Document whether a public prompt-submission API already exists.
- If missing, expose a supported Lua function or `<Plug>` mapping.
- User configuration can replace or supplement the default mappings without copying internal
  prompt logic.
- Invalid calls outside a Native Copilot prompt buffer fail safely and consistently.
