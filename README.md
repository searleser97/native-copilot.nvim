# copilot-fleet.nvim

A native Neovim interface for GitHub Copilot with two explicit operating modes:

- **Standard Copilot**: one persistent, general-purpose Copilot session.
- **Fleet mode**: any number of independently configured Copilot sessions with durable, ACL-controlled agent-to-agent messaging.

The Neovim plugin owns a local Node.js host through versioned NDJSON over stdio. The host owns the official `@github/copilot-sdk`, Copilot sessions, configuration validation, and SQLite recovery state. It is not a daemon: exiting Neovim shuts down the host and all SDK-owned Copilot processes.

## Requirements

- Neovim 0.10 or newer
- Node.js `^20.19.0` or `>=22.12.0`
- GitHub Copilot access and a Copilot CLI login
- [Telescope](https://github.com/nvim-telescope/telescope.nvim)
- Optional rich rendering through [render-markdown.nvim](https://github.com/MeanderingProgrammer/render-markdown.nvim)

The Copilot SDK is a local dependency of this repository. A global SDK installation is neither required nor used.

## Install

Build the host:

```powershell
Set-Location E:\copilot-fleet.nvim
npm install
npm run build
```

Load the local plugin with `lazy.nvim`:

```lua
{
  "searleser97/copilot-fleet.nvim",
  lazy = false,
  build = "npm install --no-audit --no-fund && npm run build",
  dependencies = {
    "nvim-telescope/telescope.nvim",
    "MeanderingProgrammer/render-markdown.nvim",
  },
  config = function()
    require("copilot_fleet").setup()
  end,
}
```

UI and rendering defaults can be adjusted in `setup`:

```lua
require("copilot_fleet").setup({
  stream_flush_ms = 80,
  render_debounce_ms = 200,
})
```

On first use, the plugin copies `examples\fleets.json` to the editable user configuration:

```text
%LOCALAPPDATA%\nvim\copilot\fleets.json
```

Runtime state is stored at:

```text
%LOCALAPPDATA%\nvim-data\copilot-fleet\state.sqlite
```

No credentials or tokens belong in `fleets.json`.

## Key bindings

| Binding | Action |
|---|---|
| `<leader>ait` | Toggle the native Copilot tab; starts Standard Copilot when needed |
| `<leader>aif` | Select/start a valid Fleet, or stop Fleet mode |
| `<leader>ais` | Telescope picker for overview, status, member, and view |
| `[a` / `]a` | Previous/next member conversation |
| `<Enter>` in `AI Prompt` | Submit to the selected recipient |
| `<C-p>` in `AI Prompt` | Open the existing prompt-snippet picker |
| `/` in an empty `AI Prompt` | Browse commands from the active Copilot session |
| `<Enter>` in an overview pane | Select that member as the prompt recipient |

Commands mirror the primary mappings:

```vim
:CopilotFleetToggle
:CopilotFleetSelect
:CopilotFleetAgents
:CopilotFleetStatus
```

## Configuration

The JSON file separates reusable agents from Fleet-local members:

- `permissionProfiles` define user-approved ceilings.
- `agents` define reusable prompts, models, reasoning effort, and UI metadata.
- `fleets` compose those agents into distinct members.
- Fleet members define direct recipients, recipient groups, broadcast access, permission narrowing, and lazy/automatic startup.
- `entryMember` controls the initially selected recipient.
- `coordinatorMember` is an ordinary member reference, not a hard-coded role.

Each Fleet/member pair receives a different persistent Copilot session:

```text
fleet-<workspace-hash>-<fleet-id>-<member-id>
```

The same catalog agent can therefore appear in multiple Fleets—or more than once in one Fleet under different member IDs—without sharing conversation context.

### Validation

A Fleet is rejected before startup when it contains:

- Unknown catalog agents, permission profiles, members, or groups
- Invalid entry/coordinator references
- Permission-path elevation
- Missing required coordinator fallback edges or paths
- Disallowed isolated members
- Members unreachable from the entry member

Fleet startup is all-or-nothing. Telescope marks invalid profiles and displays their exact diagnostics.

### Models

`model`, `reasoningEffort`, and `reasoningSummary` are optional on both catalog agents and Fleet members. Member values override catalog values. `reasoningSummary` accepts `none`, `concise`, or `detailed` and defaults to `detailed`. When omitted, the Copilot runtime chooses its default model. Use the host `models.list` protocol request to inspect the current account’s available models.

## Messaging and recovery

The `send_message` tool is generated separately for every Fleet member. Its model-facing recipient list contains only validated Fleet-local IDs allowed by that member’s ACL. Broadcast is exposed only when `canBroadcast` is true.

Messages are written transactionally to SQLite before delivery. Busy recipients are not interrupted; their mailbox is drained after the session becomes idle. Delivery uses leases and idempotent message IDs, so interrupted delivery returns to `pending` after restart.

Copilot’s own session store remains authoritative for full conversation history. SQLite stores run/member mappings, durable mail, selected lifecycle events, leases, and recovery checkpoints.

Restarting Neovim surfaces persisted state but does not automatically restart a Fleet or spend additional credits.

## Rendering and observability

Conversation, mailbox, and status views are native `nofile` Markdown buffers. Inline activity and reasoning are part of each conversation buffer. The buffers retain normal Neovim navigation, search, yank, folds, marks, and window mappings.

Streaming deltas are batched and appended only to the changed buffer tail. Rich Markdown rendering is disabled while a response is streaming, debounced at turn completion, scoped to windows where the buffer is visible, and deferred for hidden buffers until they become visible. Configure this with `stream_flush_ms` and `render_debounce_ms`.

SDK-provided reasoning summaries, intent, tool activity, and errors appear inline in the conversation using the muted `Comment` highlight, similar to Copilot CLI's timeline. Whether reasoning content is emitted depends on the selected model and GitHub Copilot runtime. The plugin does not manufacture or expose private hidden chain-of-thought.

Slash commands are listed and invoked through the active Copilot SDK session. Nothing is hardcoded for `/autopilot`: built-ins, aliases, skills, plugins, and future runtime commands are discovered dynamically. Enter a slash command directly or press `/` in an empty prompt to browse the commands available to the selected agent.

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
stdpath("state")\copilot-fleet.log
```
