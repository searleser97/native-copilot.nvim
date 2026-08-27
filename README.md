# native-copilot.nvim

A native Neovim interface for GitHub Copilot with two explicit operating modes:

- **Standard Copilot**: one general-purpose Copilot session per Neovim instance.
- **Fleet mode**: any number of independently configured Copilot sessions with durable, ACL-controlled agent-to-agent messaging.

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
  -- Defaults to vim.g.native_copilot_command, then the legacy environment variables.
  runtime_command = nil,
  stream_flush_ms = 80,
  follow_bottom = true,
  timestamp_format = '%H:%M:%S',
  conversation = {
    user_label = '👨 You',
    copilot_label = '🤖 Copilot',
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

`runtime_command` lets the SDK use the same resolved command as an existing Copilot CLI setup.
Launchers that build workspace-sensitive commands can resolve them before starting Neovim:

```powershell
$command = & C:\private\Invoke-ConfiguredCopilot.ps1 --print-command
$json = $command | ConvertTo-Json -Compress
nvim --cmd "lua vim.g.native_copilot_command = $json"
```

The plugin launches that command as the SDK transport and maps supported CLI session flags
(`--allow-all`, tool filters, disabled MCP servers, model, and reasoning effort) onto SDK session
configuration because SDK-created sessions do not reliably inherit those policies from process
arguments. `NVIM_COPILOT_CMD` and `COPILOT_CLI_CMD` remain compatibility fallbacks. If no command
is configured, the SDK's bundled Copilot runtime is used.

On first use, the plugin copies `examples\fleets.json` to the editable user configuration:

```text
%LOCALAPPDATA%\nvim\copilot\fleets.json
```

Runtime state is stored at:

```text
%LOCALAPPDATA%\nvim-data\native-copilot\state.sqlite
```

No credentials or tokens belong in `fleets.json`.

The built-in `github-mcp-server` authenticates through `gh auth token` at session startup. The
token is read directly from the GitHub CLI credential store, passed to the SDK in memory, and is
never written to plugin configuration, logs, SQLite, or conversation buffers.

## Key bindings

| Binding | Action |
|---|---|
| `<leader>ait` | Toggle the native Copilot tab; starts Standard Copilot when needed |
| `<leader>aif` | Recover or stop a dynamic Fleet |
| `<leader>ais` | Telescope picker for overview, status, member, and view |
| `[a` / `]a` | Previous/next member conversation |
| `<Enter>` in `AI Prompt` | Submit to the selected recipient |
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

The conversation is also the chronological activity timeline. Background tasks, environment
initialization, foreground tools, schedules, and permission decisions appear as compact quoted
rows. `🟡` is processing or waiting, `🟢` completed or approved, `🔴` failed, `⚪` cancelled,
`🚫` denied, and `❓` unknown. Each row keeps a stable position and updates in place as its state
changes, so completion does not reorder earlier work.

Tools, Instructions, Skills, MCP servers, Plugins, Agents, and other environment initialization use
non-actionable `[environment]` rows. The initial `Copilot environment` row remains visible and
transitions from startup to `ready`. Foreground tools use `[tool]` rows and expose only the tool
name and status in the timeline. `<Enter>` reveals complete arguments, results, and errors in the
floating detail pane, including failure details for failed tools and tasks. The active Copilot
heading cycles through `writing.`, `writing..`, and
`writing...`; when the response completes, that text is replaced by its completion time. Failed
responses retain a leading `🔴`. Permission requests use a leading `🟡` row that updates to
`🟢` when approved or `🚫` when denied, without a separate Permission section. Prompts submitted
while Copilot is busy stay in a FIFO pane between
the conversation and input. That pane supports pausing, editing, and cancelling before dispatch.
Slash commands are rendered as normal `👨 You` turns rather than duplicated `[command]` rows; their
text output remains under `🤖 Copilot`, and any work they start is represented by the resulting
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

Selection uses `vim.ui.select` by default. To use Telescope for Copilot Fleet pickers, install it separately and opt in explicitly:

```lua
require("native_copilot").setup({
  frontend = {
    picker = "telescope",
  },
})
```

The plugin does not select Telescope merely because it is installed.

## Configuration

The JSON file configures Standard Copilot and provides `fleetExamples` used only as prompt guidance.
Fleets are not predefined. Standard Copilot calls `create_fleet` with complete runtime agent
definitions for the current task. Each definition can select a model, reasoning effort, prompt,
permissions, MCP server subset, UI metadata, startup behavior, and `canTalkTo` peers.

Each Fleet/member pair receives a different Copilot session scoped to the current Neovim instance:

```text
fleet-<workspace-hash>-<instance-id>-<fleet-id>-<member-id>
```

Every generated agent receives its own top-level SDK session and conversation context.
Closing and reopening the Copilot tab in the same Neovim process keeps those sessions. Starting a new Neovim process creates fresh Standard and Fleet-member sessions instead of automatically resuming the previous process's transcript.

Each Neovim process owns an independent host, runtime, and set of top-level SDK sessions. Active
runs record their owning host process, so opening another Neovim instance does not mark or recover
the first instance's work. Runs whose owning host has exited become recoverable.

Neovim always starts in Standard mode with one Copilot session. A multi-session Fleet is created
when Standard Copilot invokes the guarded `create_fleet` tool, either from an ordinary prompt or
`/fleet <objective>`. Creation waits for the current Standard turn to become idle. Only agents with
`autoStart` are connected initially; other top-level member
sessions remain visibly in `standby` until first prompted, queried for session commands, or sent a
mailbox message.

`/fleet` intentionally replaces the runtime's built-in command in this UI. With an objective it
asks Standard Copilot to generate a Fleet; without one it opens recovery/stop actions. Recovery reconnects every member
session previously created for that run, preserves its mailbox association, and starts any missing
`autoStart` members. Active runs owned by another Neovim instance are never offered.

If the runtime did not persist a member because it never had conversation activity, recovery
recreates that empty member session under the same ID. A missing session with recorded conversation
activity is treated as an error rather than silently presenting an empty replacement.

### Validation

A generated Fleet is rejected before startup when it contains duplicate or unsafe agent IDs,
an invalid entry agent, unknown/self communication peers, unavailable MCP servers, malformed
permission policies, or an `approveAll` request that exceeds the main session authority.

Fleet startup is all-or-nothing. Telescope marks invalid profiles and displays their exact diagnostics.

### Models

`model`, `reasoningEffort`, and `reasoningSummary` are optional per generated agent.
`reasoningSummary` accepts `none`, `concise`, or `detailed` and defaults to `detailed`. When omitted,
the Copilot runtime chooses its default model.

## Messaging and recovery

Every Fleet agent receives one tool per declared peer: `send_to_planner`, `send_to_tester`, and so
on. Agents have no tool for undeclared peers, so `canTalkTo` is enforced structurally rather than
through a free-form recipient argument.

Messages are written transactionally to SQLite before delivery. Busy recipients are not interrupted; their mailbox is drained after the session becomes idle. Delivery uses leases and idempotent message IDs, so interrupted delivery returns to `pending` after restart.

Copilot’s own session store remains authoritative for full conversation history. SQLite stores run/member mappings, durable mail, selected lifecycle events, leases, and recovery checkpoints.

Restarting Neovim surfaces persisted state but does not automatically restart a Fleet or spend additional credits.

## Rendering and observability

Conversation, mailbox, and status views are native plain-text `nofile` buffers with no Markdown
renderer dependency. Conversation turns default to `👨 You` and `🤖 Copilot`, without a redundant
document title. Both labels are configurable through `conversation` setup options. Inline
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
output. Set `follow_bottom = false` to preserve the current viewport instead.

Conversation turns and timeline rows show local timestamps. A timeline row receives a new timestamp
only when its visible state changes, and a streamed Copilot response receives its final timestamp
when the response completes. Reasoning summaries omit timestamps. Customize the remaining display
with `timestamp_format`, using an `os.date` format string. The conversation starts with a local-date
divider and adds another before the first newly rendered item after midnight.
`conversation.day_header_format` controls that divider without repeating the date on every row.
The conversation winbar shows the effective model and cumulative AI credits (AIC) used by the
session. Both values refresh from SDK usage events after every model call.

SDK-provided reasoning summaries, intent, errors, tools, prompts, schedules, tasks, and environment status
appear inline in the conversation, similar to Copilot CLI's timeline. Whether reasoning content is
emitted depends on the selected model and GitHub
Copilot runtime. The plugin does not manufacture or expose private hidden chain-of-thought.

Each session reports runtime/configuration discovery and loaded counts for tools, instructions,
skills, MCP servers, plugins, and agents through conversation rows that update in place. MCP
connection-state changes update the original server row without disturbing chronology.

Slash commands are listed and invoked through the active Copilot SDK session. Nothing is hardcoded for `/autopilot`: built-ins, aliases, skills, plugins, and future runtime commands are discovered dynamically. Enter a slash command directly or press `/` in an empty prompt to browse the commands available to the selected agent. `<Tab>` completes command names and aliases, SDK-provided argument choices, and directory arguments declared by the command metadata. `/tasks` is added as a client-native command because the SDK exposes typed task APIs but omits the CLI-owned slash command; it opens a task picker. `/fleet` is deliberately overridden by the client-native dynamic-Fleet command described above. `/resume` is also client-native because session listing and recovery are typed SDK client APIs rather than session slash commands; it opens a workspace-scoped picker, while `/resume <session-id>` resumes directly. The picker marks sessions locked by another live process as `[active elsewhere]`, prevents unsafe recovery of those sessions, and shows relative time based only on the session's last-modified timestamp.

The client-native command set is intentionally small:

- `/fleet <objective>` requests a generated Fleet; `/fleet` recovers or stops one.
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
appears as a `👨 You` turn and its active response state appears beside `🤖 Copilot`. Press `<Enter>`
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
    if vim.b.native_copilot_prompt then return { "native_copilot" } end
    return { "lsp", "buffer", "snippets", "path" }
  end,
  providers = {
    native_copilot = {
      name = "Copilot",
      module = "native_copilot.blink",
      enabled = function() return vim.b.native_copilot_prompt == true end,
      score_offset = 100,
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

## Development

```powershell
npm run check
npm test
npm run build
```

The host’s stdout is protocol-only NDJSON. Diagnostics are written to stderr; Neovim appends them to:

```text
stdpath("state")\native-copilot.log
```
