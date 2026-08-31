local root = vim.env.NATIVE_COPILOT_ROOT
assert(root and root ~= '', 'NATIVE_COPILOT_ROOT is required')
vim.opt.runtimepath:prepend(root)

local fleet = require('native_copilot')
fleet.setup({ overview_max_agents = 4 })
local hidden_lines = {}
for index = 1, 40 do
  table.insert(hidden_lines, ('Hidden retained line %d.'):format(index))
end
fleet.show_member('standard')
fleet._on_event({
  v = 1,
  type = 'standard.ready',
  payload = {
    displayName = 'Copilot',
  },
})
assert(
  vim.b[vim.api.nvim_get_current_buf()].native_copilot_prompt == true,
  'Standard initialization did not return focus to the input buffer'
)
assert(
  require('native_copilot.buffers').get_member('standard'),
  'Standard supervisor session was not created'
)
fleet._on_event({
  v = 1,
  type = 'fleet.loading',
  payload = {
    fleetId = 'ui-smoke',
    name = 'UI Smoke Fleet',
    entryMember = 'coordinator',
    recovered = false,
    connectingMembers = { 'coordinator', 'planner', 'implementer', 'reviewer' },
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
  require('native_copilot.buffers').get_member('standard'),
  'Standard supervisor was dropped when a Fleet started loading'
)
local loading_entry = require('native_copilot.buffers').get_member('coordinator')
assert(loading_entry.state == 'loading', 'Fleet member did not enter loading state')
assert(
  vim.b[vim.api.nvim_get_current_buf()].native_copilot_prompt == true,
  'Fleet loading stole focus from the input buffer'
)
assert(
  require('native_copilot.buffers').get_member('observer').state == 'standby',
  'lazy Fleet member did not remain in standby'
)
local loading_text = table.concat(
  vim.api.nvim_buf_get_lines(loading_entry.views.conversation.buf, 0, -1, false),
  '\n'
)
assert(loading_text:find('Starting Fleet', 1, true), 'Fleet startup activity is missing')
fleet._on_event({
  v = 1,
  type = 'fleet.ready',
  payload = {
    fleetId = 'ui-smoke',
    name = 'UI Smoke Fleet',
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
  require('native_copilot.buffers').get_member('standard'),
  'Standard supervisor was dropped when a Fleet became ready'
)
assert(
  vim.b[vim.api.nvim_get_current_buf()].native_copilot_prompt == true,
  'Fleet readiness stole focus from the input buffer'
)
fleet.show_member('coordinator')
assert(
  vim.b[vim.api.nvim_get_current_buf()].native_copilot_prompt ~= true,
  'showing a Fleet member should focus its conversation view'
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
local command_catalog = require('native_copilot.commands').catalog('coordinator')
assert(require('native_copilot.commands').find(command_catalog, 'tasks').kind == 'client')
assert(require('native_copilot.commands').find(command_catalog, 'fleet').kind == 'client')
assert(require('native_copilot.commands').find(command_catalog, 'resume').kind == 'client')
assert(require('native_copilot.commands').find(command_catalog, 'mcp-reload').kind == 'client')
assert(require('native_copilot.commands').find(command_catalog, 'mcp').kind == 'client')
assert(require('native_copilot.commands').find(command_catalog, 'model').kind == 'client')
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
        result = 'All tests passed.',
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
local buffers = require('native_copilot.buffers')
local coordinator_buf = buffers.buffer('coordinator', 'conversation')
assert(vim.fn.bufnr('native-copilot://tasks') == -1, 'legacy task buffer was created')
local function buffer_text(buf)
  return table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), '\n')
end
local function line_with(buf, text)
  for index, line in ipairs(vim.api.nvim_buf_get_lines(buf, 0, -1, false)) do
    if line:find(text, 1, true) then return index end
  end
end
local function line_count_with(buf, text)
  local count = 0
  for _, line in ipairs(vim.api.nvim_buf_get_lines(buf, 0, -1, false)) do
    if line:find(text, 1, true) then count = count + 1 end
  end
  return count
end
fleet._on_event({
  v = 1,
  id = 'runtime-turn',
  type = 'member.state',
  memberId = 'planner',
  payload = { state = 'busy', turnId = 'runtime-turn' },
})
fleet._on_event({
  v = 1,
  id = 'runtime-message-1',
  type = 'conversation.message',
  memberId = 'planner',
  payload = { messageId = 'runtime-message-1', content = 'Before the tool.' },
})
fleet._on_event({
  v = 1,
  id = 'runtime-tool',
  type = 'activity.event',
  memberId = 'planner',
  payload = {
    eventType = 'tool.execution_complete',
    data = { toolCallId = 'runtime-tool', success = true },
  },
})
fleet._on_event({
  v = 1,
  id = 'runtime-message-2',
  type = 'conversation.message',
  memberId = 'planner',
  payload = { messageId = 'runtime-message-2', content = 'After the tool.' },
})
fleet._on_event({
  v = 1,
  id = 'runtime-turn-idle',
  type = 'member.state',
  memberId = 'planner',
  payload = { state = 'idle' },
})
local runtime_turn_text = buffer_text(
  require('native_copilot.buffers').buffer('planner', 'conversation')
)
assert(
  line_count_with(
    require('native_copilot.buffers').buffer('planner', 'conversation'),
    '🤖 ·'
  ) == 1,
  'runtime-initiated tool turn rendered more than one Copilot heading'
)
assert(runtime_turn_text:find('Before the tool.', 1, true))
assert(runtime_turn_text:find('After the tool.', 1, true))
local timeline_text = buffer_text(coordinator_buf)
assert(
  timeline_text:find(
    '   🟢 [task][agent-running] started · [agent] Review implementation',
    1,
    true
  )
)
assert(
  timeline_text:find(
    '🧑‍💻 · ',
    1,
    true
  )
    and timeline_text:find(
      '   🟢 [task][shell-complete] completed · [shell] npm test — All tests passed.',
      1,
      true
    ),
  'a completed task did not render its terminal event'
)
assert(
  timeline_text:find(
    '   🔴 [task][agent-failed] failed · [agent] Validate deployment',
    1,
    true
  )
)
local coordinator_win = vim.fn.win_findbuf(coordinator_buf)[1]
vim.api.nvim_set_current_win(coordinator_win)
vim.api.nvim_win_set_cursor(coordinator_win, {
  assert(line_with(coordinator_buf, '[agent] Review implementation')),
  0,
})
local conversation_maps = vim.api.nvim_buf_call(coordinator_buf, function()
  return { details = vim.fn.maparg('<CR>', 'n', false, true) }
end)
assert(conversation_maps.details.buffer == 1, 'conversation task mapping is not buffer-local')
local protocol = require('native_copilot.protocol')
local original_send = protocol.send
protocol.send = function() return 'ui-smoke-request' end
conversation_maps.details.callback()
protocol.send = original_send
local task_detail_buf = vim.api.nvim_get_current_buf()
assert(vim.api.nvim_win_get_config(0).relative == 'editor', 'task details did not open in a float')
fleet._on_event({
  v = 1,
  id = 'task-progress-missing',
  type = 'tasks.progress',
  memberId = 'coordinator',
  target = 'status',
  done = true,
  payload = {
    target = 'coordinator',
    taskId = 'agent-running',
    progress = vim.NIL,
  },
})
assert(
  buffer_text(task_detail_buf):find('No progress details are available.', 1, true),
  'null task progress was not rendered safely'
)
local running_task_row = assert(line_with(coordinator_buf, '[agent] Review implementation'))
fleet._on_event({
  v = 1,
  id = 'task-failed',
  type = 'tasks.changed',
  memberId = 'coordinator',
  target = 'status',
  done = true,
  payload = {
    tasks = {
      {
        id = 'agent-running',
        type = 'agent',
        status = 'failed',
        description = 'Review implementation',
        error = 'Reviewer process exited with code 1',
      },
    },
  },
})
assert(
  line_count_with(coordinator_buf, '[agent] Review implementation') == 2,
  'task start and failure did not render as separate events'
)
local failed_task_row
for index, line in ipairs(vim.api.nvim_buf_get_lines(coordinator_buf, 0, -1, false)) do
  if line:find('[task][agent-running] failed', 1, true) then failed_task_row = index end
end
assert(failed_task_row and failed_task_row > running_task_row, 'task failure was not chronological')
assert(
  buffer_text(coordinator_buf):find(
    '🧑‍💻 · ',
    1,
    true
  )
    and buffer_text(coordinator_buf):find(
      '   🔴 [task][agent-running] failed · [agent] Review implementation',
      1,
      true
    ),
  'failed task event did not use the terminal indicator'
)
assert(
  buffer_text(coordinator_buf):match(
    '🧑‍💻 · %d%d:%d%d:%d%d\n\n'
      .. '   🔴 %[task%]%[agent%-running%] failed · %[agent%] Review implementation'
  ),
  'failed task actor message did not use one blank line after its header'
)
local failed_task_header = failed_task_row - 2
assert(
  buffers.timeline_item_at_cursor(coordinator_buf, failed_task_header).status == 'failed',
  'task details were not available from the actor header'
)
assert(
  buffers.timeline_item_at_cursor(coordinator_buf, failed_task_row).status == 'failed',
  'task details were not available from the actor message'
)
assert(
  buffer_text(coordinator_buf):find(
    '   🔴 [task][agent-running] failed · [agent] Review implementation',
    1,
    true
  ),
  'failed task event did not use the terminal indicator'
)
assert(buffer_text(task_detail_buf):find('Status: failed', 1, true))
assert(buffer_text(task_detail_buf):find('Reviewer process exited with code 1', 1, true))
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
local detail_text = buffer_text(task_detail_buf)
assert(detail_text:find('Intent: Checking the implementation', 1, true))
assert(detail_text:find('✓ Read changed files', 1, true))
local close_detail = vim.api.nvim_buf_call(task_detail_buf, function()
  return vim.fn.maparg('q', 'n', false, true)
end)
close_detail.callback()
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
timeline_text = buffer_text(coordinator_buf)
assert(
  timeline_text:find(
    '🟡 [environment] Copilot environment — Starting runtime and discovering configuration',
    1,
    true
  ),
  'loading state is absent from the conversation timeline'
)
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
local environment_text = table.concat(
  vim.api.nvim_buf_get_lines(coordinator_buf, 0, -1, false),
  '\n'
)
assert(
  environment_text:find('🟢 [environment] MCP github — connected', 1, true)
)
assert(
  environment_text:find('🔴 [environment] MCP local — failed', 1, true)
)
assert(
  environment_text:find('Copilot environment', 1, true),
  'initial Copilot environment row was removed'
)
local github_mcp_row = assert(line_with(coordinator_buf, '[environment] MCP github'))
local local_mcp_row = assert(line_with(coordinator_buf, '[environment] MCP local'))
assert(local_mcp_row - github_mcp_row == 1, 'MCP rows should be directly adjacent')
fleet._on_event({
  v = 1,
  type = 'member.state',
  memberId = 'coordinator',
  payload = { state = 'idle' },
})
assert(
  buffer_text(coordinator_buf):find(
    '🟢 [environment] Copilot environment — ready',
    1,
    true
  ),
  'initial Copilot environment row did not transition to ready'
)
vim.bo[coordinator_buf].modifiable = true
vim.api.nvim_buf_set_lines(
  coordinator_buf,
  github_mcp_row,
  github_mcp_row,
  false,
  { '> 🟡 [environment] MCP github — orphaned pending' }
)
vim.bo[coordinator_buf].modifiable = false
assert(line_count_with(coordinator_buf, '[environment] MCP github') == 2)
fleet._on_event({
  v = 1,
  type = 'environment.status',
  memberId = 'coordinator',
  payload = {
    component = 'MCP github',
    status = 'pending',
  },
})
assert(buffer_text(coordinator_buf):find('🟡 [environment] MCP github — pending', 1, true))
assert(line_with(coordinator_buf, '[environment] MCP github') == github_mcp_row)
assert(line_count_with(coordinator_buf, '[environment] MCP github') == 1)
fleet._on_event({
  v = 1,
  type = 'environment.status',
  memberId = 'coordinator',
  payload = {
    component = 'MCP github',
    status = 'connected',
  },
})
assert(buffer_text(coordinator_buf):find('🟢 [environment] MCP github — connected', 1, true))
assert(line_with(coordinator_buf, '[environment] MCP github') == github_mcp_row)
assert(line_count_with(coordinator_buf, '[environment] MCP github') == 1)
local task_action_sent = false
protocol.send = function()
  task_action_sent = true
  return 'unexpected-task-action'
end
vim.api.nvim_set_current_win(coordinator_win)
vim.api.nvim_win_set_cursor(coordinator_win, {
  assert(line_with(coordinator_buf, '[environment] MCP github')),
  0,
})
conversation_maps.details.callback()
protocol.send = original_send
assert(not task_action_sent, 'environment rows must not invoke task actions')
fleet._on_event({
  v = 1,
  type = 'environment.error',
  memberId = 'coordinator',
  target = 'activity',
  done = true,
  payload = {
    component = 'Skills',
    message = 'Invalid skill metadata',
  },
})
environment_text = table.concat(
  vim.api.nvim_buf_get_lines(coordinator_buf, 0, -1, false),
  '\n'
)
assert(
  environment_text:find('🔴 [environment] Skills — Invalid skill metadata', 1, true),
  'environment failure is absent from conversation'
)
local prompt_buf = vim.fn.bufnr('AI Prompt')
local prompt_submit = vim.api.nvim_buf_call(prompt_buf, function()
  return vim.fn.maparg('<CR>', 'n', false, true)
end)
local invoked_command
protocol.send = function(message_type, payload)
  invoked_command = { type = message_type, payload = payload }
  return 'command-request'
end
vim.bo[prompt_buf].modifiable = true
vim.api.nvim_buf_set_lines(prompt_buf, 0, -1, false, { '/context' })
prompt_submit.callback()
protocol.send = original_send
assert(invoked_command.type == 'command.invoke')
assert(invoked_command.payload.name == 'context')
assert(buffer_text(coordinator_buf):match('👨 · %d%d:%d%d:%d%d\n\n   /context'))
assert(not buffer_text(coordinator_buf):find('[command]', 1, true))
fleet._on_event({
  v = 1,
  type = 'command.result',
  requestId = 'command-request',
  memberId = 'coordinator',
  target = 'conversation',
  done = true,
  payload = {
    target = 'coordinator',
    name = 'context',
    result = { kind = 'text', text = 'Context usage output' },
  },
})
assert(buffer_text(coordinator_buf):match(
  '🤖 · %d%d:%d%d:%d%d\n\n   Context usage output'
))
protocol.send = function(message_type, payload)
  invoked_command = { type = message_type, payload = payload }
  return 'model-list-request'
end
vim.api.nvim_buf_set_lines(prompt_buf, 0, -1, false, { '/model' })
prompt_submit.callback()
protocol.send = original_send
assert(invoked_command.type == 'model.list')
assert(invoked_command.payload.target == 'coordinator')
local original_select = vim.ui.select
local model_picker
protocol.send = function(message_type, payload)
  invoked_command = { type = message_type, payload = payload }
  return 'model-switch-request'
end
vim.ui.select = function(items, opts, on_choice)
  model_picker = { items = items, opts = opts }
  on_choice(items[2])
end
fleet._on_event({
  v = 1,
  type = 'model.list',
  memberId = 'coordinator',
  payload = {
    target = 'coordinator',
    purpose = 'select',
    state = {
      current = { modelId = 'gpt-5.4' },
      models = {
        { id = 'gpt-5.4', name = 'GPT-5.4' },
        { id = 'claude-sonnet-5', name = 'Claude Sonnet 5' },
      },
    },
  },
})
vim.ui.select = original_select
protocol.send = original_send
assert(model_picker.opts.prompt:find('current: gpt%-5%.4'))
assert(invoked_command.type == 'model.switch')
assert(invoked_command.payload.modelId == 'claude-sonnet-5')
fleet._on_event({
  v = 1,
  type = 'session.metrics',
  memberId = 'coordinator',
  payload = { modelId = 'gpt-5.4', aicUsed = 0.1254 },
})
assert(vim.wo[coordinator_win].winbar:find('Model: gpt%-5%.4'))
assert(vim.wo[coordinator_win].winbar:find('AIC used: 0%.125'))
fleet._on_event({
  v = 1,
  type = 'model.changed',
  memberId = 'coordinator',
  payload = { model = { modelId = 'claude-sonnet-5' } },
})
assert(buffer_text(coordinator_buf):find('Model switched to `claude-sonnet-5`.', 1, true))
assert(vim.wo[coordinator_win].winbar:find('Model: claude%-sonnet%-5'))
protocol.send = function(message_type, payload)
  invoked_command = { type = message_type, payload = payload }
  return 'mcp-list-request'
end
vim.api.nvim_buf_set_lines(prompt_buf, 0, -1, false, { '/mcp list' })
prompt_submit.callback()
protocol.send = original_send
assert(invoked_command.type == 'mcp.list')
assert(invoked_command.payload.purpose == 'display')
fleet._on_event({
  v = 1,
  type = 'mcp.list',
  memberId = 'coordinator',
  payload = {
    target = 'coordinator',
    purpose = 'display',
    servers = {
      { name = 'github-mcp-server', status = 'connected' },
      { name = 'local-tools', status = 'disabled' },
    },
  },
})
assert(buffer_text(coordinator_buf):find('| github-mcp-server | connected |', 1, true))
local mcp_picker_count = 0
protocol.send = function(message_type, payload)
  invoked_command = { type = message_type, payload = payload }
  return 'mcp-action-request'
end
vim.ui.select = function(items, _, on_choice)
  mcp_picker_count = mcp_picker_count + 1
  on_choice(items[1])
end
fleet._on_event({
  v = 1,
  type = 'mcp.list',
  memberId = 'coordinator',
  payload = {
    target = 'coordinator',
    purpose = 'select',
    servers = {
      { name = 'github-mcp-server', status = 'connected' },
    },
  },
})
vim.ui.select = original_select
protocol.send = original_send
assert(mcp_picker_count == 2)
assert(invoked_command.type == 'mcp.show')
assert(invoked_command.payload.serverName == 'github-mcp-server')
fleet._on_event({
  v = 1,
  id = 'command-prompt-queued',
  type = 'prompt.queued',
  memberId = 'coordinator',
  target = 'activity',
  done = false,
  payload = {
    id = 'command-prompt-1',
    source = 'command',
    content = '/delegate implementation',
  },
})
assert(not buffer_text(coordinator_buf):find('[prompt] Prompt', 1, true))
fleet._on_event({
  v = 1,
  type = 'member.state',
  memberId = 'coordinator',
  payload = { state = 'busy' },
})
local prompt_sends = {}
protocol.send = function(message_type, payload)
  table.insert(prompt_sends, { type = message_type, payload = payload })
  return 'prompt-request-' .. #prompt_sends
end
vim.api.nvim_buf_set_lines(prompt_buf, 0, -1, false, { 'Implement the first feature' })
prompt_submit.callback()
vim.api.nvim_buf_set_lines(prompt_buf, 0, -1, false, { 'Implement the second feature' })
prompt_submit.callback()
assert(#prompt_sends == 0, 'busy Copilot received a prompt instead of queueing it')
local prompt_queue_buf = vim.fn.bufnr('native-copilot://prompt-queue')
assert(prompt_queue_buf > 0, 'prompt queue buffer was not created')
assert(#vim.fn.win_findbuf(prompt_queue_buf) == 1, 'prompt queue pane was not opened')
assert(buffer_text(prompt_queue_buf):find('1. Implement the first feature', 1, true))
assert(buffer_text(prompt_queue_buf):find('2. Implement the second feature', 1, true))
local queue_win = vim.fn.win_findbuf(prompt_queue_buf)[1]
vim.api.nvim_set_current_win(queue_win)
vim.api.nvim_win_set_cursor(queue_win, { 2, 0 })
local queue_maps = vim.api.nvim_buf_call(prompt_queue_buf, function()
  return {
    edit = vim.fn.maparg('<CR>', 'n', false, true),
    cancel = vim.fn.maparg('dd', 'n', false, true),
    pause = vim.fn.maparg('p', 'n', false, true),
  }
end)
queue_maps.edit.callback()
assert(buffer_text(prompt_buf):find('Implement the first feature', 1, true))
vim.api.nvim_buf_set_lines(prompt_buf, 0, -1, false, { 'Implement the edited first feature' })
prompt_submit.callback()
assert(buffer_text(prompt_queue_buf):find('1. Implement the edited first feature', 1, true))
assert(buffer_text(prompt_queue_buf):find('Queued prompts — paused', 1, true))
vim.api.nvim_set_current_win(queue_win)
vim.api.nvim_win_set_cursor(queue_win, { 3, 0 })
queue_maps.cancel.callback()
assert(not buffer_text(prompt_queue_buf):find('second feature', 1, true))
queue_maps.pause.callback()
assert(buffer_text(prompt_queue_buf):find('Queued prompts — FIFO', 1, true))
assert(#prompt_sends == 0, 'resuming a busy queue dispatched out of turn')
fleet._on_event({
  v = 1,
  type = 'member.turn_end',
  memberId = 'coordinator',
  payload = { state = 'finishing' },
})
assert(#prompt_sends == 0, 'turn_end released a foreground prompt before assistant.idle')
fleet._on_event({
  v = 1,
  type = 'member.foreground_idle',
  memberId = 'coordinator',
  payload = { state = 'idle' },
})
assert(#prompt_sends == 1)
assert(prompt_sends[1].type == 'prompt.send')
assert(prompt_sends[1].payload.content == 'Implement the edited first feature')
assert(#vim.fn.win_findbuf(prompt_queue_buf) == 0, 'empty prompt queue pane remained open')
assert(buffer_text(coordinator_buf):match(
  '👨 · %d%d:%d%d:%d%d\n\n   Implement the edited first feature'
))
assert(buffer_text(coordinator_buf):match(
  '🤖 · writing%.'
))
assert(not buffer_text(coordinator_buf):find('[prompt] Prompt', 1, true))
fleet._on_event({
  v = 1,
  id = 'background-shell-running',
  type = 'tasks.changed',
  memberId = 'coordinator',
  payload = {
    tasks = {
      {
        id = 'background-shell-90',
        type = 'shell',
        status = 'running',
        description = 'Wait 90 seconds',
      },
    },
  },
})
fleet._on_event({
  v = 1,
  id = 'foreground-turn-ended',
  type = 'member.foreground_idle',
  memberId = 'coordinator',
  payload = { state = 'idle' },
})
vim.api.nvim_buf_set_lines(prompt_buf, 0, -1, false, {
  'Continue while the background shell is still running',
})
prompt_submit.callback()
assert(
  #prompt_sends == 2,
  'foreground idle did not release prompt dispatch while a background task was running'
)
assert(
  prompt_sends[2].payload.content == 'Continue while the background shell is still running',
  'post-background prompt was not dispatched immediately'
)
assert(
  not buffer_text(prompt_queue_buf):find('Continue while the background shell', 1, true),
  'post-background prompt was incorrectly added to the local FIFO'
)
fleet._on_event({
  v = 1,
  id = 'delayed-prior-idle',
  type = 'member.state',
  memberId = 'coordinator',
  payload = { state = 'idle' },
})
vim.api.nvim_buf_set_lines(prompt_buf, 0, -1, false, {
  'Third prompt while the second foreground turn is active',
})
prompt_submit.callback()
assert(
  #prompt_sends == 2,
  'a delayed idle event cleared the newer foreground prompt marker'
)
assert(
  buffer_text(prompt_queue_buf):find(
    'Third prompt while the second foreground turn is active',
    1,
    true
  ),
  'active newer foreground prompt did not retain FIFO protection'
)
fleet._on_event({
  v = 1,
  id = 'second-foreground-ended',
  type = 'member.foreground_idle',
  memberId = 'coordinator',
  payload = { state = 'idle' },
})
assert(#prompt_sends == 3, 'queued third prompt did not dispatch after the newer turn ended')
fleet._on_event({
  v = 1,
  id = 'third-foreground-ended',
  type = 'member.foreground_idle',
  memberId = 'coordinator',
  payload = { state = 'idle' },
})
assert(#vim.fn.win_findbuf(prompt_queue_buf) == 0, 'FIFO test left its queue pane open')
fleet._on_event({
  v = 1,
  id = 'steering-scheduled-run',
  type = 'scheduled.prompt',
  memberId = 'coordinator',
  payload = {
    eventId = 'steering-scheduled-run',
    content = '[Scheduled prompt #8] Check the active deployment',
    source = 'schedule-8',
    delivery = 'steering',
  },
})
fleet._on_event({
  v = 1,
  type = 'member.state',
  memberId = 'coordinator',
  payload = { state = 'idle' },
})
protocol.send = original_send
fleet._on_event({
  v = 1,
  type = 'schedule.created',
  memberId = 'coordinator',
  payload = {
    id = 7,
    intervalMs = 300000,
    recurring = true,
    prompt = 'Check deployment health',
  },
})
local schedule_row = assert(line_with(coordinator_buf, '[schedule][7] created'))
assert(
  buffer_text(coordinator_buf):find(
    '⏰ 🟢 [schedule][7] created · every 300s',
    1,
    true
  )
)
fleet._on_event({
  v = 1,
  type = 'schedule.rearmed',
  memberId = 'coordinator',
  payload = { id = 7, nextRunAt = 1787701200000 },
})
assert(
  buffer_text(coordinator_buf):find(
    '⏰ 🟢 [schedule][7] rearmed · every 300s',
    1,
    true
  )
)
assert(line_count_with(coordinator_buf, '[schedule][7]') == 2)
vim.api.nvim_set_current_win(coordinator_win)
vim.api.nvim_win_set_cursor(coordinator_win, { schedule_row, 0 })
conversation_maps.details.callback()
local schedule_detail_buf = vim.api.nvim_get_current_buf()
assert(buffer_text(schedule_detail_buf):find('Check deployment health', 1, true))
assert(buffer_text(schedule_detail_buf):find('every 300s', 1, true))
vim.api.nvim_buf_call(schedule_detail_buf, function()
  vim.fn.maparg('q', 'n', false, true).callback()
end)
fleet._on_event({
  v = 1,
  type = 'scheduled.prompt',
  memberId = 'coordinator',
  payload = {
    eventId = 'scheduled-run-7',
    content = 'Check deployment health',
    source = 'schedule-7',
    delivery = 'queued',
  },
})
assert(buffer_text(coordinator_buf):match(
  '👨 · %d%d:%d%d:%d%d\n\n   Check deployment health'
))
assert(not buffer_text(coordinator_buf):find('[prompt] Prompt', 1, true))
assert(
  buffer_text(coordinator_buf):find(
    '⏰ Scheduler · ',
    1,
    true
  )
    and buffer_text(coordinator_buf):find(
      '   🟢 [schedule][7] fired · every 300s',
      1,
      true
    )
)
assert(
  buffer_text(coordinator_buf):match(
    '⏰ Scheduler · %d%d:%d%d:%d%d\n\n'
      .. '   🟢 %[schedule%]%[7%] fired · every 300s'
  ),
  'schedule actor message did not use one blank line after its header'
)
local fired_schedule_row = assert(line_with(coordinator_buf, '[schedule][7] fired'))
assert(
  buffers.timeline_item_at_cursor(coordinator_buf, fired_schedule_row - 2).event == 'fired',
  'schedule details were not available from the actor header'
)
assert(
  buffers.timeline_item_at_cursor(coordinator_buf, fired_schedule_row).event == 'fired',
  'schedule details were not available from the actor message'
)
assert(
  buffer_text(coordinator_buf):find(
    '   🟢 [schedule][7] fired · every 300s',
    1,
    true
  )
)
fleet._on_event({
  v = 1,
  type = 'schedule.cancelled',
  memberId = 'coordinator',
  payload = { id = 7 },
})
assert(
  buffer_text(coordinator_buf):find(
    '⏰ ⚪ [schedule][7] cancelled · every 300s',
    1,
    true
  )
)
assert(line_count_with(coordinator_buf, '[schedule][7]') == 4)
local native_picker
original_select = vim.ui.select
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
local resumed_session
vim.ui.select = function(items, opts, on_choice)
  native_picker = { items = items, opts = opts }
  on_choice(items[1])
end
protocol.send = function(message_type, payload)
  if message_type == 'session.resume' then resumed_session = payload.sessionId end
  return 'resume-session'
end
fleet._on_event({
  v = 1,
  type = 'sessions.list',
  target = 'status',
  done = true,
  payload = {
    sessions = {
      {
        sessionId = 'previous-session',
        summary = 'Continue plugin work',
        modifiedTime = '2026-08-25T19:00:00.000Z',
        modifiedAgoSeconds = 7200,
        inUse = false,
      },
      {
        sessionId = 'active-session',
        summary = 'Used in another terminal',
        modifiedTime = '2026-08-25T20:00:00.000Z',
        modifiedAgoSeconds = 180,
        inUse = true,
      },
    },
  },
})
vim.ui.select = original_select
protocol.send = original_send
assert(native_picker.opts.prompt == 'Resume Copilot session')
assert(resumed_session == 'previous-session', 'session picker did not resume the selected session')
assert(native_picker.items[1].display:find('2 hours ago', 1, true))
assert(native_picker.items[2].display:find('[active elsewhere]', 1, true))
assert(native_picker.items[2].display:find('3 minutes ago', 1, true))
local permission_response
local original_send = protocol.send
vim.ui.select = function(items, opts, on_choice)
  native_picker = { items = items, opts = opts, on_choice = on_choice }
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
local permission_row = assert(line_with(coordinator_buf, '[permission] shell'))
assert(
  vim.api.nvim_buf_get_lines(coordinator_buf, permission_row - 1, permission_row, false)[1]
    :find('   > 🟡 [permission] shell — approval required: npm test', 1, true) == 1
)
assert(not buffer_text(coordinator_buf):find('**Permission**', 1, true))
native_picker.on_choice(native_picker.items[1])
vim.ui.select = original_select
protocol.send = original_send
assert(native_picker.opts.prompt:find('managed approval required', 1, true))
assert(permission_response.requestId == 'managed-permission')
assert(permission_response.approved == true)
assert(line_with(coordinator_buf, '[permission] shell') == permission_row)
assert(
  buffer_text(coordinator_buf):find(
    '   > 🟢 [permission] shell — approved once: npm test',
    1,
    true
  )
)
permission_response = nil
vim.ui.select = function(items, opts, on_choice)
  native_picker = { items = items, opts = opts }
  on_choice(nil)
end
protocol.send = function(message_type, payload)
  if message_type == 'permission.respond' then permission_response = payload end
  return 'permission-response'
end
fleet._on_event({
  v = 1,
  id = 'permission-denied',
  type = 'permission.requested',
  memberId = 'coordinator',
  target = 'status',
  done = false,
  payload = {
    requestId = 'denied-permission',
    request = {
      kind = 'shell',
      fullCommandText = 'Remove-Item output.tmp',
    },
  },
})
vim.ui.select = original_select
protocol.send = original_send
assert(permission_response.requestId == 'denied-permission')
assert(permission_response.approved == false)
assert(
  buffer_text(coordinator_buf):find(
    '   > 🚫 [permission] shell — denied: Remove-Item output.tmp',
    1,
    true
  )
)
assert(not buffer_text(coordinator_buf):find('**Permission**', 1, true))
local denied_permission_row = assert(line_with(coordinator_buf, 'denied: Remove-Item output.tmp'))
assert(
  denied_permission_row - permission_row <= 2,
  'permission rows were separated by more than one empty row'
)
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
assert(#wins == 5, ('expected four agent windows and one prompt, got %d'):format(#wins))
local visible = {}
for _, win in ipairs(wins) do
  visible[vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(win))] = true
end
assert(visible['native-copilot://standard/conversation'], 'Standard supervisor missing from overview')
assert(visible['native-copilot://coordinator/conversation'])
assert(visible['native-copilot://planner/conversation'])
assert(visible['native-copilot://implementer/conversation'])
local prompt_visible = false
for name in pairs(visible) do
  if vim.fn.fnamemodify(name, ':t') == 'AI Prompt' then prompt_visible = true end
end
assert(prompt_visible, 'missing prompt buffer; visible=' .. vim.inspect(visible))
assert(not visible['native-copilot://reviewer/conversation'])
assert(not visible['native-copilot://observer/conversation'])

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
assert(buffers.get_member('observer').unread == 1)
local observer_buf = buffers.buffer('observer', 'conversation')
local text = table.concat(vim.api.nvim_buf_get_lines(observer_buf, 0, -1, false), '\n')
assert(text:find('Hidden retained line 40.', 1, true))

fleet.show_member('observer')
assert(buffers.get_member('observer').unread == 0)
assert(vim.api.nvim_get_current_buf() == observer_buf)
assert(#vim.api.nvim_tabpage_list_wins(0) == 2, 'member view should contain conversation and prompt')
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
local namespace = vim.api.nvim_get_namespaces().native_copilot_inline_activity
local activity_marks = vim.api.nvim_buf_get_extmarks(observer_buf, namespace, 0, -1, {
  details = true,
})
assert(#activity_marks > 0, 'inline activity has no muted highlight')
assert(activity_marks[#activity_marks][4].hl_group == 'Comment')

fleet._on_event({
  v = 1,
  id = 'tool-start',
  type = 'activity.event',
  memberId = 'observer',
  target = 'activity',
  done = false,
  payload = {
    eventType = 'tool.execution_start',
    data = {
      toolCallId = 'tool-call-1',
      toolName = 'view',
      arguments = { path = 'nested/CLAUDE.md' },
    },
  },
})
conversation_text = buffer_text(observer_buf)
assert(conversation_text:find('🟡 [tool][tool-call-1] view — nested/CLAUDE.md', 1, true))
local tool_row = assert(line_with(observer_buf, '[tool][tool-call-1] view'))
fleet._on_event({
  v = 1,
  id = 'tool-complete',
  type = 'activity.event',
  memberId = 'observer',
  target = 'activity',
  done = true,
  payload = {
    eventType = 'tool.execution_complete',
    data = {
      toolCallId = 'tool-call-1',
      success = true,
      result = { content = 'tool output must stay hidden' },
    },
  },
})
vim.api.nvim_set_current_win(vim.fn.win_findbuf(observer_buf)[1])
vim.api.nvim_win_set_cursor(0, { assert(line_with(observer_buf, '[tool][tool-call-1] view')), 0 })
local observer_enter = vim.api.nvim_buf_call(observer_buf, function()
  return vim.fn.maparg('<CR>', 'n', false, true)
end)
observer_enter.callback()
local tool_detail_buf = vim.api.nvim_get_current_buf()
local tool_detail_text = buffer_text(tool_detail_buf)
assert(vim.api.nvim_win_get_config(0).relative == 'editor')
assert(tool_detail_text:find('Arguments:', 1, true))
assert(tool_detail_text:find('nested/CLAUDE.md', 1, true))
assert(tool_detail_text:find('Result:', 1, true))
assert(tool_detail_text:find('tool output must stay hidden', 1, true))
vim.api.nvim_buf_call(tool_detail_buf, function()
  vim.fn.maparg('q', 'n', false, true).callback()
end)
fleet._on_event({
  v = 1,
  id = 'async-tool-start',
  type = 'activity.event',
  memberId = 'observer',
  target = 'activity',
  done = false,
  payload = {
    eventType = 'tool.execution_start',
    data = {
      toolCallId = 'async-tool',
      toolName = 'powershell',
      arguments = {
        command = 'Start-Sleep -Seconds 90',
        description = 'Sleep for 90 seconds',
        mode = 'async',
        detach = true,
      },
    },
  },
})
local async_tool_start_row = assert(line_with(observer_buf, '[task] starting'))
assert(
  buffer_text(observer_buf):find(
    '   🟡 [task] starting · [shell] Sleep for 90 seconds',
    1,
    true
  ),
  'async shell launch was not rendered as a starting task'
)
for index = 1, 21 do
  local call_id = ('intervening-tool-%d'):format(index)
  fleet._on_event({
    v = 1,
    id = call_id .. '-start',
    type = 'activity.event',
    memberId = 'observer',
    target = 'activity',
    done = false,
    payload = {
      eventType = 'tool.execution_start',
      data = {
        toolCallId = call_id,
        toolName = 'rg',
        arguments = { pattern = 'actor-message' },
      },
    },
  })
  fleet._on_event({
    v = 1,
    id = call_id .. '-complete',
    type = 'activity.event',
    memberId = 'observer',
    target = 'activity',
    done = true,
    payload = {
      eventType = 'tool.execution_complete',
      data = {
        toolCallId = call_id,
        success = true,
        result = { content = 'match' },
      },
    },
  })
end
fleet._on_event({
  v = 1,
  id = 'async-tool-complete',
  type = 'activity.event',
  memberId = 'observer',
  target = 'activity',
  done = true,
  payload = {
    eventType = 'tool.execution_complete',
    data = {
      toolCallId = 'async-tool',
      success = true,
      result = { content = 'background command completed' },
    },
  },
})
assert(
  line_with(observer_buf, '[task] starting') == async_tool_start_row,
  'successful async shell launch created a separate completion row'
)
assert(
  not buffer_text(observer_buf):find('🛠️ Tool · ', 1, true),
  'successful async shell launch rendered a redundant tool participant'
)
fleet._on_event({
  v = 1,
  id = 'async-shell-task-running',
  type = 'tasks.changed',
  memberId = 'observer',
  target = 'status',
  done = true,
  payload = {
    tasks = {
      {
        id = 'async-shell',
        type = 'shell',
        status = 'running',
        description = 'Sleep for 90 seconds',
        command = 'Start-Sleep -Seconds 90',
      },
    },
  },
})
local async_task_started_row = assert(line_with(observer_buf, '[task][async-shell] started'))
assert(async_task_started_row == async_tool_start_row, 'task start did not update the launch row')
assert(
  buffer_text(observer_buf):find(
    '   🟢 [task][async-shell] started · [shell] Sleep for 90 seconds',
    1,
    true
  ),
  'registered async task did not use a green started event'
)
assert(
  line_count_with(observer_buf, '[task][async-shell]') == 1,
  'async task registration duplicated its starting row'
)
vim.api.nvim_set_current_win(vim.fn.win_findbuf(observer_buf)[1])
vim.api.nvim_win_set_cursor(0, { async_task_started_row, 0 })
observer_enter.callback()
local async_tool_detail_buf = vim.api.nvim_get_current_buf()
local async_tool_detail_text = buffer_text(async_tool_detail_buf)
assert(async_tool_detail_text:find('Status: running', 1, true))
assert(async_tool_detail_text:find('Sleep for 90 seconds', 1, true))
vim.api.nvim_buf_call(async_tool_detail_buf, function()
  vim.fn.maparg('q', 'n', false, true).callback()
end)
fleet._on_event({
  v = 1,
  id = 'async-shell-task-completed',
  type = 'tasks.changed',
  memberId = 'observer',
  target = 'status',
  done = true,
  payload = {
    tasks = {
      {
        id = 'async-shell',
        type = 'shell',
        status = 'completed',
        description = 'Sleep for 90 seconds',
        command = 'Start-Sleep -Seconds 90',
        result = 'background command completed',
      },
    },
  },
})
local async_task_complete_row = assert(line_with(observer_buf, '[task][async-shell] completed'))
assert(async_task_complete_row > async_task_started_row, 'task completion was not chronological')
assert(line_count_with(observer_buf, '[task][async-shell]') == 2)
assert(
  buffer_text(observer_buf):match(
    '🧑‍💻 · %d%d:%d%d:%d%d\n\n'
      .. '   🟢 %[task%]%[async%-shell%] completed · %[shell%] Sleep for 90 seconds'
  ),
  'async task completion did not render as a participant message'
)
fleet._on_event({
  v = 1,
  id = 'short-async-start',
  type = 'activity.event',
  memberId = 'observer',
  target = 'activity',
  done = false,
  payload = {
    eventType = 'tool.execution_start',
    data = {
      toolCallId = 'short-async',
      toolName = 'powershell',
      arguments = {
        command = 'Write-Output done',
        description = 'Run a short command',
        mode = 'async',
        detach = true,
      },
    },
  },
})
local short_start_row = assert(line_with(observer_buf, '[task] starting · [shell] Run a short command'))
fleet._on_event({
  v = 1,
  id = 'short-async-complete',
  type = 'activity.event',
  memberId = 'observer',
  target = 'activity',
  done = true,
  payload = {
    eventType = 'tool.execution_complete',
    data = {
      toolCallId = 'short-async',
      success = true,
      result = { shellId = 'short-shell' },
    },
  },
})
fleet._on_event({
  v = 1,
  id = 'short-task-terminal',
  type = 'tasks.changed',
  memberId = 'observer',
  target = 'status',
  done = true,
  payload = {
    tasks = {
      {
        id = 'short-shell',
        type = 'shell',
        status = 'completed',
        description = 'Run a short command',
        command = 'Write-Output done',
        result = 'done',
      },
    },
  },
})
assert(
  line_with(observer_buf, '[task][short-shell] started') == short_start_row,
  'terminal-first task snapshot did not replace its starting row'
)
assert(line_with(observer_buf, '[task][short-shell] completed') > short_start_row)
assert(not buffer_text(observer_buf):find('[task] starting · [shell] Run a short command', 1, true))
for _, launch in ipairs({
  { call = 'overlap-a', task = 'overlap-task-a', description = 'First identical command' },
  { call = 'overlap-b', task = 'overlap-task-b', description = 'Second identical command' },
}) do
  fleet._on_event({
    v = 1,
    id = launch.call .. '-start',
    type = 'activity.event',
    memberId = 'observer',
    target = 'activity',
    done = false,
    payload = {
      eventType = 'tool.execution_start',
      data = {
        toolCallId = launch.call,
        toolName = 'powershell',
        arguments = {
          command = 'Start-Sleep -Seconds 5',
          description = launch.description,
          mode = 'async',
          detach = true,
        },
      },
    },
  })
end
local overlap_a_row = assert(line_with(observer_buf, '[shell] First identical command'))
local overlap_b_row = assert(line_with(observer_buf, '[shell] Second identical command'))
fleet._on_event({
  v = 1,
  id = 'overlap-a-complete',
  type = 'activity.event',
  memberId = 'observer',
  target = 'activity',
  done = true,
  payload = {
    eventType = 'tool.execution_complete',
    data = {
      toolCallId = 'overlap-a',
      success = true,
      result = { shellId = 'overlap-task-a' },
    },
  },
})
fleet._on_event({
  v = 1,
  id = 'overlap-task-b-running',
  type = 'tasks.changed',
  memberId = 'observer',
  target = 'status',
  done = true,
  payload = {
    tasks = {
      {
        id = 'overlap-task-b',
        type = 'shell',
        status = 'running',
        description = 'Second identical command',
        command = 'Start-Sleep -Seconds 5',
      },
    },
  },
})
fleet._on_event({
  v = 1,
  id = 'overlap-b-complete',
  type = 'activity.event',
  memberId = 'observer',
  target = 'activity',
  done = true,
  payload = {
    eventType = 'tool.execution_complete',
    data = {
      toolCallId = 'overlap-b',
      success = true,
      result = { shellId = 'overlap-task-b' },
    },
  },
})
fleet._on_event({
  v = 1,
  id = 'overlap-task-a-running',
  type = 'tasks.changed',
  memberId = 'observer',
  target = 'status',
  done = true,
  payload = {
    tasks = {
      {
        id = 'overlap-task-a',
        type = 'shell',
        status = 'running',
        description = 'First identical command',
        command = 'Start-Sleep -Seconds 5',
      },
    },
  },
})
assert(
  line_with(observer_buf, '[task][overlap-task-a] started') == overlap_a_row,
  'first identical command was correlated to the wrong launch row'
)
assert(
  line_with(observer_buf, '[task][overlap-task-b] started') == overlap_b_row,
  'second identical command was correlated to the wrong launch row'
)
fleet._on_event({
  v = 1,
  id = 'shell-task-running',
  type = 'tasks.changed',
  memberId = 'observer',
  target = 'status',
  done = true,
  payload = {
    tasks = {
      {
        id = 'shell-42',
        type = 'shell',
        status = 'running',
        description = 'Parse PR JSON details using python',
      },
    },
  },
})
fleet._on_event({
  v = 1,
  id = 'tool-failed-start',
  type = 'activity.event',
  memberId = 'observer',
  target = 'activity',
  done = false,
  payload = {
    eventType = 'tool.execution_start',
    data = {
      toolCallId = 'tool-call-2',
      toolName = 'powershell',
      arguments = { shellId = 'shell-42' },
    },
  },
})
fleet._on_event({
  v = 1,
  id = 'tool-failed-complete',
  type = 'activity.event',
  memberId = 'observer',
  target = 'activity',
  done = true,
  payload = {
    eventType = 'tool.execution_complete',
    data = {
      toolCallId = 'tool-call-2',
      success = false,
      result = vim.NIL,
      error = { message = 'Command exited with code 1' },
    },
  },
})
assert(
  buffer_text(observer_buf):find('🔴 [tool][tool-call-2] powershell — failed', 1, true),
  'failed tool kept its running indicator'
)
assert(
  buffer_text(observer_buf):find(
    '   🔴 [task][shell-42] failed · [shell] Parse PR JSON details using python',
    1,
    true
  ),
  'task linked to a failed tool did not emit a terminal event'
)
assert(
  line_count_with(observer_buf, '[shell] Parse PR JSON details using python') == 2,
  'linked shell task did not retain separate start and failure events'
)
fleet._on_event({
  v = 1,
  id = 'shell-task-still-running',
  type = 'tasks.changed',
  memberId = 'observer',
  payload = {
    tasks = {
      {
        id = 'shell-43',
        type = 'shell',
        status = 'running',
        description = 'Monitor the asynchronous command',
      },
    },
  },
})
fleet._on_event({
  v = 1,
  id = 'read-shell-success',
  type = 'activity.event',
  memberId = 'observer',
  payload = {
    eventType = 'tool.execution_start',
    data = {
      toolCallId = 'read-shell-tool',
      toolName = 'read_powershell',
      arguments = { shellId = 'shell-43' },
    },
  },
})
fleet._on_event({
  v = 1,
  id = 'read-shell-success-complete',
  type = 'activity.event',
  memberId = 'observer',
  payload = {
    eventType = 'tool.execution_complete',
    data = {
      toolCallId = 'read-shell-tool',
      success = true,
      result = { status = 'running' },
    },
  },
})
assert(
  line_count_with(observer_buf, '[shell] Monitor the asynchronous command') == 1,
  'successful helper tool falsely emitted task completion'
)
vim.api.nvim_set_current_win(vim.fn.win_findbuf(observer_buf)[1])
local failed_tool_row = assert(line_with(observer_buf, '[tool][tool-call-2] powershell'))
vim.api.nvim_win_set_cursor(0, { failed_tool_row, 0 })
vim.api.nvim_buf_clear_namespace(
  observer_buf,
  vim.api.nvim_get_namespaces().native_copilot_timeline,
  failed_tool_row - 1,
  failed_tool_row
)
local failed_tool_item = buffers.timeline_item_at_cursor(observer_buf, failed_tool_row)
assert(
  failed_tool_item and failed_tool_item.status == 'failed',
  ('failed tool details were not retained at row %d'):format(failed_tool_row)
)
local failed_tool_enter = vim.api.nvim_buf_call(observer_buf, function()
  return vim.fn.maparg('<CR>', 'n', false, true)
end)
failed_tool_enter.callback()
tool_detail_buf = vim.api.nvim_get_current_buf()
tool_detail_text = buffer_text(tool_detail_buf)
assert(
  tool_detail_text:find('Status: failed', 1, true),
  'failed tool detail pane:\n' .. tool_detail_text
)
assert(tool_detail_text:find('Command exited with code 1', 1, true))
assert(not tool_detail_text:find('vim.NIL', 1, true))
vim.api.nvim_buf_call(tool_detail_buf, function()
  vim.fn.maparg('q', 'n', false, true).callback()
end)
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
assert(not conversation_text:find('tool output must stay hidden', 1, true))
assert(not conversation_text:find('secret', 1, true))
assert(
  conversation_text:find('🟢 [tool][tool-call-1] view — nested/CLAUDE.md', 1, true),
  'tool status did not update in place'
)
assert(
  line_with(observer_buf, '[tool][tool-call-1] view') == tool_row,
  'tool completion moved instead of updating its chronological row'
)
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
    content = 'Late reasoning remains after the assistant response.',
  },
})
conversation_text = table.concat(vim.api.nvim_buf_get_lines(observer_buf, 0, -1, false), '\n')
local late_reasoning_position = conversation_text:find(
  'Late reasoning remains after the assistant response.',
  1,
  true
)
local response_position = conversation_text:find(
  'Assistant output remains normally highlighted.',
  1,
  true
)
assert(
  late_reasoning_position and response_position and late_reasoning_position > response_position,
  'late reasoning was moved ahead of an earlier assistant response'
)
activity_marks = vim.api.nvim_buf_get_extmarks(observer_buf, namespace, 0, -1, {
  details = true,
})
for _, mark in ipairs(activity_marks) do
  local highlighted = table.concat(
    vim.api.nvim_buf_get_lines(observer_buf, mark[2], mark[4].end_row, false),
    '\n'
  )
  assert(
    not highlighted:find('Assistant output remains normally highlighted.', 1, true),
    'activity highlight leaked into assistant output'
  )
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
assert(conversation_text:find('🤖 ·', 1, true))
assert(conversation_text:find('Dynamically discovered command output.', 1, true))

fleet.close()
fleet.show_member('observer')
assert(#vim.api.nvim_tabpage_list_wins(0) == 2, 'UI reopen did not restore conversation and prompt')
assert(
  vim.api.nvim_win_get_cursor(0)[1] == vim.api.nvim_buf_line_count(observer_buf),
  'reopened conversation did not follow its last line'
)
assert(vim.fn.line('w$') == vim.api.nvim_buf_line_count(observer_buf), 'reopened bottom is hidden')

-- Multiple Fleets run concurrently. The same raw member id in two Fleets must
-- not collide, and the Standard supervisor stays active throughout.
local function start_fleet(fleet_id, name, members)
  fleet._on_event({
    v = 1,
    type = 'fleet.loading',
    payload = {
      fleetId = fleet_id,
      name = name,
      entryMember = members[1].id,
      recovered = false,
      connectingMembers = { members[1].id },
      members = members,
    },
  })
  fleet._on_event({
    v = 1,
    type = 'fleet.ready',
    payload = { fleetId = fleet_id, name = name, entryMember = members[1].id, members = members },
  })
end

start_fleet('fleet_a', 'Fleet A', { { id = 'fleet_a/planner', displayName = 'Planner' } })
start_fleet('fleet_b', 'Fleet B', { { id = 'fleet_b/planner', displayName = 'Planner' } })

local multi_buffers = require('native_copilot.buffers')
assert(multi_buffers.get_member('fleet_a/planner'), 'Fleet A planner missing')
assert(multi_buffers.get_member('fleet_b/planner'), 'Fleet B planner missing')
assert(
  multi_buffers.buffer('fleet_a/planner', 'conversation')
    ~= multi_buffers.buffer('fleet_b/planner', 'conversation'),
  'two Fleets sharing a raw member id collided on one buffer'
)
assert(multi_buffers.get_member('standard'), 'Standard supervisor was dropped while Fleets ran')

fleet._on_event({
  v = 1,
  id = 'a-planner-message',
  type = 'conversation.message',
  memberId = 'fleet_a/planner',
  target = 'conversation',
  done = true,
  payload = { messageId = 'a-planner-message', content = 'Only for Fleet A planner.' },
})
local a_text = table.concat(
  vim.api.nvim_buf_get_lines(multi_buffers.buffer('fleet_a/planner', 'conversation'), 0, -1, false),
  '\n'
)
local b_text = table.concat(
  vim.api.nvim_buf_get_lines(multi_buffers.buffer('fleet_b/planner', 'conversation'), 0, -1, false),
  '\n'
)
assert(a_text:find('Only for Fleet A planner.', 1, true), 'Fleet A planner missed its own message')
assert(
  not b_text:find('Only for Fleet A planner.', 1, true),
  'a message leaked across Fleets that share a raw member id'
)

-- Adding and removing members in one active Fleet is incremental.
fleet._on_event({
  v = 1,
  type = 'fleet.updated',
  payload = {
    fleetId = 'fleet_b',
    entryMember = 'fleet_b/planner',
    added = { { id = 'fleet_b/reviewer', displayName = 'Reviewer' } },
    updated = {},
    removed = {},
    members = { { id = 'fleet_b/planner' }, { id = 'fleet_b/reviewer' } },
  },
})
assert(multi_buffers.get_member('fleet_b/reviewer'), 'fleet.updated did not add the new member')
fleet._on_event({
  v = 1,
  type = 'fleet.updated',
  payload = {
    fleetId = 'fleet_b',
    entryMember = 'fleet_b/planner',
    added = {},
    updated = {},
    removed = { 'fleet_b/reviewer' },
    members = { { id = 'fleet_b/planner' } },
  },
})
assert(not multi_buffers.get_member('fleet_b/reviewer'), 'fleet.updated did not remove the member')
assert(
  multi_buffers.get_member('fleet_b/planner'),
  'fleet.updated wrongly removed a retained member'
)

-- Stopping one Fleet leaves Standard and the other Fleet untouched.
fleet._on_event({
  v = 1,
  type = 'fleet.stopped',
  payload = { fleetId = 'fleet_a', members = { 'fleet_a/planner' } },
})
assert(not multi_buffers.get_member('fleet_a/planner'), 'stopping Fleet A did not remove its members')
assert(multi_buffers.get_member('fleet_b/planner'), 'stopping Fleet A wrongly removed Fleet B')
assert(multi_buffers.get_member('standard'), 'stopping a Fleet dropped the Standard supervisor')

-- Instruction discovery remains an aggregate count. Individual nested reads
-- appear through normal tool rows instead.
fleet._on_event({
  v = 1,
  type = 'environment.loaded',
  memberId = 'standard',
  payload = {
    component = 'Instructions',
    items = {
      {
        label = 'Repository guidelines',
        sourcePath = '.github/copilot-instructions.md',
        type = 'repository',
      },
      { label = 'Personal notes', sourcePath = 'AGENTS.md' },
    },
  },
})
local standard_text = table.concat(
  vim.api.nvim_buf_get_lines(multi_buffers.buffer('standard', 'conversation'), 0, -1, false),
  '\n'
)
assert(
  standard_text:find('[environment] Instructions', 1, true),
  'aggregate instruction row was not rendered'
)
assert(
  standard_text:find('2 loaded', 1, true),
  'aggregate instruction count was not rendered'
)
assert(
  not standard_text:find('.github/copilot-instructions.md', 1, true),
  'instruction source path leaked into the aggregate timeline'
)

-- Moving an agent between two active Fleets follows the moved member without
-- collision and leaves every other member in place.
start_fleet('fleet_c', 'Fleet C', {
  { id = 'fleet_c/planner', displayName = 'Planner' },
  { id = 'fleet_c/mover', displayName = 'Mover' },
})
start_fleet('fleet_d', 'Fleet D', { { id = 'fleet_d/planner', displayName = 'Planner' } })
assert(multi_buffers.get_member('fleet_c/mover'), 'move setup: source mover missing')

-- The moved agent carries its own conversation history before the move.
fleet._on_event({
  v = 1,
  id = 'mover-history',
  type = 'conversation.message',
  memberId = 'fleet_c/mover',
  target = 'conversation',
  done = true,
  payload = { messageId = 'mover-history', content = 'Mover history line.' },
})

-- Source Fleet loses the moved agent incrementally (never a full reset).
fleet._on_event({
  v = 1,
  type = 'fleet.updated',
  payload = {
    fleetId = 'fleet_c',
    entryMember = 'fleet_c/planner',
    added = {},
    updated = {},
    removed = { 'fleet_c/mover' },
    members = { { id = 'fleet_c/planner' } },
  },
})
-- Destination Fleet gains it under its own qualified target.
fleet._on_event({
  v = 1,
  type = 'fleet.updated',
  payload = {
    fleetId = 'fleet_d',
    entryMember = 'fleet_d/planner',
    added = { { id = 'fleet_d/mover', displayName = 'Mover' } },
    updated = {},
    removed = {},
    members = { { id = 'fleet_d/planner' }, { id = 'fleet_d/mover' } },
  },
})
fleet._on_event({
  v = 1,
  type = 'fleet.agent.moved',
  payload = {
    sourceFleetId = 'fleet_c',
    destinationFleetId = 'fleet_d',
    agentId = 'mover',
  },
})

assert(not multi_buffers.get_member('fleet_c/mover'), 'move did not remove the agent from the source Fleet')
assert(multi_buffers.get_member('fleet_d/mover'), 'move did not add the agent to the destination Fleet')
assert(multi_buffers.get_member('fleet_c/planner'), 'move disturbed a retained source member')
assert(multi_buffers.get_member('fleet_d/planner'), 'move disturbed a retained destination member')
assert(
  multi_buffers.buffer('fleet_c/planner', 'conversation')
    ~= multi_buffers.buffer('fleet_d/mover', 'conversation'),
  'moved agent collided with a source member buffer'
)
assert(multi_buffers.get_member('standard'), 'move dropped the Standard supervisor')

-- Host-restart reconciliation: a `hello` treats status.fleets as authoritative,
-- dropping local Fleets and members the host no longer reports while preserving
-- the reported ones and the Standard supervisor.
start_fleet('fleet_e', 'Fleet E', {
  { id = 'fleet_e/planner', displayName = 'Planner' },
  { id = 'fleet_e/worker', displayName = 'Worker' },
})
start_fleet('fleet_f', 'Fleet F', { { id = 'fleet_f/planner', displayName = 'Planner' } })
assert(multi_buffers.get_member('fleet_e/worker'), 'reconcile setup: fleet_e worker missing')
assert(multi_buffers.get_member('fleet_f/planner'), 'reconcile setup: fleet_f planner missing')

fleet._on_event({
  v = 1,
  type = 'hello',
  payload = {
    recoverableFleets = {},
    standard = { displayName = 'Copilot' },
    status = {
      standard = { state = 'idle' },
      fleets = {
        {
          fleetId = 'fleet_e',
          name = 'Fleet E',
          entryMember = 'fleet_e/planner',
          -- fleet_e/worker is intentionally absent: the host no longer reports it.
          members = { { id = 'fleet_e/planner', displayName = 'Planner' } },
        },
        -- fleet_f is intentionally absent entirely: the host no longer runs it.
      },
      members = { { id = 'fleet_e/planner', state = 'idle' } },
    },
  },
})

assert(multi_buffers.get_member('standard'), 'reconcile dropped the Standard supervisor')
assert(multi_buffers.get_member('fleet_e/planner'), 'reconcile dropped a still-reported member')
assert(
  not multi_buffers.get_member('fleet_e/worker'),
  'reconcile kept a member the host no longer reports'
)
assert(
  not multi_buffers.get_member('fleet_f/planner'),
  'reconcile kept a Fleet the host no longer reports'
)

vim.cmd('tabonly')
local close_ok, close_error = pcall(fleet.close)
assert(close_ok, 'closing Native Copilot as the last tab failed: ' .. tostring(close_error))
assert(#vim.api.nvim_list_tabpages() == 1, 'closing the last Native Copilot tab left extra tabs')
print('nvim UI smoke passed')
