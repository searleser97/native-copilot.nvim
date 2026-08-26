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
  type = 'mode.changed',
  payload = {
    mode = 'standard',
    displayName = 'Copilot',
  },
})
assert(
  vim.b[vim.api.nvim_get_current_buf()].native_copilot_prompt == true,
  'mode initialization did not return focus to the input buffer'
)
fleet._on_event({
  v = 1,
  type = 'fleet.loading',
  payload = {
    mode = 'fleet-loading',
    fleetId = 'ui-smoke',
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
local loading_entry = require('native_copilot.buffers').get_member('coordinator')
assert(loading_entry.state == 'loading', 'Fleet member did not enter loading state')
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
  vim.b[vim.api.nvim_get_current_buf()].native_copilot_prompt == true,
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
local coordinator_buf = require('native_copilot.buffers').buffer('coordinator', 'conversation')
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
local timeline_text = buffer_text(coordinator_buf)
assert(timeline_text:find('○ **[task] [agent] Review implementation**', 1, true))
assert(timeline_text:find('✓ **[task] [shell] npm test**', 1, true))
assert(timeline_text:find('✗ **[task] [agent] Validate deployment**', 1, true))
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
  line_with(coordinator_buf, '[agent] Review implementation') == running_task_row,
  'failed task moved instead of updating its existing row'
)
assert(
  buffer_text(coordinator_buf):find('✗ **[task] [agent] Review implementation**', 1, true),
  'failed task kept its running indicator'
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
    '○ **[environment] Copilot environment** — Starting runtime and discovering configuration',
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
  environment_text:find('✓ **[environment] MCP github** — connected', 1, true)
)
assert(
  environment_text:find('✗ **[environment] MCP local** — failed', 1, true)
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
    '✓ **[environment] Copilot environment** — ready',
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
  { '> ○ **[environment] MCP github** — orphaned pending' }
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
assert(buffer_text(coordinator_buf):find('○ **[environment] MCP github** — pending', 1, true))
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
assert(buffer_text(coordinator_buf):find('✓ **[environment] MCP github** — connected', 1, true))
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
  environment_text:find('✗ **[environment] Skills** — Invalid skill metadata', 1, true),
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
assert(buffer_text(coordinator_buf):match('👨 You · %d%d:%d%d:%d%d\n\n/context'))
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
  '🤖 Copilot · %d%d:%d%d:%d%d\n\nContext usage output'
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
  type = 'member.state',
  memberId = 'coordinator',
  payload = { state = 'idle' },
})
assert(#prompt_sends == 1)
assert(prompt_sends[1].type == 'prompt.send')
assert(prompt_sends[1].payload.content == 'Implement the edited first feature')
assert(#vim.fn.win_findbuf(prompt_queue_buf) == 0, 'empty prompt queue pane remained open')
assert(buffer_text(coordinator_buf):match(
  '👨 You · %d%d:%d%d:%d%d\n\nImplement the edited first feature'
))
assert(buffer_text(coordinator_buf):match(
  '🤖 Copilot · %d%d:%d%d:%d%d · ○ processing…'
))
assert(not buffer_text(coordinator_buf):find('[prompt] Prompt', 1, true))
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
local schedule_row = assert(line_with(coordinator_buf, '[schedule] Schedule #7'))
assert(buffer_text(coordinator_buf):find('○ **[schedule] Schedule #7** — every 300s', 1, true))
fleet._on_event({
  v = 1,
  type = 'schedule.rearmed',
  memberId = 'coordinator',
  payload = { id = 7, nextRunAt = 1787701200000 },
})
assert(buffer_text(coordinator_buf):find('○ **[schedule] Schedule #7** — rearmed', 1, true))
assert(line_with(coordinator_buf, '[schedule] Schedule #7') == schedule_row)
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
    source = 'scheduled-prompt',
    delivery = 'queued',
  },
})
assert(buffer_text(coordinator_buf):match(
  '👨 You · %d%d:%d%d:%d%d\n\nCheck deployment health'
))
assert(not buffer_text(coordinator_buf):find('[prompt] Prompt', 1, true))
fleet._on_event({
  v = 1,
  type = 'schedule.cancelled',
  memberId = 'coordinator',
  payload = { id = 7 },
})
assert(buffer_text(coordinator_buf):find('– **[schedule] Schedule #7** — cancelled', 1, true))
assert(line_with(coordinator_buf, '[schedule] Schedule #7') == schedule_row)
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
assert(#wins == 5, ('expected four agent windows and one prompt, got %d'):format(#wins))
local visible = {}
for _, win in ipairs(wins) do
  visible[vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(win))] = true
end
assert(visible['native-copilot://coordinator/conversation'])
assert(visible['native-copilot://planner/conversation'])
assert(visible['native-copilot://implementer/conversation'])
assert(visible['native-copilot://reviewer/conversation'])
local prompt_visible = false
for name in pairs(visible) do
  if vim.fn.fnamemodify(name, ':t') == 'AI Prompt' then prompt_visible = true end
end
assert(prompt_visible, 'missing prompt buffer; visible=' .. vim.inspect(visible))
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
local buffers = require('native_copilot.buffers')
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
    data = { toolCallId = 'tool-call-1', toolName = 'view', arguments = { path = 'secret' } },
  },
})
conversation_text = buffer_text(observer_buf)
assert(conversation_text:find('○ **[tool] view** — processing…', 1, true))
assert(not conversation_text:find('secret', 1, true))
local tool_row = assert(line_with(observer_buf, '[tool] view'))
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
vim.api.nvim_win_set_cursor(0, { assert(line_with(observer_buf, '[tool] view')), 0 })
local observer_enter = vim.api.nvim_buf_call(observer_buf, function()
  return vim.fn.maparg('<CR>', 'n', false, true)
end)
observer_enter.callback()
local tool_detail_buf = vim.api.nvim_get_current_buf()
local tool_detail_text = buffer_text(tool_detail_buf)
assert(vim.api.nvim_win_get_config(0).relative == 'editor')
assert(tool_detail_text:find('Arguments:', 1, true))
assert(tool_detail_text:find('secret', 1, true))
assert(tool_detail_text:find('Result:', 1, true))
assert(tool_detail_text:find('tool output must stay hidden', 1, true))
vim.api.nvim_buf_call(tool_detail_buf, function()
  vim.fn.maparg('q', 'n', false, true).callback()
end)
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
  buffer_text(observer_buf):find('✗ **[tool] powershell** — failed', 1, true),
  'failed tool kept its running indicator'
)
assert(
  buffer_text(observer_buf):find(
    '✗ **[task] [shell] Parse PR JSON details using python**',
    1,
    true
  ),
  'task linked to a failed tool kept its running indicator'
)
vim.api.nvim_set_current_win(vim.fn.win_findbuf(observer_buf)[1])
vim.api.nvim_win_set_cursor(0, { assert(line_with(observer_buf, '[tool] powershell')), 0 })
observer_enter.callback()
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
  conversation_text:find('✓ **[tool] view** — completed', 1, true),
  'tool status did not update in place'
)
assert(
  line_with(observer_buf, '[tool] view') == tool_row,
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
assert(conversation_text:find('🤖 Copilot', 1, true))
assert(conversation_text:find('Dynamically discovered command output.', 1, true))

fleet.close()
fleet.show_member('observer')
assert(#vim.api.nvim_tabpage_list_wins(0) == 2, 'UI reopen did not restore conversation and prompt')
assert(
  vim.api.nvim_win_get_cursor(0)[1] == vim.api.nvim_buf_line_count(observer_buf),
  'reopened conversation did not follow its last line'
)
assert(vim.fn.line('w$') == vim.api.nvim_buf_line_count(observer_buf), 'reopened bottom is hidden')
fleet.close()
print('nvim UI smoke passed')
