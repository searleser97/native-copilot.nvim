# native-copilot.nvim

A native Neovim interface for GitHub Copilot built around a persistent supervisor:

- **Standard Copilot**: one general-purpose Copilot session per Neovim instance that stays connected as the supervisor.
- **Fleets**: any number of independently configured Copilot session groups that run **concurrently alongside Standard**, each with durable, ACL-controlled agent-to-agent messaging.

The Neovim plugin owns a local Node.js host through versioned NDJSON over stdio. The host owns the official `@github/copilot-sdk`, Copilot sessions, configuration validation, and SQLite recovery state. It is not a daemon: exiting Neovim shuts down the host and all SDK-owned Copilot processes.

## Requirements

- Neovim 0.10 or newer
- Node.js `^20.19.0` or `>=22.12.0`
- GitHub Copilot access and a Copilot CLI login
- An authenticated [GitHub CLI](https://cli.github.com/) (`gh auth login`) for the built-in GitHub MCP server
- Optional picker UI through [Telescope](https://github.com/nvim-telescope/telescope.nvim)

The Copilot SDK is a local dependency of this repository. A global SDK installation is neither required nor used.

## Install

Build the host:

```powershell
Set-Location E:\native-copilot.nvim
npm install
npm run build
```

Load the local plugin with `lazy.nvim`:

```lua
{
  "searleser97/native-copilot.nvim",
  lazy = false,
  build = "npm install --no-audit --no-fund && npm run build",
  config = function()
    require("native_copilot").setup()
  end,
}
```

UI and rendering defaults can be adjusted in `setup`:

```lua
require("native_copilot").setup({
  -- Defaults to NVIM_COPILOT_CMD_RESOLVER.
  runtime_command_resolver = nil,
  stream_flush_ms = 80,
  follow_bottom = true,
  bottom_padding = 2,
  tool_summary_max_length = 120,
  timestamp_format = '%H:%M:%S',
  conversation = {
    user_label = '👨',
    copilot_label = '🤖',
    task_label = '📝',
    tool_label = '🛠️ Tool',
    scheduler_label = '⏰ Scheduler',
    day_header_format = '%A, %B %d',
  },
  prompt_queue_height = 5,
  task_detail_height = 12,
  frontend = {
    completion = "native", -- "blink" when the optional source is configured
    picker = "native", -- "telescope" only when explicitly selected
  },
})
```

`runtime_command_resolver` is a shell expression that prints the fully resolved Copilot command.
Set `NVIM_COPILOT_CMD_RESOLVER` globally so both ordinary `nvim` and specialized launchers use the
same configuration. The resolver runs once per host start with the Neovim workspace as its current
directory, allowing repository-sensitive MCP exclusions to be generated dynamically:

```powershell
$env:NVIM_COPILOT_CMD_RESOLVER = @"
& {
  . 'C:\private\Invoke-ConfiguredCopilot.ps1'
  Get-ConfiguredCopilotCommand
}
"@
```

The plugin invokes the resolver, requires a nonempty command, launches that command as the SDK
transport, and maps supported CLI session flags
(`--allow-all`, tool filters, disabled MCP servers, `--additional-mcp-config`, model, and reasoning
effort) onto SDK session configuration because SDK-created sessions do not reliably inherit those
policies from process arguments. Every session — Standard and Fleet members — is built from this one
parsed native policy, so children inherit it by default (see
[Inherited native configuration](#inherited-native-configuration)). The former
`vim.g.native_copilot_command`, `NVIM_COPILOT_CMD`, and `COPILOT_CLI_CMD` inputs are not read. If no
resolver is configured, the SDK's bundled Copilot runtime is used. No Fleet configuration file is required:
the `create_fleet` tool schema describes the complete runtime definition to Standard Copilot.
Store reusable Fleet requests as ordinary prompt snippets and submit them through the prompt buffer.

Runtime state is stored at:

```text
%LOCALAPPDATA%\nvim-data\native-copilot\state.sqlite
```

All newly created SDK sessions use the same opaque ID shape:
`native-copilot-<workspace-hash>-<session-instance-id>`. Fleet membership, member names, and roles
remain metadata rather than becoming part of session identity. Moves, reconnects, recovery, and
rollback reuse the stored ID. Older suffixed sessions remain available through `/resume`.

The built-in `github-mcp-server` authenticates through `gh auth token` at session startup. The
token is read directly from the GitHub CLI credential store, passed to the SDK in memory, and is
never written to plugin configuration, logs, SQLite, or conversation buffers.

## Key bindings

| Binding | Action |
|---|---|
| `<leader>ait` | Toggle the native Copilot tab; starts Standard Copilot when needed |
| `<leader>aif` | Stop an active Fleet or recover an inactive one |
| `<leader>ais` | Telescope picker for overview, status, member, and view |
| `[a` / `]a` | Previous/next member conversation or prompt recipient |
| `<Enter>` in `AI Prompt` | Submit to the selected recipient |
| `<C-s>` in `AI Prompt` | Submit from insert mode |
| `<C-p>` in `AI Prompt` | Open the existing prompt-snippet picker |
| `/` in an empty `AI Prompt` | Browse commands from the active Copilot session |
| `/fleet <objective>` | Ask Standard Copilot to design and start a task-specific Fleet |
| `/resume` | Resume a previous Copilot session from the current workspace |
| `<Tab>` in `AI Prompt` | Complete slash-command names, aliases, choices, or directories |
| `<Enter>` in an overview pane | Select that member as the prompt recipient |
| `<Enter>` on an inline `[task]`, `[tool]`, or `[schedule]` row | Open details in a floating pane |
| `<Enter>` in the prompt queue | Pause the queue and edit the selected prompt in `AI Prompt` |
| `dd` in the prompt queue | Cancel the selected queued prompt |
| `p` in the prompt queue | Pause or resume FIFO dispatch |
| `q` / `<BS>` in activity details | Close the floating detail pane |
| `dd` in task details | Cancel the running or waiting task |

Custom mappings can call the public member-cycling function. When invoked from `AI Prompt`, it
preserves the draft and returns focus to the prompt:

```lua
vim.keymap.set("i", "<M-l>", function()
  require("native_copilot").cycle_member(1)
end)
vim.keymap.set("i", "<M-h>", function()
  require("native_copilot").cycle_member(-1)
end)
```

Prompt submission is also exposed as a public function for user-defined buffer-local mappings:

```lua
vim.keymap.set({ "n", "i" }, "<M-CR>", function()
  require("native_copilot").submit_prompt()
end, { buffer = true })
```

`submit_prompt()` returns `false` and displays a warning when called outside the Native Copilot
prompt buffer or when the prompt cannot be submitted.

The conversation is also the chronological activity timeline. Background tasks, environment
initialization, foreground tools, schedules, and permission decisions appear as compact timeline
rows. Environment rows are unquoted. `🟡` is processing or waiting, `🟢` completed or approved,
`🔴` failed, `⚪` cancelled,
`🚫` denied, and `❓` unknown. Each row keeps a stable position and updates in place as its state
changes, so completion does not reorder earlier work.

Tools, Instructions, Skills, MCP servers, Plugins, Agents, and other environment initialization use
non-actionable `[environment]` rows. The initial `Copilot environment` row remains visible and
transitions from startup to `ready`. Foreground tools use `[tool]` rows. File reads and code searches
also show their target path or query directly in the compact row, making on-demand reads of nested
instruction files such as `CLAUDE.md` visible without opening details. Other arguments remain in the
`<Enter>` floating detail pane together with complete results and errors, including failure details
for failed tools and tasks. The active Copilot
heading cycles through `writing.`, `writing..`, and
`writing...`; when the response completes, that text is replaced by its completion time. Failed
responses retain a leading `🔴`. Permission requests use a leading `🟡` row that updates to
`🟢` when approved or `🚫` when denied, without a separate Permission section. Prompts submitted
while Copilot is busy stay in a FIFO pane between
the conversation and input. That pane supports pausing, editing, and cancelling before dispatch.
Slash commands are rendered as normal `👨` turns rather than duplicated `[command]` rows; their
text output remains under `🤖`, and any work they start is represented by the resulting
task, tool, environment, or schedule rows. Use `/tasks` or
`:NativeCopilotTasks` to browse all tracked tasks and open one in the same floating detail pane.

The resolved main Copilot command defines the Standard session's initial permission policy.
`--allow-all` installs the SDK's `approveAll` handler; otherwise permission requests are shown in
Neovim. Dynamically generated agents may inherit that behavior, request interactive approval, or
define a stricter path/tool/action ceiling. A child may request `approveAll` only when the main
command grants it, preventing privilege escalation.

Commands mirror the primary mappings:

```vim
:NativeCopilotToggle
:NativeCopilotSelect
:NativeCopilotAgents
:NativeCopilotStatus
:NativeCopilotTasks
:NativeCopilotAbort
:NativeCopilotCancelBackground
:NativeCopilotReloadMcp
```

Selection uses `vim.ui.select` by default. To use Telescope for Copilot command, session, task,
model, MCP, and Fleet pickers, install it separately and opt in explicitly:

```lua
require("native_copilot").setup({
  frontend = {
    picker = "telescope",
  },
})
```

The plugin does not select Telescope merely because it is installed, and it preserves Telescope's
configured layout. `/resume` displays sessions oldest-to-newest, initially selects the newest
session at the bottom, and keeps that entry visible.

## Configuration

Fleets are not predefined and require no external configuration file. The guarded `create_fleet`
tool describes the complete runtime schema to Standard Copilot. Each generated definition can
select a model, reasoning effort, prompt, permissions, MCP server subset, UI metadata, startup
behavior, and directional `canTalkTo` peers. Personal Fleet recipes can be stored as ordinary
prompt snippets outside the plugin and submitted like any other prompt.

Each Fleet/member pair receives a different Copilot session scoped to the current Neovim instance:

```text
fleet-<workspace-hash>-<instance-id>-<fleet-id>-<member-id>
```

Raw member IDs (`planner`, `reviewer`, …) only need to be unique **within** a Fleet. The UI and
runtime address every member through a Fleet-qualified target of the form `<fleet-id>/<member-id>`,
so two different Fleets can each contain a `planner` without colliding. Raw member IDs remain the
identity used inside the Fleet definition, the run-scoped SQLite session/message records, and the
dedicated `send_to_<agent>` peer tools.

Every generated agent receives its own top-level SDK session and conversation context.
Closing and reopening the Copilot tab in the same Neovim process keeps those sessions. Starting a new Neovim process creates fresh Standard and Fleet-member sessions instead of automatically resuming the previous process's transcript.

Each Neovim process owns an independent host, runtime, and set of top-level SDK sessions. Active
runs record their owning host process, so opening another Neovim instance does not mark or recover
the first instance's work. Runs whose owning host has exited become recoverable.

### Inherited native configuration

The host parses the resolved main Copilot command **once** into a single, typed native policy
object (`NativePolicy`) and builds every session — the Standard supervisor and each Fleet member —
from one shared scaffold (`nativeSessionScaffold`). This is code-level reuse, not merely equivalent
behavior: there is exactly one parsed policy and one base builder, and agent-specific settings are
applied as overlays on that shared object. By default a child agent therefore receives exactly the
same native configuration as the main agent:

- **Working directory / config discovery / instruction files** — every session uses the same
  workspace `workingDirectory` with `enableConfigDiscovery`, so workspace `.mcp.json`, discovered
  instruction files, and skills resolve identically for children and the main agent.
- **MCP configuration** — servers discovered from the workspace plus every `--additional-mcp-config`
  source (parsed once into a single native MCP-server record) are inherited by all sessions. A
  user-provided `--additional-mcp-config` that is missing, unreadable, invalid JSON, or the wrong
  shape surfaces a clear error rather than being silently dropped.
- **Native tool / MCP policy** — `--available-tools`, `--excluded-tools`, and `--disable-mcp-server`
  from the main command apply to every session as a shared ceiling. A bare `*` pattern is normalized
  into SDK-valid source-qualified patterns (`builtin:*`, `custom:*`, `mcp:*`) before any session
  config is derived.
- **Model / reasoning effort** — `--model` and `--reasoning-effort` from the main command become the
  default for every session, including Fleet members.
- **Permission policy** — `--allow-all` installs the SDK `approveAll` handler for the main session;
  children inherit that behavior unless they narrow it.

Agent settings only **narrow or deliberately override** this single source of truth; they never
recreate a parallel definition:

- A member's `permissions.tools.allow` becomes its `availableTools` allowlist and is **not** widened
  back by the native list. It must be a semantic **subset** of the native tool ceiling (an empty
  native allowlist means unrestricted; bare `*` and source wildcards such as `builtin:*` are
  expanded and matched). A member allowlist that requests tools outside the native ceiling is
  **rejected** at Fleet creation, mutation, or move rather than silently intersected. Native
  `excludedTools`/`disabledMcpServers` still merge as a ceiling.
- A member's `mcpServers` subset disables the other Fleet MCP servers for that member.
- A member's `model` / `reasoningEffort` / `reasoningSummary` override the inherited defaults.
- An MCP server a member defines itself takes precedence over an inherited native server of the same
  name.

Omitting any of these fields inherits the main session's value.

Neovim always starts Standard Copilot with one supervisor session that **stays connected** for the
life of the host. A Fleet is created when Standard Copilot invokes the guarded `create_fleet` tool,
either from an ordinary prompt or `/fleet <objective>`. Creating a Fleet never stops Standard or any
other running Fleet; multiple Fleets run concurrently on separate objectives. Creation waits for the
current Standard turn to become idle, and multiple `create_fleet` calls may queue while Standard is
busy. Duplicate active or pending Fleet IDs are rejected. Only agents with
`autoStart` are connected initially; other top-level member
sessions remain visibly in `standby` until first prompted, queried for session commands, or sent a
mailbox message.

### Mutating an active Fleet

Standard Copilot has four additional guarded tools for adjusting a Fleet that is already running,
each identified by `fleetId` (the `move` tool identifies both a source and destination Fleet):

- `add_agent_to_fleet` — an explicit **upsert** keyed by agent ID: if no agent with the given ID
  exists it is added, and if one already exists its complete definition is replaced (updated) in
  place. The resulting Fleet is re-validated against the same permission and MCP ceilings as creation
  before it is applied.
- `remove_agent_from_fleet` — removes a member, prunes it from every peer's `canTalkTo`, disconnects
  that session, and reconnects affected peers with their updated `send_to_<agent>` tool set. Removing
  the entry agent is rejected unless a replacement entry agent is supplied atomically, and the final
  remaining member cannot be removed.
- `move_agent_to_fleet` — atomically moves one active agent from `sourceFleetId` to
  `destinationFleetId`. The move is rejected unless both Fleets are active, the agent's ID is unused
  in the destination (IDs must stay unique within one Fleet), and the source keeps at least one
  member. Moving the source's entry agent requires a valid `replacementEntryAgentId` that is applied
  to the source atomically. By default the moved agent's `canTalkTo` is filtered down to peers that
  exist in the destination; supply an optional complete `destinationAgent` definition (its `id` must
  equal the moved agent's ID) to override its prompt, tools, permissions, or peers, still validated
  against the destination's permission and MCP ceilings. The moved agent is rebuilt under the
  destination-qualified target with the destination Fleet's native-config overlay and peer tools,
  resuming the **same** Copilot session so its conversation history follows it; the persisted session
  record is reassociated to the destination run. Source peers that referenced the agent and both
  Fleets' definitions are updated and persisted atomically, and affected peers in both Fleets are
  reconnected. The source mailbox is **not** migrated: any of the moved agent's still-in-flight
  (pending or delivering) source messages are atomically **settled** in the source run with an
  explicit reason when the move commits, while already-delivered history is preserved. If validation,
  persistence, or reconnection fails, the move rolls back — restoring the settled mailbox, removing
  any destination session, and returning the agent to its source — so no partial in-memory or
  on-disk state remains.

Because a member's dedicated peer tools are fixed at session creation, changing a peer set
reconnects and resumes the affected member sessions under the same session IDs; Copilot's session
store preserves their conversation history across the reconnect. Every mutation is persisted to the
run's stored Fleet definition so it survives recovery.

`/fleet` intentionally replaces the runtime's built-in command in this UI. With an objective it
asks Standard Copilot to generate a Fleet; without one it opens per-Fleet stop and recovery actions.
Recovery reconnects every member
session previously created for that run, preserves its mailbox association, and starts any missing
`autoStart` members. An inactive Fleet can be recovered alongside Standard and other already-active
Fleets, and recovery rejects a Fleet ID that is already active. Active runs owned by another Neovim
instance are never offered.

If the runtime did not persist a member because it never had conversation activity, recovery
recreates that empty member session under the same ID. A missing session with recorded conversation
activity is treated as an error rather than silently presenting an empty replacement.

### Validation

A generated Fleet is rejected before startup when it contains duplicate or unsafe agent IDs,
an invalid entry agent, unknown/self communication peers, unavailable MCP servers, malformed
permission policies, or an `approveAll` request that exceeds the main session authority.

Agent **IDs** are the only values that must be unique within a Fleet, because they drive unambiguous
routing and the generated `send_to_<agent>` tool names. Roles and display names are **not** required
to be unique: a single Fleet may intentionally contain multiple agents with the same conceptual role
(for example two planners or two developers) as long as each has a distinct ID.

Fleet startup is all-or-nothing. Telescope marks invalid profiles and displays their exact diagnostics.

### Models

`model`, `reasoningEffort`, and `reasoningSummary` are optional per generated agent.
`reasoningSummary` accepts `none`, `concise`, or `detailed` and defaults to `detailed`. When omitted,
the Copilot runtime chooses its default model.

## Messaging and recovery

Every Fleet agent receives one tool per declared peer: `send_to_planner`, `send_to_tester`, and so
on. Agents have no tool for undeclared peers, so `canTalkTo` is enforced structurally rather than
through a free-form recipient argument. Peer messaging is scoped to a single Fleet: a `send_to_<agent>`
tool only reaches the same-Fleet member, so identical raw member IDs in different Fleets never cross.

Messages are written transactionally to SQLite before delivery. Busy recipients are not interrupted; their mailbox is drained after the session becomes idle. Delivery uses leases and idempotent message IDs, so interrupted delivery returns to `pending` after restart.

Copilot’s own session store remains authoritative for full conversation history. SQLite stores run/member mappings, durable mail, selected lifecycle events, leases, and recovery checkpoints.

Restarting Neovim surfaces persisted state but does not automatically restart a Fleet or spend additional credits.

## Rendering and observability

Conversation, mailbox, and status views are native plain-text `nofile` buffers with no Markdown
renderer dependency. User, Copilot, and Task turns default to emoji-only `👨`, `🤖`, and `📝`
headers, without a redundant document title. Their labels, along with Tool and Scheduler headings,
are configurable through `conversation` setup options. Inline
reasoning remains part of each conversation buffer as unlabeled text using Neovim's `Comment`
highlight group. Each reasoning section is a native fold that starts open and supports normal
fold commands such as `zc`, `zo`, and `za`. Errors remain visible in their related activity rows
and detail panes.
The buffers retain normal Neovim navigation, search, yank, folds, marks, and window mappings.

Participant headers use colorscheme-aware highlight groups: `NativeCopilotUserHeader` links to
`DiagnosticInfo`, `NativeCopilotAssistantHeader` links to `Special`, and timestamps or writing
state use `NativeCopilotHeaderMeta`, linked to `Comment`. Override any group after setup with
`vim.api.nvim_set_hl()` to choose explicit colors.

Streaming deltas are batched and appended only to the changed buffer tail. Configure the batching
interval with `stream_flush_ms`. Conversation content uses a three-space margin, including user and
Copilot text, fenced code blocks, reasoning, tools, tasks, schedules, and permissions. Participant
headers, day dividers, and environment loading/status rows remain unindented.

Conversation windows follow the final line when opened, switched, reopened, or updated by streaming
output, keeping `bottom_padding` display rows below it. Set `bottom_padding = 0` for a flush bottom
edge, or `follow_bottom = false` to preserve the current viewport instead. Following pauses when
you scroll far enough upward that the transcript end leaves the window and resumes when you return
to the bottom.

Conversation turns and timeline rows show local timestamps. A timeline row receives a new timestamp
only when its visible state changes, and a streamed Copilot response receives its final timestamp
when the response completes. Reasoning summaries omit timestamps. Customize the remaining display
with `timestamp_format`, using an `os.date` format string. The conversation starts with a local-date
divider and adds another before the first newly rendered item after midnight.
`conversation.day_header_format` controls that divider without repeating the date on every row.
Tool rows expose their native call ID only when the call creates or represents longer-lived
asynchronous work; ordinary synchronous calls omit it because their lifecycle is updated in place.
Related Task rows use `task_<tool-call-id>` so one search finds both sides of the lifecycle.
Tasks without an originating Tool use a deterministic `task_<hash>` display ID instead of a short
session-local handle. Canonical Task IDs remain available in activity details and are still used
for progress and cancellation operations.
When an invocation provides `description` or `summary`, that human-readable text appears beside the
Tool name. Inline summaries collapse whitespace and truncate to `tool_summary_max_length`
characters; complete arguments remain available by pressing Enter on the row. Tool-specific
fallbacks continue to show paths, patterns, queries, and shortened agent prompts/messages.
The conversation winbar shows the effective model and cumulative AI credits (AIC) used by the
session. Both values refresh from SDK usage events after every model call.

SDK-provided reasoning summaries, intent, errors, tools, prompts, schedules, tasks, and environment status
appear inline in the conversation, similar to Copilot CLI's timeline. Whether reasoning content is
emitted depends on the selected model and GitHub
Copilot runtime. The plugin does not manufacture or expose private hidden chain-of-thought.

Each session reports runtime/configuration discovery and loaded counts for tools, instructions,
skills, MCP servers, plugins, and agents through conversation rows that update in place. MCP
connection-state changes update the original server row without disturbing chronology. Discovered
instruction sources are additionally listed as one compact `[environment] Instruction <label>` row
per source, showing the source label and its file path (like Copilot CLI) rather than only a count.
Instruction file **contents** are never rendered; sources flagged as disabled by default are marked
accordingly. When Copilot discovers a nested instruction file on demand while traversing the
codebase, the ordinary `view`/read tool row shows that path as well.

Slash commands are listed and invoked through the active Copilot SDK session. Nothing is hardcoded for `/autopilot`: built-ins, aliases, skills, plugins, and future runtime commands are discovered dynamically. Enter a slash command directly or press `/` in an empty prompt to browse the commands available to the selected agent. `<Tab>` completes command names and aliases, SDK-provided argument choices, and directory arguments declared by the command metadata. `/tasks` is added as a client-native command because the SDK exposes typed task APIs but omits the CLI-owned slash command; it opens a task picker. `/fleet` is deliberately overridden by the client-native dynamic-Fleet command described above. `/resume` is also client-native because session listing and recovery are typed SDK client APIs rather than session slash commands; it opens a workspace-scoped picker, while `/resume <session-id>` resumes directly. The picker marks sessions locked by another live process as `[active elsewhere]`, prevents unsafe recovery of those sessions, and shows relative time based only on the session's last-modified timestamp.

The client-native command set is intentionally small:

- `/fleet <objective>` requests a generated Fleet; `/fleet` stops an active Fleet or recovers one.
- `/tasks` browses typed SDK background tasks and opens their floating details.
- `/resume` lists and safely resumes workspace sessions.
- `/model` opens the selected session's model picker; `/model <id>` switches directly.
- `/mcp` opens a server/action picker. `/mcp list`, `show`, `tools`, `enable`, `disable`, and
  `reload` are also available directly.
- `/mcp-reload` reloads MCP connections without replacing the current session.

All other commands use the active runtime's dynamic command catalog and invocation result.

`/mcp-reload` and `:NativeCopilotReloadMcp` call the SDK's session-scoped
`session.rpc.mcp.reload()` API. They stop and reconnect the selected session's MCP servers,
refresh the inline environment rows, and do not restart or replace the Copilot session.

Native scheduled prompts and session-store support are enabled for every SDK session. The model can
therefore use `manage_schedule` and `sql` when the connected Copilot runtime exposes them. `todos`
and `todo_deps` are tables in the per-session SQLite database used through `sql`; they are not
separate tools. Availability is still subject to the installed Copilot CLI/runtime version and its
feature policy.

`/every`, `/after`, and model-created `manage_schedule` entries appear as stable `[schedule]` rows.
Creation, re-arming, and cancellation update the original row. When a schedule fires, its message
appears as a `👨` turn and its active response state appears beside `🤖`. Press `<Enter>`
on a schedule row to inspect its prompt and cadence without expanding that content in the main
timeline.

Command behavior follows the result returned by the SDK:

- Text and completion results are appended to the conversation.
- Agent-prompt results are submitted to the selected agent as a normal turn.
- Commands requiring a subcommand open a picker; repeated `select-subcommand` results support nested
  command selection, while SDK-provided argument choices remain available through completion.

Other than the explicit client-native `/fleet`, `/tasks`, `/resume`, `/model`, and `/mcp`
integrations, commands come from `session.rpc.commands.list()`. The model and MCP overrides use
typed session RPCs so commands that are interactive in Copilot CLI remain actionable rather than
returning an inert completion. CLI-owned general session navigation such as `/new` and `/clear` is
not currently exposed by the SDK session command registry. Fleet recovery remains handled by the
dynamic-Fleet `/fleet` picker because it must restore multiple session IDs and mailbox state as
one run.

The embedded SDK registry's built-in `/fleet` would start a native subagent workflow inside one
session. `native-copilot.nvim` replaces it so `/fleet` consistently controls generated independent
top-level sessions and mailbox routing instead.

The SDK does expose typed task-management RPCs, which the plugin uses directly:

- `:NativeCopilotTasks` opens a picker for the selected session's tracked tasks.
- `:NativeCopilotCancelBackground` cancels every background subagent in the selected session.
- `:NativeCopilotAbort` aborts the selected session's foreground turn while keeping the session usable.

Cancelling all background agents does not terminate promoted attached shell processes. A running
shell tracked by the task registry can instead be selected through `:NativeCopilotTasks` and
cancelled from its floating detail pane.

### Optional blink.cmp source

`blink.cmp` is not a plugin dependency. To use it as the completion frontend, set `frontend.completion = "blink"` above and register the source in your own blink configuration:

```lua
sources = {
  default = function()
    if vim.b.native_copilot_prompt then return { "native_copilot", "path" } end
    return { "lsp", "buffer", "snippets", "path" }
  end,
  providers = {
    native_copilot = {
      name = "Copilot",
      module = "native_copilot.blink",
      enabled = function() return vim.b.native_copilot_prompt == true end,
      async = true,
      score_offset = 100,
    },
    path = {
      opts = {
        get_cwd = function(context)
          if vim.b[context.bufnr].native_copilot_prompt then return vim.uv.cwd() end
          return vim.fn.expand(("#%d:p:h"):format(context.bufnr))
        end,
      },
    },
  },
}
```

The native source remains the default and does not load blink. With the blink frontend selected, the plugin leaves `/` and `<Tab>` unmapped so the user's blink keymap remains authoritative.

## Lifecycle

`VimLeavePre` sends a graceful shutdown request and waits for the host. The host:

1. Marks active runs interrupted.
2. Preserves pending mailbox messages.
3. Disconnects SDK sessions without deleting session history.
4. Stops the SDK-owned Copilot runtime.
5. Closes SQLite.

stdin closure, parent-process loss, `SIGINT`, and `SIGTERM` trigger the same bounded cleanup. If graceful SDK shutdown exceeds four seconds, the host calls `forceStop()`.

## Testing

The supported test workflow is visible UI E2E. It launches a maximized WezTerm window with a real
Neovim instance, plugin Lua, Node host, NDJSON protocol, SQLite database, prompt buffer, and
conversation rendering. Copilot replies, MCP initialization, permissions, Tasks, and Tool events
are scripted at the runtime boundary so scenarios remain fast and deterministic.

Prerequisites:

- Node.js matching `package.json`
- PowerShell 7 (`pwsh`)
- WezTerm
- Neovim available as `nvim`
- Telescope and Plenary installed under Neovim's `stdpath("data")\lazy` for the real picker profile

Run the complete visible matrix:

```powershell
npm test
```

Run one launch profile while developing:

```powershell
npm run test:e2e:allow-all
npm run test:e2e:allow-all-mcp
npm run test:e2e:manual-permissions
npm run test:e2e:telescope
npm run test:e2e:telescope-no-smear
```

Use observation mode to slow the scripted events and leave the completed maximized window open:

```powershell
npm run test:e2e:observe
```

Each profile opens an independent visible window, drives prompts through the real prompt mapping,
writes assertions and conversation snapshots under `.e2e-artifacts\`, and closes immediately when
the scenario finishes. `allow-all` omits MCP servers, `allow-all-mcp` renders connected and failed
mock servers, and `manual-permissions` exercises the interactive approval picker. `telescope`
loads the real installed Telescope, Plenary, Blink, and smear-cursor plugins and covers command
pickers, direct command forms, newest-session selection, locked sessions, session restoration, and
constrained UI layouts. Resume coverage also verifies that sub-agent prompts retain Task ownership
without duplicating the initial `task` or later `write_agent` tool arguments, and that internal
sub-agent responses do not appear as Standard Copilot output. Tool-only historical responses also
retain their original timestamp instead of using the time at which `/resume` was invoked.
Instruction-discovery events share one unquoted timeline representation in live and resumed flows.
`telescope-no-smear` repeats that complete picker scenario without adding smear-cursor to Neovim's
runtime path, proving the optional integration is not required.
Shared scenarios cover streamed reasoning folds, fold open/close behavior, Tool ownership, and
Task deferral.
Observation mode runs the `allow-all` profile, writes timestamped artifacts, and leaves Neovim open
until the user closes it.

`npm run check` remains available for a TypeScript-only compile check, and `npm run build` emits the
Node host required by the visible suite. Neither command replaces the visible E2E matrix.

The host’s stdout is protocol-only NDJSON. Diagnostics are written to stderr; Neovim appends them to:

```text
stdpath("state")\native-copilot.log
```
