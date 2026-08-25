local root = vim.env.COPILOT_FLEET_ROOT
assert(root and root ~= '', 'COPILOT_FLEET_ROOT is required')
vim.opt.runtimepath:prepend(root)

local fleet = require('copilot_fleet')
fleet.setup({ overview_max_agents = 4 })
local hidden_lines = {}
for index = 1, 40 do
  table.insert(hidden_lines, ('Hidden retained line %d.'):format(index))
end
fleet.show_member('standard')
fleet._on_event({
  v = 1,
  type = 'mode.changed',
  payload = {
    mode = 'standard',
    displayName = 'Copilot',
  },
})
assert(
  vim.b[vim.api.nvim_get_current_buf()].copilot_fleet_prompt == true,
  'mode initialization did not return focus to the input buffer'
)
fleet._on_event({
  v = 1,
  type = 'mode.changed',
  payload = {
    mode = 'fleet',
    fleetId = 'ui-smoke',
    entryMember = 'coordinator',
    members = {
      { id = 'coordinator', displayName = 'Coordinator' },
      { id = 'planner', displayName = 'Planner' },
      { id = 'implementer', displayName = 'Implementer' },
      { id = 'reviewer', displayName = 'Reviewer' },
      { id = 'observer', displayName = 'Observer' },
    },
  },
})
assert(
  vim.b[vim.api.nvim_get_current_buf()].copilot_fleet_prompt == true,
  'Fleet initialization did not return focus to the input buffer'
)
fleet._on_event({
  v = 1,
  type = 'commands.list',
  payload = {
    target = 'coordinator',
    purpose = 'cache',
    commands = {
      { name = 'mcp', description = 'Manage MCP servers', kind = 'builtin' },
    },
  },
})
local command_catalog = require('copilot_fleet.commands').catalog('coordinator')
assert(require('copilot_fleet.commands').find(command_catalog, 'tasks').kind == 'client')
fleet._on_event({
  v = 1,
  id = 'tasks-changed',
  type = 'tasks.changed',
  memberId = 'coordinator',
  target = 'status',
  done = true,
  payload = {
    tasks = {
      {
        id = 'agent-running',
        type = 'agent',
        status = 'running',
        description = 'Review implementation',
      },
      {
        id = 'shell-complete',
        type = 'shell',
        status = 'completed',
        command = 'npm test',
      },
      {
        id = 'agent-failed',
        type = 'agent',
        status = 'failed',
        description = 'Validate deployment',
      },
    },
  },
})
local task_buf = vim.fn.bufnr('copilot-fleet://tasks')
assert(task_buf > 0, 'task buffer was not created')
assert(vim.bo[task_buf].modifiable == false)
assert(vim.bo[task_buf].readonly == true)
local task_win = vim.fn.win_findbuf(task_buf)[1]
assert(task_win, 'task buffer is not visible between conversation and prompt')
assert(vim.wo[task_win].winbar:find('○ 1 active', 1, true))
assert(vim.wo[task_win].winbar:find('✓ 1 done', 1, true))
assert(vim.wo[task_win].winbar:find('✗ 1 failed', 1, true))
local task_text = table.concat(vim.api.nvim_buf_get_lines(task_buf, 0, -1, false), '\n')
assert(task_text:find('○ [agent] Review implementation', 1, true))
assert(task_text:find('✓ [shell] npm test', 1, true))
assert(task_text:find('✗ [agent] Validate deployment', 1, true))
local task_maps = vim.api.nvim_buf_call(task_buf, function()
  return {
    cancel = vim.fn.maparg('dd', 'n', false, true),
    details = vim.fn.maparg('<CR>', 'n', false, true),
    back = vim.fn.maparg('<BS>', 'n', false, true),
  }
end)
assert(task_maps.cancel.buffer == 1, 'task cancellation mapping is not buffer-local')
assert(task_maps.details.buffer == 1, 'task details mapping is not buffer-local')
assert(task_maps.back.buffer == 1, 'task back mapping is not buffer-local')
vim.api.nvim_set_current_win(task_win)
vim.api.nvim_win_set_cursor(task_win, { 1, 0 })
local protocol = require('copilot_fleet.protocol')
local original_send = protocol.send
protocol.send = function() return 'ui-smoke-request' end
task_maps.details.callback()
protocol.send = original_send
fleet._on_event({
  v = 1,
  id = 'task-progress',
  type = 'tasks.progress',
  memberId = 'coordinator',
  target = 'status',
  done = true,
  payload = {
    target = 'coordinator',
    taskId = 'agent-running',
    progress = {
      type = 'agent',
      latestIntent = 'Checking the implementation',
      recentActivity = {
        { message = '✓ Read changed files', timestamp = '2026-08-25T18:00:00Z' },
      },
    },
  },
})
task_text = table.concat(vim.api.nvim_buf_get_lines(task_buf, 0, -1, false), '\n')
assert(task_text:find('Intent: Checking the implementation', 1, true))
assert(task_text:find('✓ Read changed files', 1, true))
task_maps.back.callback()
task_text = table.concat(vim.api.nvim_buf_get_lines(task_buf, 0, -1, false), '\n')
assert(task_text:find('○ [agent] Review implementation', 1, true))
vim.api.nvim_set_current_win(vim.fn.win_findbuf(vim.fn.bufnr('AI Prompt'))[1])
fleet._on_event({
  v = 1,
  type = 'environment.progress',
  memberId = 'coordinator',
  target = 'activity',
  payload = {
    component = 'Copilot environment',
    message = 'Starting runtime and discovering configuration',
  },
})
assert(vim.wo[task_win].winbar:find('loading', 1, true), 'loading state is absent from task winbar')
fleet._on_event({
  v = 1,
  type = 'environment.loaded',
  memberId = 'coordinator',
  target = 'activity',
  done = true,
  payload = {
    component = 'MCP servers',
    items = {
      { name = 'github', status = 'connected' },
      { name = 'local', status = 'failed' },
    },
  },
})
local coordinator_buf = require('copilot_fleet.buffers').buffer('coordinator', 'conversation')
local environment_text = table.concat(
  vim.api.nvim_buf_get_lines(coordinator_buf, 0, -1, false),
  '\n'
)
assert(environment_text:find('Loading Copilot environment', 1, true))
assert(environment_text:find('1 connected, 1 failed', 1, true))
local native_picker
local original_select = vim.ui.select
vim.ui.select = function(items, opts, on_choice)
  native_picker = { items = items, opts = opts }
  on_choice(nil)
end
fleet._on_event({
  v = 1,
  type = 'command.result',
  memberId = 'coordinator',
  target = 'conversation',
  done = true,
  payload = {
    target = 'coordinator',
    name = 'tasks',
    result = {
      kind = 'select-subcommand',
      command = 'tasks',
      title = 'Tasks',
      options = {
        { name = 'list', description = 'List tasks' },
      },
    },
  },
})
vim.ui.select = original_select
assert(native_picker, 'native picker frontend was not used')
assert(native_picker.opts.prompt == 'Tasks')
assert(native_picker.items[1].option.name == 'list')
local permission_response
local original_send = protocol.send
vim.ui.select = function(items, opts, on_choice)
  native_picker = { items = items, opts = opts }
  on_choice(items[1])
end
protocol.send = function(message_type, payload)
  if message_type == 'permission.respond' then permission_response = payload end
  return 'permission-response'
end
fleet._on_event({
  v = 1,
  id = 'permission-request',
  type = 'permission.requested',
  memberId = 'coordinator',
  target = 'status',
  done = false,
  payload = {
    requestId = 'managed-permission',
    request = {
      kind = 'shell',
      fullCommandText = 'npm test',
      managedApprovalRequired = true,
    },
  },
})
vim.ui.select = original_select
protocol.send = original_send
assert(native_picker.opts.prompt:find('managed approval required', 1, true))
assert(permission_response.requestId == 'managed-permission')
assert(permission_response.approved == true)
native_picker = nil
vim.ui.select = function(items, opts, on_choice)
  native_picker = { items = items, opts = opts }
  on_choice(nil)
end
fleet._on_event({
  v = 1,
  type = 'tasks.list',
  memberId = 'coordinator',
  target = 'status',
  done = true,
  payload = {
    target = 'coordinator',
    tasks = {
      {
        type = 'agent',
        id = 'running-agent',
        status = 'running',
        description = 'Review the implementation',
      },
      {
        type = 'shell',
        id = 'completed-shell',
        status = 'completed',
        command = 'npm test',
      },
    },
  },
})
vim.ui.select = original_select
assert(native_picker, 'task cancellation picker was not shown')
assert(native_picker.opts.prompt == 'Cancel background task — coordinator')
assert(#native_picker.items == 1, 'completed tasks were offered for cancellation')
assert(native_picker.items[1].task.id == 'running-agent')
fleet.show_overview()

local wins = vim.api.nvim_tabpage_list_wins(0)
assert(#wins == 6, ('expected four agent windows, one task strip, and one prompt, got %d'):format(#wins))
local visible = {}
for _, win in ipairs(wins) do
  visible[vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(win))] = true
end
assert(visible['copilot-fleet://coordinator/conversation'])
assert(visible['copilot-fleet://planner/conversation'])
assert(visible['copilot-fleet://implementer/conversation'])
assert(visible['copilot-fleet://reviewer/conversation'])
local prompt_visible = false
for name in pairs(visible) do
  if vim.fn.fnamemodify(name, ':t') == 'AI Prompt' then prompt_visible = true end
end
assert(prompt_visible, 'missing prompt buffer; visible=' .. vim.inspect(visible))
assert(not visible['copilot-fleet://observer/conversation'])

fleet._on_event({
  v = 1,
  id = 'observer-message',
  type = 'conversation.message',
  memberId = 'observer',
  target = 'conversation',
  done = true,
  payload = {
    messageId = 'observer-message',
    content = table.concat(hidden_lines, '\n'),
  },
})
local buffers = require('copilot_fleet.buffers')
assert(buffers.get_member('observer').unread == 1)
local observer_buf = buffers.buffer('observer', 'conversation')
local text = table.concat(vim.api.nvim_buf_get_lines(observer_buf, 0, -1, false), '\n')
assert(text:find('Hidden retained line 40.', 1, true))

fleet.show_member('observer')
assert(buffers.get_member('observer').unread == 0)
assert(vim.api.nvim_get_current_buf() == observer_buf)
assert(#vim.api.nvim_tabpage_list_wins(0) == 3, 'member view does not contain one task strip')
assert(
  vim.api.nvim_win_get_cursor(0)[1] == vim.api.nvim_buf_line_count(observer_buf),
  'opening a conversation did not follow its last line'
)
assert(vim.fn.line('w$') == vim.api.nvim_buf_line_count(observer_buf), 'conversation bottom is not visible')
fleet._on_event({
  v = 1,
  id = 'reasoning-summary',
  type = 'activity.reasoning',
  memberId = 'observer',
  target = 'activity',
  done = true,
  payload = {
    reasoningId = 'reasoning-summary',
    content = 'The SDK-provided reasoning summary is visible.',
  },
})
local conversation_text = table.concat(
  vim.api.nvim_buf_get_lines(observer_buf, 0, -1, false),
  '\n'
)
assert(conversation_text:find('The SDK-provided reasoning summary is visible.', 1, true))
local namespace = vim.api.nvim_get_namespaces().copilot_fleet_inline_activity
local activity_marks = vim.api.nvim_buf_get_extmarks(observer_buf, namespace, 0, -1, {
  details = true,
})
assert(#activity_marks > 0, 'inline activity has no muted highlight')
assert(activity_marks[#activity_marks][4].hl_group == 'Comment')

fleet._on_event({
  v = 1,
  id = 'tool-activity',
  type = 'activity.event',
  memberId = 'observer',
  target = 'activity',
  done = true,
  payload = {
    eventType = 'Tool',
    data = { toolName = 'view' },
  },
})
fleet._on_event({
  v = 1,
  id = 'observer-response',
  type = 'conversation.delta',
  memberId = 'observer',
  target = 'conversation',
  done = false,
  payload = {
    messageId = 'observer-response',
    content = 'Assistant output remains normally highlighted.',
  },
})
fleet._on_event({
  v = 1,
  id = 'observer-response',
  type = 'conversation.message',
  memberId = 'observer',
  target = 'conversation',
  done = true,
  payload = {
    messageId = 'observer-response',
    content = 'Assistant output remains normally highlighted.',
  },
})
conversation_text = table.concat(vim.api.nvim_buf_get_lines(observer_buf, 0, -1, false), '\n')
assert(conversation_text:find('> **Tool**', 1, true))
assert(conversation_text:find('> view', 1, true))
assert(conversation_text:find('Assistant output remains normally highlighted.', 1, true))
assert(
  vim.api.nvim_win_get_cursor(0)[1] == vim.api.nvim_buf_line_count(observer_buf),
  'streamed response did not keep the cursor at the bottom'
)
assert(vim.fn.line('w$') == vim.api.nvim_buf_line_count(observer_buf), 'streamed response bottom is hidden')
fleet._on_event({
  v = 1,
  id = 'late-reasoning',
  type = 'activity.reasoning',
  memberId = 'observer',
  target = 'activity',
  done = true,
  payload = {
    reasoningId = 'late-reasoning',
    content = 'Late reasoning remains above the assistant response.',
  },
})
conversation_text = table.concat(vim.api.nvim_buf_get_lines(observer_buf, 0, -1, false), '\n')
local late_reasoning_position = conversation_text:find(
  'Late reasoning remains above the assistant response.',
  1,
  true
)
local response_position = conversation_text:find(
  'Assistant output remains normally highlighted.',
  1,
  true
)
assert(
  late_reasoning_position and response_position and late_reasoning_position < response_position,
  'late reasoning was rendered below the assistant response'
)
activity_marks = vim.api.nvim_buf_get_extmarks(observer_buf, namespace, 0, -1, {
  details = true,
})
local assistant_row
for row, line in ipairs(vim.api.nvim_buf_get_lines(observer_buf, 0, -1, false)) do
  if line == '## Observer' then assistant_row = row - 1 end
end
assert(assistant_row, 'assistant response heading was not found')
for _, mark in ipairs(activity_marks) do
  assert(mark[4].end_row <= assistant_row, 'activity highlight leaked into assistant output')
end

fleet._on_event({
  v = 1,
  id = 'command-result',
  type = 'command.result',
  memberId = 'observer',
  target = 'conversation',
  done = true,
  payload = {
    target = 'observer',
    name = 'future-command',
    result = {
      kind = 'text',
      text = 'Dynamically discovered command output.',
      markdown = true,
    },
  },
})
conversation_text = table.concat(vim.api.nvim_buf_get_lines(observer_buf, 0, -1, false), '\n')
assert(conversation_text:find('## /future-command', 1, true))
assert(conversation_text:find('Dynamically discovered command output.', 1, true))

fleet.close()
fleet.show_member('observer')
assert(#vim.api.nvim_tabpage_list_wins(0) == 3, 'UI reopen did not restore one task strip')
assert(
  vim.api.nvim_win_get_cursor(0)[1] == vim.api.nvim_buf_line_count(observer_buf),
  'reopened conversation did not follow its last line'
)
assert(vim.fn.line('w$') == vim.api.nvim_buf_line_count(observer_buf), 'reopened bottom is hidden')
fleet.close()
print('nvim UI smoke passed')
