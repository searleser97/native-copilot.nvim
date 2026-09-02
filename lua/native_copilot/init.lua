local protocol = require('native_copilot.protocol')
local buffers = require('native_copilot.buffers')
local commands = require('native_copilot.commands')

local M = {}
local data_root = vim.fn.stdpath('data')
local default_database = data_root .. '/native-copilot/state.sqlite'

local function client_commands()
  return {
    {
      name = 'fleet',
      description = 'Ask Standard Copilot to design and start a task-specific Fleet',
      kind = 'client',
      input = { hint = 'objective for the dynamic fleet' },
    },
    {
      name = 'tasks',
      description = 'View and cancel background agents and shell commands',
      kind = 'client',
    },
    {
      name = 'resume',
      description = 'Resume a previous Copilot session for this workspace',
      kind = 'client',
      input = { hint = 'session id' },
    },
    {
      name = 'mcp-reload',
      description = 'Reload MCP servers without restarting the Copilot session',
      kind = 'client',
    },
    {
      name = 'mcp',
      description = 'Inspect and manage MCP servers for the current session',
      kind = 'client',
      input = {
        hint = 'list|show|tools|enable|disable|reload [server]',
        choices = {
          { name = 'list', description = 'List MCP servers' },
          { name = 'show', description = 'Show one MCP server' },
          { name = 'tools', description = 'List tools for one MCP server' },
          { name = 'enable', description = 'Enable one MCP server' },
          { name = 'disable', description = 'Disable one MCP server' },
          { name = 'reload', description = 'Reload all MCP servers' },
        },
      },
    },
    {
      name = 'model',
      description = 'Inspect or switch the current session model',
      kind = 'client',
      input = { hint = 'model id' },
    },
  }
end

local defaults = {
  node_command = 'node',
  runtime_command_resolver = vim.env.NVIM_COPILOT_CMD_RESOLVER,
  database_path = default_database,
  workspace = nil,
  prompt_height = 8,
  prompt_queue_height = 5,
  task_detail_height = 12,
  overview_max_agents = 4,
  stream_flush_ms = 80,
  follow_bottom = true,
  bottom_padding = 2,
  timestamp_format = '%H:%M:%S',
  conversation = {
    user_label = '👨',
    copilot_label = '🤖',
    task_label = '📝',
    tool_label = '🛠️ Tool',
    scheduler_label = '⏰ Scheduler',
    day_header_format = '%A, %B %d',
  },
  frontend = {
    completion = 'native',
    picker = 'native',
  },
  mappings = {
    toggle = '<leader>ait',
    fleet = '<leader>aif',
    select = '<leader>ais',
  },
}

local options = vim.deepcopy(defaults)
local state = {
  tab = nil,
  main_win = nil,
  prompt_win = nil,
  prompt_queue_win = nil,
  prompt_queue_buf = nil,
  prompt_buf = nil,
  compact_ui_options = nil,
  task_detail = nil,
  task_progress = nil,
  task_progress_loaded = false,
  task_detail_buf = nil,
  task_detail_win = nil,
  task_detail_member = nil,
  detail_item = nil,
  status_buf = nil,
  selected = 'standard',
  mode = 'stopped',
  active_fleet = nil,
  fleets = {},
  member_meta = {},
  member_order = { 'standard' },
  tasks = {},
  environment = {},
  recoverable_fleets = {},
  overview = false,
  configured_buffers = {},
  command_requests = {},
  command_catalog_loaded = {},
  permission_queue = {},
  permission_prompt_open = false,
  tool_calls = {},
  prompt_calls = {},
  active_prompts = {},
  queued_prompts = {},
  prompt_queue_paused = {},
  prompt_queue_edit = nil,
  prompt_queue_sequence = 0,
  session_metrics = {},
  schedules = {},
  resume_request_id = nil,
  resume_cursor_animation_restore = nil,
}

local function update_conversation_label(member_id)
  local entry = buffers.get_member(member_id)
  if not entry then return end
  local metrics = state.session_metrics[member_id] or {}
  local model = metrics.model_id or 'detecting…'
  local aic = tonumber(metrics.aic_used) or 0
  local label = (' %s  |  Model: %s  |  AIC used: %.3f '):format(
    entry.display_name,
    model,
    aic
  )
  for _, win in ipairs(vim.fn.win_findbuf(entry.views.conversation.buf)) do
    if vim.api.nvim_win_is_valid(win) then vim.wo[win].winbar = label end
  end
end

local function notify(message, level)
  vim.notify(message, level or vim.log.levels.INFO, { title = 'Native Copilot' })
end

local function restore_resume_cursor_animation(delay)
  local restore = state.resume_cursor_animation_restore
  state.resume_cursor_animation_restore = nil
  state.resume_request_id = nil
  if not restore then return end
  if delay then
    vim.defer_fn(restore, delay)
  else
    restore()
  end
end

local function is_ui_open()
  return state.tab and vim.api.nvim_tabpage_is_valid(state.tab)
end

local function restore_compact_ui_options()
  if not state.compact_ui_options then return end
  vim.o.cmdheight = state.compact_ui_options.cmdheight
  vim.o.laststatus = state.compact_ui_options.laststatus
  vim.o.showtabline = state.compact_ui_options.showtabline
  state.compact_ui_options = nil
end

local function current_workspace()
  return options.workspace or vim.uv.cwd()
end

local function send(message_type, payload)
  local id, err = protocol.send(message_type, payload)
  if not id then notify(err, vim.log.levels.ERROR) end
  return id
end

local function prompt_lines()
  if not state.prompt_buf or not vim.api.nvim_buf_is_valid(state.prompt_buf) then return {} end
  return vim.api.nvim_buf_get_lines(state.prompt_buf, 0, -1, false)
end

local function set_prompt_lines(lines)
  if not state.prompt_buf or not vim.api.nvim_buf_is_valid(state.prompt_buf) then return end
  vim.bo[state.prompt_buf].modifiable = true
  vim.api.nvim_buf_set_lines(state.prompt_buf, 0, -1, false, lines)
  vim.bo[state.prompt_buf].modifiable = true
end

local function update_prompt_label()
  if not state.prompt_win or not vim.api.nvim_win_is_valid(state.prompt_win) then return end
  local entry = buffers.get_member(state.selected)
  local target = entry and entry.display_name or state.selected
  if state.prompt_buf and vim.api.nvim_buf_is_valid(state.prompt_buf) then
    vim.b[state.prompt_buf].native_copilot_target = state.selected
  end
  vim.wo[state.prompt_win].winbar =
    (' To: %s  |  <Enter> send  |  / commands  |  <Tab> complete '):format(target)
  if options.frontend.completion == 'blink' and M.ensure_commands then
    if not commands.catalog(state.selected) then
      commands.set_catalog(state.selected, client_commands())
    end
    vim.schedule(function() M.ensure_commands(state.selected) end)
  end
end

local function focus_prompt()
  if state.prompt_win and vim.api.nvim_win_is_valid(state.prompt_win) then
    vim.api.nvim_set_current_win(state.prompt_win)
  end
end

local function complete_slash_input()
  if not state.prompt_buf or not vim.api.nvim_buf_is_valid(state.prompt_buf) then return false end
  local row, column = unpack(vim.api.nvim_win_get_cursor(0))
  local line = vim.api.nvim_buf_get_lines(state.prompt_buf, row - 1, row, false)[1] or ''
  local before = line:sub(1, column)
  local catalog = commands.catalog(state.selected) or {}
  local start_column, matches = commands.complete(before, catalog, function(prefix)
    return vim.fn.getcompletion(prefix, 'dir')
  end)
  if not start_column then return false end
  vim.schedule(function()
    if vim.api.nvim_get_current_buf() == state.prompt_buf then
      vim.fn.complete(start_column, matches)
    end
  end)
  return true
end

local function invoke_command(target, name, input)
  return send('command.invoke', {
    target = target,
    name = name,
    input = input,
  })
end

local refresh_prompt_queue
local dispatch_next_prompt

local function fail_prompt(request_id, detail)
  local call = state.prompt_calls[request_id]
  if not call then return end
  local member_id = call.member_id
  state.prompt_calls[request_id] = nil
  if state.active_prompts[member_id] == request_id then
    state.active_prompts[member_id] = nil
  end
  buffers.fail_response(member_id, detail or 'Prompt submission failed')
  dispatch_next_prompt(member_id)
end

local function schedule_description(schedule)
  if schedule.selfPaced then return 'self-paced' end
  if schedule.intervalMs then
    local seconds = math.floor(schedule.intervalMs / 1000)
    return schedule.recurring == false and ('after %ds'):format(seconds)
      or ('every %ds'):format(seconds)
  end
  if schedule.cron then return 'cron ' .. schedule.cron end
  if schedule.at then return 'at ' .. os.date('%Y-%m-%d %H:%M:%S', math.floor(schedule.at / 1000)) end
  return schedule.recurring == false and 'one shot' or 'scheduled'
end

local function concise_detail(value)
  value = value ~= vim.NIL and value or nil
  if value == nil then return nil end
  if type(value) == 'table' then
    local ok, encoded = pcall(vim.json.encode, value)
    value = ok and encoded or vim.inspect(value)
  end
  local detail = tostring(value):gsub('[\r\n]+', ' ')
  if #detail > 180 then detail = detail:sub(1, 177) .. '...' end
  return detail
end

local function update_schedule(member_id, schedule_id, event, updates, event_id, event_time)
  local key = member_id .. ':' .. tostring(schedule_id)
  local schedule = vim.tbl_deep_extend('force', state.schedules[key] or {}, updates or {})
  state.schedules[key] = schedule
  local status = event == 'cancelled' and 'cancelled'
    or event == 'failed' and 'failed'
    or 'completed'
  buffers.upsert_timeline(
    member_id,
    ('schedule:%s:%s:%s'):format(schedule_id, event, event_id or event),
    {
    kind = 'schedule',
    identifier = schedule_id,
    event = event,
    label = schedule_description(schedule),
    status = status,
    detail = concise_detail(schedule.detail),
    actor_message = event == 'fired' or event == 'failed',
    details = {
      prompt = schedule.displayPrompt or schedule.prompt,
      schedule = schedule_description(schedule),
      nextRunAt = schedule.nextRunAt,
      event = event,
    },
    created_at = event_time,
  })
end

local function dispatch_prompt(member_id, content)
  buffers.append_block(member_id, 'conversation', 'You', content)
  local request_id = send('prompt.send', { target = member_id, content = content })
  if not request_id then return false end
  state.prompt_calls[request_id] = { member_id = member_id }
  state.active_prompts[member_id] = request_id
  buffers.begin_response(member_id, request_id)
  return true
end

local function enqueue_prompt(member_id, content)
  state.prompt_queue_sequence = state.prompt_queue_sequence + 1
  local queue = state.queued_prompts[member_id] or {}
  state.queued_prompts[member_id] = queue
  table.insert(queue, {
    id = state.prompt_queue_sequence,
    content = content,
    updated_at = os.date(options.timestamp_format),
  })
  refresh_prompt_queue()
end

local function can_dispatch_prompt(member_id)
  local entry = buffers.get_member(member_id)
  return entry
    and (entry.state == 'idle' or entry.state == 'standby')
    and not state.active_prompts[member_id]
    and not state.prompt_queue_paused[member_id]
end

dispatch_next_prompt = function(member_id)
  local queue = state.queued_prompts[member_id] or {}
  if #queue == 0 or not can_dispatch_prompt(member_id) then
    refresh_prompt_queue()
    return false
  end
  local item = table.remove(queue, 1)
  refresh_prompt_queue()
  if dispatch_prompt(member_id, item.content) then return true end
  table.insert(queue, 1, item)
  state.prompt_queue_paused[member_id] = true
  refresh_prompt_queue()
  return false
end

local function finish_foreground_turn(member_id)
  buffers.finish_response(member_id)
  local request_id = state.active_prompts[member_id]
  if request_id then state.prompt_calls[request_id] = nil end
  state.active_prompts[member_id] = nil
  buffers.set_state(member_id, 'idle')
  dispatch_next_prompt(member_id)
end

local function submit_prompt_content()
  local content = vim.trim(table.concat(prompt_lines(), '\n'))
  if content == '' then
    notify('The prompt is empty.', vim.log.levels.WARN)
    return false
  end
  if not buffers.get_member(state.selected) then
    notify('Select an agent before sending.', vim.log.levels.WARN)
    return false
  end
  set_prompt_lines({ '' })
  if state.prompt_queue_edit then
    local edit = state.prompt_queue_edit
    local queue = state.queued_prompts[edit.member_id] or {}
    for _, item in ipairs(queue) do
      if item.id == edit.id then
        item.content = content
        item.updated_at = os.date(options.timestamp_format)
        break
      end
    end
    state.prompt_queue_edit = nil
    refresh_prompt_queue()
    return true
  end
  local command = commands.parse(content)
  if command then
    buffers.append_block(state.selected, 'conversation', 'You', content)
    if command.name:lower() == 'tasks' then
      M.select_task()
      return true
    elseif command.name:lower() == 'fleet' then
      if command.input then
        send('prompt.send', {
          target = 'standard',
          content = 'Design and create a task-specific Copilot fleet for this objective: '
            .. command.input,
        })
      else
        M.select_fleet()
      end
      return true
    elseif command.name:lower() == 'resume' then
      if command.input then
        send('session.resume', { sessionId = command.input })
      else
        send('sessions.list')
      end
      return true
    elseif command.name:lower() == 'mcp-reload' then
      send('mcp.reload', { target = state.selected })
      return true
    elseif command.name:lower() == 'model' then
      if command.input then
        send('model.switch', { target = state.selected, modelId = command.input })
      else
        send('model.list', { target = state.selected, purpose = 'select' })
      end
      return true
    elseif command.name:lower() == 'mcp' then
      local action, server_name = (command.input or ''):match('^(%S+)%s*(.*)$')
      action = action and action:lower() or 'select'
      server_name = server_name ~= '' and server_name or nil
      if action == 'reload' then
        send('mcp.reload', { target = state.selected })
      elseif action == 'list' then
        send('mcp.list', { target = state.selected, purpose = 'display' })
      elseif action == 'show' or action == 'tools' or action == 'enable' or action == 'disable' then
        if server_name then
          send('mcp.' .. action, { target = state.selected, serverName = server_name })
        else
          send('mcp.list', {
            target = state.selected,
            purpose = 'action',
            action = action,
          })
        end
      elseif action == 'select' then
        send('mcp.list', { target = state.selected, purpose = 'select' })
      else
        notify(('Unknown /mcp action: %s'):format(action), vim.log.levels.ERROR)
      end
      return true
    end
    invoke_command(state.selected, command.name, command.input)
  else
    if can_dispatch_prompt(state.selected) and #(state.queued_prompts[state.selected] or {}) == 0 then
      dispatch_prompt(state.selected, content)
    else
      enqueue_prompt(state.selected, content)
    end
  end
  return true
end

function M.submit_prompt()
  if
    not state.prompt_buf
    or not vim.api.nvim_buf_is_valid(state.prompt_buf)
    or vim.api.nvim_get_current_buf() ~= state.prompt_buf
  then
    notify(
      'Prompt submission is only available from the Native Copilot prompt buffer.',
      vim.log.levels.WARN
    )
    return false
  end
  return submit_prompt_content()
end

local function ensure_prompt_buffer()
  if state.prompt_buf and vim.api.nvim_buf_is_valid(state.prompt_buf) then
    return state.prompt_buf
  end
  local buf = vim.api.nvim_create_buf(false, true)
  pcall(vim.api.nvim_buf_set_name, buf, 'AI Prompt')
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'hide'
  vim.bo[buf].swapfile = false
  vim.bo[buf].filetype = 'native-copilot'
  vim.b[buf].ai_prompt = true
  vim.b[buf].native_copilot_prompt = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, { '' })
  vim.keymap.set('n', '<CR>', M.submit_prompt, {
    buffer = buf,
    desc = 'Send prompt to selected Copilot',
  })
  vim.keymap.set('i', '<C-s>', M.submit_prompt, {
    buffer = buf,
    desc = 'Send prompt to selected Copilot',
  })
  vim.keymap.set('n', '[a', function() M.cycle_member(-1) end, {
    buffer = buf,
    desc = 'Previous Copilot prompt recipient',
  })
  vim.keymap.set('n', ']a', function() M.cycle_member(1) end, {
    buffer = buf,
    desc = 'Next Copilot prompt recipient',
  })
  vim.keymap.set('i', '<C-p>', function()
    local ok, snippets = pcall(require, 'prompt_snippets')
    if ok then snippets.pick(buf) end
  end, {
    buffer = buf,
    desc = 'Insert AI prompt snippet',
  })
  if options.frontend.completion == 'native' then
    vim.keymap.set('i', '/', function()
      local row, column = unpack(vim.api.nvim_win_get_cursor(0))
      local before = table.concat(vim.api.nvim_buf_get_lines(buf, 0, row - 1, false), '')
        .. (vim.api.nvim_get_current_line():sub(1, column))
      if before == '' then
        vim.schedule(M.select_commands)
        return ''
      end
      return '/'
    end, {
      buffer = buf,
      expr = true,
      desc = 'Browse Copilot slash commands',
    })
    vim.keymap.set('i', '<Tab>', function()
      if vim.fn.pumvisible() == 1 then return '<C-n>' end
      return complete_slash_input() and '' or '\t'
    end, {
      buffer = buf,
      expr = true,
      desc = 'Complete Copilot slash command or argument',
    })
  end
  state.prompt_buf = buf
  return buf
end

local function queue_item_at_cursor()
  local queue = state.queued_prompts[state.selected] or {}
  local index = vim.api.nvim_win_get_cursor(0)[1] - 1
  return queue[index], index
end

local function ensure_prompt_queue_buffer()
  if state.prompt_queue_buf and vim.api.nvim_buf_is_valid(state.prompt_queue_buf) then
    return state.prompt_queue_buf
  end
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(buf, 'native-copilot://prompt-queue')
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'hide'
  vim.bo[buf].swapfile = false
  vim.bo[buf].filetype = 'native-copilot'
  vim.bo[buf].modifiable = false
  vim.b[buf].native_copilot_prompt_queue = true
  vim.keymap.set('n', '<CR>', function()
    local item = queue_item_at_cursor()
    if not item then return end
    state.prompt_queue_paused[state.selected] = true
    state.prompt_queue_edit = { member_id = state.selected, id = item.id }
    set_prompt_lines(vim.split(item.content, '\n', { plain = true }))
    refresh_prompt_queue()
    focus_prompt()
  end, {
    buffer = buf,
    desc = 'Edit queued Copilot prompt',
  })
  vim.keymap.set('n', 'dd', function()
    local _, index = queue_item_at_cursor()
    if index < 1 then return end
    table.remove(state.queued_prompts[state.selected], index)
    state.prompt_queue_edit = nil
    refresh_prompt_queue()
  end, {
    buffer = buf,
    desc = 'Cancel queued Copilot prompt',
  })
  vim.keymap.set('n', 'p', function()
    local member_id = state.selected
    state.prompt_queue_paused[member_id] = not state.prompt_queue_paused[member_id]
    refresh_prompt_queue()
    if not state.prompt_queue_paused[member_id] then
      vim.schedule(function() dispatch_next_prompt(member_id) end)
    end
  end, {
    buffer = buf,
    desc = 'Pause or resume queued Copilot prompts',
  })
  state.prompt_queue_buf = buf
  return buf
end

refresh_prompt_queue = function()
  local member_id = state.selected
  local queue = state.queued_prompts[member_id] or {}
  local buf = ensure_prompt_queue_buffer()
  local paused = state.prompt_queue_paused[member_id] == true
  local lines = {
    ('Queued prompts — %s'):format(paused and 'paused' or 'FIFO'),
  }
  for index, item in ipairs(queue) do
    local preview = item.content:gsub('[\r\n]+', ' ')
    table.insert(lines, ('%d. %s · %s'):format(index, preview, item.updated_at))
  end
  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false

  if not is_ui_open() then return end
  if #queue == 0 then
    if state.prompt_queue_win and vim.api.nvim_win_is_valid(state.prompt_queue_win) then
      pcall(vim.api.nvim_win_close, state.prompt_queue_win, true)
    end
    state.prompt_queue_win = nil
    return
  end
  if not state.prompt_queue_win or not vim.api.nvim_win_is_valid(state.prompt_queue_win) then
    local current = vim.api.nvim_get_current_win()
    vim.api.nvim_set_current_win(state.prompt_win)
    local split = pcall(vim.cmd, 'aboveleft split')
    if split then
      state.prompt_queue_win = vim.api.nvim_get_current_win()
      vim.api.nvim_win_set_buf(state.prompt_queue_win, buf)
    else
      local height = math.max(
        1,
        math.min(options.prompt_queue_height, #lines, vim.o.lines - vim.o.cmdheight - 3)
      )
      state.prompt_queue_win = vim.api.nvim_open_win(buf, false, {
        relative = 'editor',
        row = math.max(0, vim.o.lines - vim.o.cmdheight - height - 2),
        col = 0,
        width = math.max(1, vim.o.columns),
        height = height,
        style = 'minimal',
      })
    end
    if vim.api.nvim_win_is_valid(current) then vim.api.nvim_set_current_win(current) end
  end
  vim.api.nvim_win_set_height(
    state.prompt_queue_win,
    math.max(
      1,
      math.min(
        options.prompt_queue_height,
        #lines,
        vim.o.lines - vim.o.cmdheight - 3
      )
    )
  )
  vim.wo[state.prompt_queue_win].winfixheight = true
  vim.wo[state.prompt_queue_win].winbar =
    ' Prompt queue  |  <Enter> edit  |  dd cancel  |  p pause/resume '
end

local function json_value(value)
  return value ~= vim.NIL and value or nil
end

local function task_description(task)
  if type(task) ~= 'table' then return 'Unknown task' end
  local detail = json_value(task.description)
    or json_value(task.command)
    or json_value(task.prompt)
    or json_value(task.id)
    or 'Unknown task'
  return tostring(detail):gsub('[\r\n]+', ' ')
end

local function task_terminal_detail(task, status)
  if status == 'failed' then
    return concise_detail(task.error) or concise_detail(task.message) or 'failed'
  elseif status == 'cancelled' then
    return concise_detail(task.message) or 'cancelled'
  elseif status == 'completed' then
    return concise_detail(task.output)
      or concise_detail(task.summary)
      or (type(json_value(task.result)) == 'string' and concise_detail(task.result) or nil)
      or 'completed'
  end
end

local function task_display_identifier(member_id, task)
  local source = json_value(task.toolCallId)
    or json_value(task.tool_call_id)
  if source then
    local normalized = tostring(source):gsub('[^%w_.:-]+', '_')
    return 'task_' .. normalized
  end
  source = json_value(task.id) or 'unknown'
  local digest = vim.fn.sha256(('%s\0%s'):format(member_id or 'standard', tostring(source)))
  return 'task_' .. digest:sub(1, 16)
end

local function emit_task_event(member_id, task, event)
  local status = json_value(task.status) or 'idle'
  buffers.upsert_timeline(member_id, ('task:%s:%s'):format(task.id, event), {
    kind = 'task',
    identifier = task_display_identifier(member_id, task),
    event = event,
    label = ('[%s] %s'):format(
      json_value(task.type) or 'task',
      task_description(task)
    ),
    status = event == 'started' and 'completed' or status,
    detail = task_terminal_detail(task, status),
    actor_message = event ~= 'started',
    task = vim.deepcopy(task),
    created_at = json_value(task.created_at),
  })
end

local function task_at_cursor()
  local item, member_id = buffers.timeline_item_at_cursor(
    vim.api.nvim_get_current_buf(),
    vim.api.nvim_win_get_cursor(0)[1]
  )
  return item, member_id
end

local function tool_timeline_detail(tool_name, arguments, status)
  if type(arguments) ~= 'table' then
    return status == 'running' and 'processing…' or status
  end

  local name = (tool_name or ''):lower()
  local detail
  if name == 'task' then
    detail = json_value(arguments.prompt) or json_value(arguments.description)
  elseif name == 'write_agent' or name:find('^send_to_') then
    detail = json_value(arguments.message) or json_value(arguments.content)
  elseif name == 'view' or name == 'read' or name == 'read_file' or name == 'read-file' then
    detail = json_value(arguments.path)
      or json_value(arguments.filePath)
      or json_value(arguments.file)
      or json_value(arguments.fileName)
  elseif name == 'glob' then
    detail = json_value(arguments.pattern)
  elseif name == 'rg' or name == 'grep' or name == 'search' or name == 'search_code' then
    detail = json_value(arguments.pattern) or json_value(arguments.query)
  end

  if type(detail) ~= 'string' or detail == '' then
    return status == 'running' and 'processing…' or status
  end
  detail = detail:gsub('[\r\n]+', ' ')
  if #detail > 180 then detail = detail:sub(1, 177) .. '...' end
  return detail
end

local function agent_tool_prompt(tool_name, arguments)
  if type(arguments) ~= 'table' then return end
  local name = tostring(tool_name or ''):lower()
  if name == 'task' then
    return json_value(arguments.prompt)
  elseif name == 'write_agent' or name:find('^send_to_') then
    return json_value(arguments.message) or json_value(arguments.content)
  end
end

local function shell_tool(name)
  name = tostring(name or ''):lower()
  return name == 'powershell'
    or name == 'bash'
    or name == 'shell'
    or name == 'local_shell'
    or name == 'local-shell'
end

local function shell_start_label(arguments)
  arguments = type(arguments) == 'table' and arguments or {}
  local description = json_value(arguments.description)
    or json_value(arguments.command)
    or 'Background shell command'
  return ('[shell] %s'):format(tostring(description):gsub('[\r\n]+', ' '))
end

local function result_has_async_handle(value)
  value = json_value(value)
  if type(value) ~= 'table' then return false end
  for key, nested in pairs(value) do
    if key == 'agent_id'
      or key == 'agentId'
      or key == 'run_id'
      or key == 'runId'
      or key == 'shell_id'
      or key == 'shellId'
      or key == 'task_id'
      or key == 'taskId'
    then
      return json_value(nested) ~= nil
    end
    if type(nested) == 'table' and result_has_async_handle(nested) then return true end
  end
  return false
end

local function update_tool_call(member_id, call_id, tool_name, status, details)
  local activity = state.tool_calls[member_id]
  if not activity then
    activity = { order = {}, items = {} }
    state.tool_calls[member_id] = activity
  end
  local item = activity.items[call_id]
  if not item then
    activity.sequence = (activity.sequence or 0) + 1
    item = {
      id = call_id,
      name = tool_name,
      sequence = activity.sequence,
    }
    activity.items[call_id] = item
  else
    for index, existing_id in ipairs(activity.order) do
      if existing_id == call_id then
        table.remove(activity.order, index)
        break
      end
    end
  end
  table.insert(activity.order, call_id)
  item.name = tool_name or item.name
  item.status = status
  item.details = vim.tbl_deep_extend('force', item.details or {}, details or {})
  item.created_at = item.created_at or json_value(item.details.created_at)
  local arguments = item.details.arguments
  local async_mode = type(arguments) == 'table'
    and (
      json_value(arguments.mode) == 'async'
      or json_value(arguments.mode) == 'background'
      or json_value(arguments.detach) == true
    )
  item.async = item.async or async_mode
  item.async_shell = item.async and shell_tool(item.name)
  local normalized_name = tostring(item.name or ''):lower()
  item.correlated = item.correlated
    or item.async
    or normalized_name == 'task'
    or normalized_name == 'run_factory'
    or result_has_async_handle(item.details.result)
  if item.async_shell and status == 'completed' then
    local function shell_id(value)
      value = json_value(value)
      if type(value) == 'table' then
        local direct = json_value(value.shellId) or json_value(value.shell_id)
        if direct ~= nil then return tostring(direct) end
        for _, nested in pairs(value) do
          local found = shell_id(nested)
          if found then return found end
        end
      elseif type(value) == 'string' then
        return value:match('[Ss]hell[Ii]d[%s:=]+([%w_-]+)')
      end
    end
    item.shell_id = item.shell_id or shell_id(item.details.result)
  end
  local terminal = status ~= 'running'
  item.timeline_id = item.timeline_id
    or (item.async_shell and ('async-task:' .. call_id) or ('tool:' .. call_id))
  if item.async_shell then
    if not item.task_id and (not terminal or status == 'failed') then
      buffers.upsert_timeline(member_id, item.timeline_id, {
        kind = 'task',
        event = status == 'failed' and 'failed to start' or 'starting',
        label = shell_start_label(item.details.arguments),
        status = status,
        details = item.details,
        created_at = item.created_at,
      })
    end
  else
    if not item.async then
      buffers.begin_response(member_id, 'tool:' .. tostring(call_id), item.created_at)
    end
    buffers.upsert_timeline(member_id, item.timeline_id, {
      kind = 'tool',
      identifier = item.correlated and call_id or nil,
      show_identifier = item.correlated,
      label = item.name,
      status = status,
      detail = tool_timeline_detail(item.name, item.details.arguments, status),
      actor_message = item.async and terminal,
      copilot_owned = not item.async,
      details = item.details,
      created_at = json_value(item.details.created_at),
    })
  end

  while #activity.order > 20 do
    local evict_index
    for index, candidate_id in ipairs(activity.order) do
      local candidate = activity.items[candidate_id]
      if candidate
        and candidate.status ~= 'running'
        and not (
          candidate.async_shell
          and candidate.status == 'completed'
          and not candidate.task_id
        )
      then
        evict_index = index
        break
      end
    end
    if not evict_index then break end
    local evicted = table.remove(activity.order, evict_index)
    activity.items[evicted] = nil
  end
end

local function claim_async_shell_tool(member_id, task)
  if json_value(task.type) ~= 'shell' then return false end
  local activity = state.tool_calls[member_id]
  if not activity then return false end
  local task_command = json_value(task.command)
  local matched_id
  local matched_command
  local fallback
  local pending_count = 0
  for _, item in pairs(activity.items) do
    if item
      and item.async_shell
      and item.status ~= 'failed'
      and not item.task_id
    then
      pending_count = pending_count + 1
      if item.shell_id and tostring(task.id) == item.shell_id then
        if not matched_id or item.sequence < matched_id.sequence then matched_id = item end
      end
      if not item.shell_id then
        local arguments = type(item.details) == 'table' and item.details.arguments or nil
        if type(arguments) == 'table' and json_value(arguments.command) == task_command then
          if not matched_command or item.sequence < matched_command.sequence then
            matched_command = item
          end
        end
        if not fallback or item.sequence < fallback.sequence then fallback = item end
      end
    end
  end
  fallback = matched_id
    or matched_command
    or (task_command == nil and pending_count == 1 and fallback or nil)
  if not fallback then return false end
  fallback.task_id = task.id
  task.toolCallId = task.toolCallId or fallback.id
  buffers.upsert_timeline(member_id, fallback.timeline_id, {
    kind = 'task',
    identifier = task_display_identifier(member_id, task),
    event = 'started',
    label = ('[shell] %s'):format(task_description(task)),
    status = 'completed',
    task = vim.deepcopy(task),
    details = fallback.details,
    created_at = fallback.created_at,
  })
  return true
end

local function remove_environment(member_id, component)
  local environment = state.environment[member_id]
  if not environment or not environment.components[component] then return end
  environment.components[component] = nil
  buffers.remove_timeline(member_id, 'environment:' .. component)
  for index, name in ipairs(environment.order) do
    if name == component then
      table.remove(environment.order, index)
      return
    end
  end
end

local function update_environment(member_id, component, status, detail)
  member_id = member_id or 'standard'
  component = component or 'Environment'
  local environment = state.environment[member_id]
  if not environment then
    environment = { components = {}, order = {} }
    state.environment[member_id] = environment
  end

  if not environment.components[component] then table.insert(environment.order, component) end
  environment.components[component] = {
    component = component,
    status = status,
    detail = detail,
  }
  buffers.upsert_timeline(member_id, 'environment:' .. component, {
    kind = 'environment',
    label = component,
    status = status,
    detail = detail or status,
  })
end

local function merge_tasks(member_id, incoming)
  incoming = type(incoming) == 'table' and incoming or {}
  local current = state.tasks[member_id] or {}
  local by_id = {}
  for _, task in ipairs(current) do by_id[task.id] = task end
  for _, task in ipairs(incoming or {}) do
    if type(task) ~= 'table' or type(json_value(task.id)) ~= 'string' then
      notify('Ignored a malformed task update.', vim.log.levels.WARN)
    else
      local was_known = by_id[task.id] ~= nil
      local previous_status = was_known and json_value(by_id[task.id].status) or nil
      if was_known then
        local updated = vim.tbl_deep_extend('force', by_id[task.id], task)
        for index, candidate in ipairs(current) do
          if candidate.id == task.id then
            current[index] = updated
            break
          end
        end
        by_id[task.id] = updated
      else
        table.insert(current, task)
        by_id[task.id] = task
      end
      local current_task = by_id[task.id]
      local status = json_value(current_task.status) or 'idle'
      if not was_known then
        local claimed = claim_async_shell_tool(member_id, current_task)
        if status == 'running' or status == 'idle' then
          if not claimed then emit_task_event(member_id, current_task, 'started') end
        else
          if claimed then emit_task_event(member_id, current_task, 'started') end
          emit_task_event(member_id, current_task, status)
        end
      elseif status ~= previous_status then
        if status == 'running' or status == 'idle' then
          emit_task_event(member_id, current_task, 'started')
        else
          emit_task_event(member_id, current_task, status)
        end
      end
    end
  end
  state.tasks[member_id] = current
  if type(state.task_detail) == 'table'
    and json_value(state.task_detail.id)
    and by_id[state.task_detail.id]
  then
    state.task_detail = by_id[state.task_detail.id]
  end
end

local function settle_linked_task(member_id, data, tool, status)
  local arguments = tool
      and type(tool.details) == 'table'
      and type(tool.details.arguments) == 'table'
      and tool.details.arguments
    or {}
  local task_id = json_value(data.taskId) or json_value(arguments.taskId) or json_value(arguments.shellId)
  if not task_id then return end

  for _, task in ipairs(state.tasks[member_id] or {}) do
    if tostring(json_value(task.id)) == tostring(task_id)
      and (task.status == 'running' or task.status == 'idle')
    then
      local error_detail = json_value(data.error)
      local error_message = type(error_detail) == 'table'
          and json_value(error_detail.message)
        or error_detail
      merge_tasks(member_id, {
        {
          id = task.id,
          status = status,
          error = status == 'failed'
              and (error_message or 'The associated tool execution failed.')
            or nil,
          result = status == 'completed' and json_value(data.result) or nil,
        },
      })
      return true
    end
  end
  return false
end

local function cancel_cursor_task()
  local item, member_id = task_at_cursor()
  local task = item and item.kind == 'task' and item.task or nil
  if type(task) ~= 'table' and type(state.task_detail) == 'table' then
    task = state.task_detail
    member_id = state.task_detail_member
  end
  if type(task) ~= 'table' then return end
  if task.status ~= 'running' and task.status ~= 'idle' then
    notify(('Task %s is already %s.'):format(task.id or '', task.status or 'finished'))
    return
  end
  send('tasks.cancel', { target = member_id or state.selected, taskId = task.id })
end

local function close_task_detail()
  if state.task_detail_win and vim.api.nvim_win_is_valid(state.task_detail_win) then
    vim.api.nvim_win_close(state.task_detail_win, true)
  end
  state.task_detail_win = nil
  state.task_detail = nil
  state.task_progress = nil
  state.task_progress_loaded = false
  state.task_detail_member = nil
  state.detail_item = nil
end

local function render_task_detail()
  local buf = state.task_detail_buf
  local item = state.detail_item
  local task = type(state.task_detail) == 'table' and state.task_detail or nil
  if not buf or not vim.api.nvim_buf_is_valid(buf) or type(item) ~= 'table' then return end
  local progress = type(state.task_progress) == 'table' and state.task_progress or nil
  local lines
  if item.kind == 'task' and task then
    local status = json_value(task.status) or 'unknown'
    lines = {
      ('%s [%s] %s'):format(
        buffers.status_symbol(status),
        json_value(task.type) or 'task',
        task_description(task)
      ),
      ('Status: %s'):format(status),
      ('ID: %s'):format(json_value(task.id) or 'unknown'),
      '',
    }
    local task_error = json_value(task.error)
    if task_error then
      table.insert(lines, 'Error:')
      local rendered_error = type(task_error) == 'string' and task_error or vim.inspect(task_error)
      vim.list_extend(lines, vim.split(rendered_error, '\n', { plain = true }))
      table.insert(lines, '')
    end
    local metadata = {
      { 'Started', json_value(task.startedAt) },
      { 'Completed', json_value(task.completedAt) },
      { 'Active time', task.activeTimeMs and (tostring(task.activeTimeMs) .. ' ms') or nil },
      { 'Model', json_value(task.resolvedModel) or json_value(task.model) },
    }
    for _, field in ipairs(metadata) do
      if field[2] then table.insert(lines, field[1] .. ': ' .. tostring(field[2])) end
    end
    if #lines > 4 then table.insert(lines, '') end
    local result = json_value(task.result)
    if result then
      table.insert(lines, 'Result:')
      vim.list_extend(
        lines,
        vim.split(type(result) == 'string' and result or vim.inspect(result), '\n', { plain = true })
      )
      table.insert(lines, '')
    end
    local latest_response = json_value(task.latestResponse)
    if latest_response and latest_response ~= result then
      table.insert(lines, 'Latest response:')
      vim.list_extend(
        lines,
        vim.split(
          type(latest_response) == 'string' and latest_response or vim.inspect(latest_response),
          '\n',
          { plain = true }
        )
      )
      table.insert(lines, '')
    end
    if not state.task_progress_loaded then
      table.insert(lines, 'Loading task progress...')
    elseif not progress then
      table.insert(lines, 'No progress details are available.')
    elseif progress.type == 'agent' then
      if progress.latestIntent then
        table.insert(lines, 'Intent: ' .. progress.latestIntent)
        table.insert(lines, '')
      end
      for _, activity in ipairs(progress.recentActivity or {}) do
        table.insert(lines, activity.message or vim.inspect(activity))
      end
    elseif progress.type == 'shell' then
      if progress.pid then table.insert(lines, ('PID: %s'):format(progress.pid)) end
      if progress.recentOutput and progress.recentOutput ~= '' then
        vim.list_extend(lines, vim.split(progress.recentOutput, '\n', { plain = true }))
      end
    else
      table.insert(lines, 'No progress details are available.')
    end
  else
    lines = {
      ('%s [%s] %s'):format(
        buffers.status_symbol(item.status),
        item.kind or 'activity',
        item.label or 'Activity'
      ),
      ('Status: %s'):format(item.status or 'unknown'),
      '',
    }
    local details = type(item.details) == 'table' and item.details or {}
    local fields = item.kind == 'tool'
        and {
          { 'Arguments', details.arguments },
          { 'Result', details.result },
          { 'Error', details.error },
        }
      or {
        { 'Prompt', details.prompt },
        { 'Schedule', details.schedule },
        { 'Next run', details.nextRunAt },
      }
    local populated = false
    for _, field in ipairs(fields) do
      local value = json_value(field[2])
      if value ~= nil and value ~= '' then
        populated = true
        table.insert(lines, field[1] .. ':')
        vim.list_extend(lines, vim.split(vim.inspect(value), '\n', { plain = true }))
        table.insert(lines, '')
      end
    end
    if not populated then table.insert(lines, 'No additional details are available.') end
  end
  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false
end

local function ensure_detail_buffer()
  local buf = state.task_detail_buf
  if buf and vim.api.nvim_buf_is_valid(buf) then return buf end
  buf = vim.api.nvim_create_buf(false, true)
  state.task_detail_buf = buf
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'hide'
  vim.bo[buf].swapfile = false
  vim.bo[buf].filetype = 'native-copilot'
  vim.bo[buf].modifiable = false
  vim.keymap.set('n', 'q', close_task_detail, { buffer = buf, desc = 'Close activity details' })
  vim.keymap.set('n', '<BS>', close_task_detail, {
    buffer = buf,
    desc = 'Close activity details',
  })
  vim.keymap.set('n', 'dd', cancel_cursor_task, {
    buffer = buf,
    desc = 'Cancel this Copilot task',
  })
  return buf
end

local function open_detail_window()
  local buf = ensure_detail_buffer()
  render_task_detail()
  local width = math.max(1, math.min(100, vim.o.columns - 4))
  local height = math.max(1, math.min(options.task_detail_height, vim.o.lines - vim.o.cmdheight - 4))
  if state.task_detail_win and vim.api.nvim_win_is_valid(state.task_detail_win) then
    vim.api.nvim_win_set_buf(state.task_detail_win, buf)
    vim.api.nvim_set_current_win(state.task_detail_win)
    return
  end
  state.task_detail_win = vim.api.nvim_open_win(buf, true, {
    relative = 'editor',
    row = math.floor((vim.o.lines - height) / 2),
    col = math.floor((vim.o.columns - width) / 2),
    width = width,
    height = height,
    style = 'minimal',
    border = 'rounded',
    title = ' Copilot activity details ',
    title_pos = 'center',
  })
end

local function show_task(task, member_id)
  if type(task) ~= 'table' then
    notify('Task details are unavailable.', vim.log.levels.WARN)
    return
  end
  state.task_detail = task
  state.task_progress = nil
  state.task_progress_loaded = false
  state.task_detail_member = member_id or state.selected
  state.detail_item = {
    kind = 'task',
    label = task_description(task),
    status = task.status,
    task = task,
  }
  open_detail_window()
  send('tasks.progress', { target = state.task_detail_member, taskId = task.id })
end

local function show_cursor_task()
  local item, member_id = task_at_cursor()
  if not item then return end
  if item.kind == 'task' then
    show_task(item.task, member_id)
    return
  end
  if item.kind ~= 'tool' and item.kind ~= 'schedule' then return end
  state.task_detail = nil
  state.task_progress = nil
  state.task_detail_member = member_id
  state.detail_item = item
  open_detail_window()
end

local function ordered_members()
  local result = {}
  for _, member_id in ipairs(state.member_order) do
    if buffers.get_member(member_id) then table.insert(result, member_id) end
  end
  return result
end

local function target_fleet_id(member_id)
  local slash = member_id:find('/', 1, true)
  if not slash then return nil end
  return member_id:sub(1, slash - 1)
end

local function order_contains(member_id)
  for _, id in ipairs(state.member_order) do
    if id == member_id then return true end
  end
  return false
end

local function add_to_order(member_id)
  if not order_contains(member_id) then table.insert(state.member_order, member_id) end
end

local function remove_from_order(member_id)
  for index, id in ipairs(state.member_order) do
    if id == member_id then
      table.remove(state.member_order, index)
      return
    end
  end
end

-- Clears one member's transient UI state and buffers without touching any other
-- member, keeping Standard and other Fleets intact during incremental lifecycle
-- transitions.
local function reset_member(member_id, preserve_buffers)
  if not preserve_buffers then buffers.remove_member(member_id) end
  state.tasks[member_id] = nil
  state.environment[member_id] = nil
  state.tool_calls[member_id] = nil
  state.session_metrics[member_id] = nil
  state.active_prompts[member_id] = nil
  state.queued_prompts[member_id] = nil
  state.prompt_queue_paused[member_id] = nil
  state.command_requests[member_id] = nil
  state.command_catalog_loaded[member_id] = nil
  state.member_meta[member_id] = nil
  commands.set_catalog(member_id, nil)
end

local function member_label(member_id)
  local entry = buffers.get_member(member_id)
  local name = entry and entry.display_name or member_id
  local meta = state.member_meta[member_id]
  if meta and meta.fleetName then
    return ('%s · %s'):format(meta.fleetName, name)
  end
  return name
end

function M.cycle_member(step)
  vim.validate('step', step, 'number')
  if step == 0 then return end
  local members = ordered_members()
  if #members == 0 then return end
  local return_to_prompt = state.prompt_buf
    and vim.api.nvim_buf_is_valid(state.prompt_buf)
    and vim.api.nvim_get_current_buf() == state.prompt_buf
  local index = 1
  for candidate, member_id in ipairs(members) do
    if member_id == state.selected then
      index = candidate
      break
    end
  end
  index = ((index - 1 + step) % #members) + 1
  M.show_member(members[index])
  if return_to_prompt then focus_prompt() end
end

local function configure_agent_buffer(member_id, buf)
  if state.configured_buffers[buf] then return end
  state.configured_buffers[buf] = true
  vim.keymap.set('n', '[a', function() M.cycle_member(-1) end, {
    buffer = buf,
    desc = 'Previous Copilot member',
  })
  vim.keymap.set('n', ']a', function() M.cycle_member(1) end, {
    buffer = buf,
    desc = 'Next Copilot member',
  })
  vim.keymap.set('n', '<CR>', function()
    if state.overview then
      state.selected = member_id
      update_prompt_label()
      if state.prompt_win and vim.api.nvim_win_is_valid(state.prompt_win) then
        focus_prompt()
      end
    else
      local item = buffers.timeline_item_at_cursor(buf, vim.api.nvim_win_get_cursor(0)[1])
      if item and (item.kind == 'task' or item.kind == 'tool' or item.kind == 'schedule') then
        show_cursor_task()
      else
        vim.cmd('normal! j')
      end
    end
  end, {
    buffer = buf,
    desc = 'Open task details or select Copilot recipient',
  })
end

local function ensure_member(member_id, display_name)
  local entry = buffers.ensure_member(member_id, display_name)
  for _, view in pairs(entry.views) do
    configure_agent_buffer(member_id, view.buf)
  end
  return entry
end

local function close_non_prompt_windows()
  if not is_ui_open() then return nil end
  local prompt_win
  local prompt_queue_win
  local keep
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(state.tab)) do
    if vim.api.nvim_win_get_buf(win) == state.prompt_buf then
      prompt_win = win
    elseif vim.api.nvim_win_get_buf(win) == state.prompt_queue_buf then
      prompt_queue_win = win
    elseif not keep then
      keep = win
    end
  end
  if not keep then
    vim.api.nvim_set_current_tabpage(state.tab)
    vim.cmd('aboveleft split')
    keep = vim.api.nvim_get_current_win()
  end
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(state.tab)) do
    if
      win ~= keep
      and win ~= prompt_win
      and win ~= prompt_queue_win
      and vim.api.nvim_win_is_valid(win)
    then
      pcall(vim.api.nvim_win_close, win, true)
    end
  end
  state.main_win = keep
  state.prompt_win = prompt_win
  state.prompt_queue_win = prompt_queue_win
  return keep
end

local function ensure_ui(reuse_current_tab)
  if is_ui_open() then
    vim.api.nvim_set_current_tabpage(state.tab)
    return
  end
  if not reuse_current_tab then vim.cmd('tabnew') end
  state.tab = vim.api.nvim_get_current_tabpage()
  state.main_win = vim.api.nvim_get_current_win()
  if
    not state.compact_ui_options
    and vim.o.lines - vim.o.cmdheight < options.prompt_height + 4
  then
    state.compact_ui_options = {
      cmdheight = vim.o.cmdheight,
      laststatus = vim.o.laststatus,
      showtabline = vim.o.showtabline,
    }
    vim.o.cmdheight = 0
    vim.o.laststatus = 0
    vim.o.showtabline = 0
  end
  local entry = ensure_member(state.selected, state.selected == 'standard' and 'Copilot' or nil)
  vim.api.nvim_win_set_buf(state.main_win, entry.views.conversation.buf)
  buffers.on_shown(entry.views.conversation.buf)
  local prompt_buf = ensure_prompt_buffer()
  local split = pcall(vim.cmd, 'botright split')
  if split then
    state.prompt_win = vim.api.nvim_get_current_win()
    vim.api.nvim_win_set_buf(state.prompt_win, prompt_buf)
    vim.api.nvim_win_set_height(
      state.prompt_win,
      math.max(1, math.min(options.prompt_height, vim.o.lines - vim.o.cmdheight - 2))
    )
    vim.wo[state.prompt_win].winfixheight = true
  else
    state.prompt_win = vim.api.nvim_open_win(prompt_buf, true, {
      relative = 'win',
      win = state.main_win,
      row = math.max(0, vim.api.nvim_win_get_height(state.main_win) - 1),
      col = 0,
      width = math.max(1, vim.api.nvim_win_get_width(state.main_win)),
      height = 1,
      style = 'minimal',
    })
  end
  update_prompt_label()
  refresh_prompt_queue()
  vim.api.nvim_set_current_win(state.prompt_win)
end

local function start_host()
  if protocol.is_running() then return true end
  return protocol.start({
    node_command = options.node_command,
    runtime_command_resolver = options.runtime_command_resolver,
    database_path = options.database_path,
    workspace = current_workspace(),
  }, M._on_event)
end

function M.open(open_options)
  if not start_host() then return end
  ensure_ui(type(open_options) == 'table' and open_options.reuse_current_tab == true)
  send('hello')
  if state.mode == 'stopped' then send('mode.standard') end
end

function M.close()
  if not is_ui_open() then return end
  close_task_detail()
  if #vim.api.nvim_list_tabpages() == 1 then
    vim.cmd('tabnew')
  end
  vim.api.nvim_set_current_tabpage(state.tab)
  vim.cmd('tabclose')
  state.tab = nil
  state.main_win = nil
  state.prompt_win = nil
  state.prompt_queue_win = nil
  state.overview = false
  restore_compact_ui_options()
end

function M.toggle()
  if is_ui_open() then M.close() else M.open() end
end

function M.show_member(member_id, view_id)
  ensure_ui()
  local entry = buffers.get_member(member_id)
  if not entry then
    notify(('Unknown Copilot member: %s'):format(member_id), vim.log.levels.ERROR)
    return
  end
  state.overview = false
  state.selected = member_id
  close_task_detail()
  local win = close_non_prompt_windows()
  local view_buf = entry.views[view_id or 'conversation'].buf
  vim.api.nvim_win_set_buf(win, view_buf)
  buffers.on_shown(view_buf)
  buffers.mark_read(member_id)
  update_prompt_label()
  update_conversation_label(member_id)
  refresh_prompt_queue()
  vim.api.nvim_set_current_win(win)
end

local function refresh_member(member_id)
  local current_tab = vim.api.nvim_get_current_tabpage()
  local current_win = vim.api.nvim_get_current_win()
  M.show_member(member_id)
  if
    vim.api.nvim_tabpage_is_valid(current_tab)
    and vim.api.nvim_win_is_valid(current_win)
    and vim.api.nvim_win_get_tabpage(current_win) == current_tab
  then
    vim.api.nvim_set_current_tabpage(current_tab)
    vim.api.nvim_set_current_win(current_win)
  end
end

function M.show_overview()
  ensure_ui()
  close_task_detail()
  local members = ordered_members()
  if #members == 0 then return end
  state.overview = true
  local first = close_non_prompt_windows()
  vim.api.nvim_set_current_win(first)
  local maximum = math.min(#members, options.overview_max_agents)
  local first_buf = buffers.buffer(members[1], 'conversation')
  vim.api.nvim_win_set_buf(first, first_buf)
  buffers.on_shown(first_buf)
  for index = 2, maximum do
    if not pcall(vim.cmd, 'rightbelow vsplit') then break end
    local member_buf = buffers.buffer(members[index], 'conversation')
    vim.api.nvim_win_set_buf(0, member_buf)
    buffers.on_shown(member_buf)
  end
  vim.cmd('wincmd =')
  for index = 1, maximum do update_conversation_label(members[index]) end
  update_prompt_label()
end

local function update_status_buffer()
  if not state.status_buf or not vim.api.nvim_buf_is_valid(state.status_buf) then
    state.status_buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_name(state.status_buf, 'native-copilot://status')
    vim.bo[state.status_buf].buftype = 'nofile'
    vim.bo[state.status_buf].bufhidden = 'hide'
    vim.bo[state.status_buf].swapfile = false
    vim.bo[state.status_buf].filetype = 'native-copilot'
    vim.b[state.status_buf].native_copilot = true
  end
  local active_fleets = {}
  for fleet_id in pairs(state.fleets) do table.insert(active_fleets, fleet_id) end
  table.sort(active_fleets)
  local lines = {
    '# Native Copilot Status',
    '',
    ('- **Mode:** %s'):format(state.mode),
    ('- **Standard:** %s'):format(buffers.get_member('standard') and 'active' or 'stopped'),
    ('- **Active Fleets:** %d'):format(#active_fleets),
    ('- **Selected recipient:** %s'):format(state.selected),
    '',
  }
  for _, fleet_id in ipairs(active_fleets) do
    local fleet = state.fleets[fleet_id]
    table.insert(lines, ('- Fleet `%s` — %s (%d members)'):format(
      fleet_id,
      fleet.name or fleet_id,
      #(fleet.members or {})
    ))
  end
  if #active_fleets > 0 then table.insert(lines, '') end
  table.insert(lines, '| Member | Fleet | State | Unread |')
  table.insert(lines, '|---|---|---:|---:|')
  for _, member_id in ipairs(ordered_members()) do
    local entry = buffers.get_member(member_id)
    local meta = state.member_meta[member_id]
    table.insert(lines, ('| %s | %s | %s | %d |'):format(
      entry.display_name,
      meta and (meta.fleetName or meta.fleetId) or '—',
      entry.state,
      entry.unread
    ))
  end
  vim.bo[state.status_buf].modifiable = true
  vim.api.nvim_buf_set_lines(state.status_buf, 0, -1, false, lines)
  vim.bo[state.status_buf].modifiable = false
  return state.status_buf
end

function M.show_status()
  ensure_ui()
  state.overview = false
  local win = close_non_prompt_windows()
  vim.api.nvim_win_set_buf(win, update_status_buffer())
  vim.api.nvim_set_current_win(win)
end

local function relative_age(seconds)
  seconds = math.max(0, tonumber(seconds) or 0)
  if seconds < 60 then return 'less than a minute ago' end
  if seconds < 3600 then
    local minutes = math.floor(seconds / 60)
    return ('%d minute%s ago'):format(minutes, minutes == 1 and '' or 's')
  end
  if seconds < 86400 then
    local hours = math.floor(seconds / 3600)
    return ('%d hour%s ago'):format(hours, hours == 1 and '' or 's')
  end
  local days = math.floor(seconds / 86400)
  return ('%d day%s ago'):format(days, days == 1 and '' or 's')
end

local function picker(title, entries, choose, picker_options)
  picker_options = picker_options or {}
  if options.frontend.picker == 'native' then
    vim.ui.select(entries, {
      prompt = title,
      format_item = function(item) return item.display end,
    }, function(item)
      if item then choose(item) end
    end)
    return
  end

  if options.frontend.picker ~= 'telescope' then
    notify(
      ('Unknown picker frontend: %s'):format(options.frontend.picker),
      vim.log.levels.ERROR
    )
    return
  end

  local modules = {}
  for _, name in ipairs({
    'telescope.pickers',
    'telescope.finders',
    'telescope.actions',
    'telescope.actions.state',
    'telescope.config',
    'telescope.sorters',
  }) do
    local ok, loaded = pcall(require, name)
    if not ok then
      notify(('Telescope picker unavailable: %s'):format(loaded), vim.log.levels.ERROR)
      return
    end
    modules[name] = loaded
  end
  local pickers = modules['telescope.pickers']
  local finders = modules['telescope.finders']
  local actions = modules['telescope.actions']
  local action_state = modules['telescope.actions.state']
  local conf = modules['telescope.config'].values
  local sorters = modules['telescope.sorters']
  local restore_eventignore
  local restore_cursor_animation
  if picker_options.suppress_cursor_events then
    local ignored = vim.o.eventignore
    local events = vim.split(ignored, ',', { plain = true, trimempty = true })
    for _, event in ipairs({ 'CursorMoved', 'CursorMovedI', 'ModeChanged', 'WinScrolled' }) do
      if not vim.tbl_contains(events, event) then table.insert(events, event) end
    end
    vim.o.eventignore = table.concat(events, ',')
    restore_eventignore = function()
      if restore_eventignore then
        vim.o.eventignore = ignored
        restore_eventignore = nil
      end
    end
    local smear_cursor = package.loaded['smear_cursor']
    if type(smear_cursor) == 'table' and smear_cursor.enabled == true then
      smear_cursor.enabled = false
      local restored = false
      restore_cursor_animation = function()
        if restored then return end
        restored = true
        local row, col = require('smear_cursor.screen').get_screen_cursor_position()
        require('smear_cursor.animation').jump(row, col)
        smear_cursor.enabled = true
      end
    end
  end
  local on_complete
  if picker_options.on_complete or restore_eventignore then
    on_complete = function(active_picker)
      local callback_ok, callback_failure = true, nil
      if picker_options.on_complete then
        callback_ok, callback_failure = pcall(picker_options.on_complete, active_picker)
      end
      if restore_eventignore then vim.defer_fn(restore_eventignore, 100) end
      if not callback_ok then
        notify(('Telescope picker completion failed: %s'):format(callback_failure), vim.log.levels.ERROR)
      end
    end
  end
  local telescope_options = {
    prompt_title = title,
    sorting_strategy = picker_options.sorting_strategy,
    default_selection_index = picker_options.default_selection_index,
    on_complete = on_complete and { on_complete } or nil,
    temp__scrolling_limit = picker_options.result_limit,
    finder = finders.new_table({
      results = entries,
      entry_maker = function(item)
        return {
          value = item,
          display = item.display,
          ordinal = item.ordinal or item.display,
        }
      end,
    }),
    sorter = picker_options.preserve_order and sorters.empty() or conf.generic_sorter({}),
    attach_mappings = function(prompt_buf)
      if restore_cursor_animation then
        vim.api.nvim_create_autocmd('BufWipeout', {
          buffer = prompt_buf,
          once = true,
          callback = function()
            local restore = restore_cursor_animation
            if restore then vim.defer_fn(restore, 100) end
          end,
        })
      end
      actions.select_default:replace(function()
        local selection = action_state.get_selected_entry()
        if restore_eventignore then restore_eventignore() end
        local selection_restore = restore_cursor_animation
        restore_cursor_animation = nil
        actions.close(prompt_buf)
        if selection then
          choose(selection.value, selection_restore)
        elseif selection_restore then
          vim.defer_fn(selection_restore, 100)
        end
      end)
      return true
    end,
  }
  local ok, failure = pcall(function()
    pickers.new({}, telescope_options):find()
  end)
  if restore_eventignore then vim.defer_fn(restore_eventignore, 1000) end
  if not ok then
    if restore_eventignore then restore_eventignore() end
    if restore_cursor_animation then restore_cursor_animation() end
    notify(('Could not open Telescope picker: %s'):format(failure), vim.log.levels.ERROR)
  end
end

local function permission_detail(request)
  if request.kind == 'shell' then
    local commands = json_value(request.commands)
    return json_value(request.fullCommandText)
      or (type(commands) == 'table' and table.concat(commands, ' ') or nil)
      or request.kind
  end
  return json_value(request.path)
    or json_value(request.url)
    or json_value(request.toolName)
    or json_value(request.fileName)
    or json_value(request.factoryId)
    or request.kind
end

local function show_next_permission()
  if state.permission_prompt_open or #state.permission_queue == 0 then return end
  state.permission_prompt_open = true
  local pending = table.remove(state.permission_queue, 1)
  local request = pending.request or {}
  local warning = request.managedApprovalRequired and ' (managed approval required)' or ''
  vim.ui.select({
    { display = 'Approve once', approved = true },
    { display = 'Reject', approved = false },
  }, {
    prompt = ('Copilot %s permission%s: %s'):format(
      request.kind or 'tool',
      warning,
      tostring(permission_detail(request))
    ),
    format_item = function(item) return item.display end,
  }, function(item)
    local approved = item ~= nil and item.approved == true
    send('permission.respond', {
      requestId = pending.requestId,
      approved = approved,
    })
    buffers.upsert_timeline(pending.member_id, pending.timeline_id, {
      kind = 'permission',
      label = pending.kind,
      status = approved and 'completed' or 'denied',
      detail = ('%s: %s'):format(
        approved and 'approved once' or 'denied',
        pending.detail
      ),
    })
    state.permission_prompt_open = false
    vim.schedule(show_next_permission)
  end)
end

local function request_permission(payload, member_id)
  local request = payload.request or {}
  local pending = vim.tbl_extend('force', payload, {
    member_id = member_id,
    timeline_id = 'permission:' .. tostring(payload.requestId),
    kind = request.kind or 'tool',
    detail = tostring(permission_detail(request)),
  })
  table.insert(state.permission_queue, pending)
  buffers.upsert_timeline(member_id, pending.timeline_id, {
    kind = 'permission',
    label = pending.kind,
    status = 'running',
    detail = 'approval required: ' .. pending.detail,
  })
  show_next_permission()
end

function M.select_commands()
  if not start_host() then return end
  ensure_ui()
  send('commands.list', { target = state.selected, purpose = 'browse' })
end

function M.ensure_commands(target)
  if
    not target
    or state.command_catalog_loaded[target]
    or state.command_requests[target]
  then
    return
  end
  if not protocol.is_running() then return end
  state.command_requests[target] = true
  send('commands.list', { target = target, purpose = 'cache' })
end

local function show_commands(target, available)
  commands.set_catalog(target, available)
  local entries = {}
  for _, command in ipairs(available) do
    local aliases = command.aliases and #command.aliases > 0
        and (' [' .. table.concat(command.aliases, ', ') .. ']')
      or ''
    table.insert(entries, {
      display = ('/%s%s — %s'):format(command.name, aliases, command.description),
      ordinal = command.name .. ' ' .. command.description .. ' ' .. table.concat(command.aliases or {}, ' '),
      command = command,
    })
  end
  picker(('Copilot commands — %s'):format(target), entries, function(item)
    state.selected = target
    ensure_ui()
    local prompt = commands.prompt(item.command)
    set_prompt_lines({ prompt })
    update_prompt_label()
    if state.prompt_win and vim.api.nvim_win_is_valid(state.prompt_win) then
      vim.api.nvim_set_current_win(state.prompt_win)
      vim.api.nvim_win_set_cursor(state.prompt_win, { 1, #prompt })
      vim.cmd('startinsert!')
      if item.command.input and item.command.input.choices then complete_slash_input() end
    end
  end)
end

function M.select()
  if not start_host() then return end
  ensure_ui()
  local entries = {
    { display = 'All agents overview', kind = 'overview' },
    { display = 'Fleet status', kind = 'status' },
  }
  for _, member_id in ipairs(ordered_members()) do
    local entry = buffers.get_member(member_id)
    for _, view_id in ipairs({ 'conversation', 'messages' }) do
      table.insert(entries, {
        display = ('%s — %s%s'):format(
          member_label(member_id),
          view_id,
          entry.unread > 0 and ('  [' .. entry.unread .. ' unread]') or ''
        ),
        kind = 'member',
        member_id = member_id,
        view_id = view_id,
      })
    end
  end
  picker('Copilot mode / agent / view', entries, function(item)
    if item.kind == 'overview' then
      M.show_overview()
    elseif item.kind == 'status' then
      M.show_status()
    else
      M.show_member(item.member_id, item.view_id)
    end
  end)
end

function M.select_task()
  if not start_host() then return end
  ensure_ui()
  send('tasks.list', { target = state.selected, purpose = 'select' })
end

function M.cancel_background()
  if not start_host() then return end
  send('session.cancel-background', { target = state.selected })
end

function M.abort()
  if not start_host() then return end
  send('session.abort', { target = state.selected })
end

function M.reload_mcp()
  if not start_host() then return end
  send('mcp.reload', { target = state.selected })
end

function M.select_fleet()
  if not start_host() then return end
  ensure_ui()
  local entries = {}
  local active_ids = {}
  for fleet_id in pairs(state.fleets) do
    table.insert(active_ids, fleet_id)
  end
  table.sort(active_ids)
  for _, fleet_id in ipairs(active_ids) do
    local fleet = state.fleets[fleet_id]
    table.insert(entries, {
      display = ('Stop %s (%d members)'):format(fleet.name or fleet_id, #(fleet.members or {})),
      ordinal = ('stop %s %s'):format(fleet_id, fleet.name or ''),
      kind = 'stop',
      fleetId = fleet_id,
    })
  end
  for _, run in ipairs(state.recoverable_fleets) do
    table.insert(entries, {
      display = ('Recover %s · %s · %d sessions'):format(
        run.name or run.fleetId,
        run.status,
        #(run.members or {})
      ),
      ordinal = table.concat({
        'recover',
        run.name or run.fleetId,
        run.startedAt or '',
        run.status or '',
      }, ' '),
      kind = 'recover',
      run = run,
    })
  end
  if vim.tbl_isempty(entries) then
    notify('Describe the fleet objective in a prompt or use /fleet <objective>.', vim.log.levels.INFO)
    return
  end
  picker('Copilot Fleets', entries, function(item)
    if item.kind == 'stop' then
      send('fleet.stop', { fleetId = item.fleetId })
      return
    end
    if item.kind == 'recover' then
      send('fleet.resume', { runId = item.run.id })
      return
    end
  end)
end

local function event_member(message)
  return message.memberId or 'standard'
end

local function history_task(member_id, task, status, event_time)
  task = vim.tbl_deep_extend('force', task, {
    status = status,
    created_at = event_time,
  })
  local existing
  for _, candidate in ipairs(state.tasks[member_id] or {}) do
    if tostring(json_value(candidate.id)) == tostring(json_value(task.id)) then
      existing = candidate
      break
    end
  end
  if not existing and status ~= 'running' and status ~= 'idle' then
    merge_tasks(member_id, { vim.tbl_deep_extend('force', task, { status = 'running' }) })
  end
  merge_tasks(member_id, { task })
end

local function render_instruction_notification(member_id, event_id, kind, event_time)
  buffers.upsert_timeline(member_id, 'instruction:' .. tostring(event_id), {
    kind = 'instruction',
    label = kind.description or kind.sourcePath or 'Instruction discovered',
    status = 'completed',
    detail = kind.triggerFile,
    created_at = event_time,
  })
end

local function history_notification(member_id, event, event_time)
  local data = type(event.data) == 'table' and event.data or {}
  local kind = type(data.kind) == 'table' and data.kind or {}
  if kind.type == 'shell_completed' or kind.type == 'shell_detached_completed' then
    history_task(member_id, {
      id = tostring(kind.shellId or event.id),
      type = 'shell',
      description = kind.description or 'Background shell command',
      result = kind.exitCode ~= nil and ('exit code ' .. tostring(kind.exitCode)) or 'completed',
    }, kind.exitCode ~= nil and kind.exitCode ~= 0 and 'failed' or 'completed', event_time)
  elseif kind.type == 'agent_completed' or kind.type == 'agent_idle' then
    local status = kind.type == 'agent_idle' and 'idle'
      or kind.status == 'failed' and 'failed'
      or kind.status == 'cancelled' and 'cancelled'
      or 'completed'
    history_task(member_id, {
      id = tostring(kind.agentId or event.id),
      type = kind.agentType or 'agent',
      description = kind.description or kind.prompt or 'Background agent',
      prompt = kind.prompt,
    }, status, event_time)
  elseif kind.type == 'factory_completed' then
    history_task(member_id, {
      id = tostring(kind.runId or kind.factoryId or event.id),
      type = 'factory',
      description = kind.name or kind.factoryName or 'Factory run',
      result = kind.result,
      error = kind.error,
    }, kind.status == 'failed' and 'failed' or 'completed', event_time)
  elseif kind.type == 'instruction_discovered' then
    render_instruction_notification(member_id, event.id, kind, event_time)
  elseif kind.type == 'new_inbox_message' then
    buffers.append_activity_block(
      member_id,
      'Inbox message',
      kind.summary or ('New message from ' .. tostring(kind.senderName or 'another participant')),
      event_time
    )
  elseif type(data.content) == 'string' and data.content ~= '' then
    local content = data.content
      :gsub('^%s*<system_notification>%s*', '')
      :gsub('%s*</system_notification>%s*$', '')
    if content ~= '' then
      buffers.append_activity_block(member_id, 'System notification', content, event_time)
    end
  end
end

local function history_event(member_id, event, context)
  if type(event) ~= 'table' or event.ephemeral == true then return end
  local data = type(event.data) == 'table' and event.data or {}
  local replay_timestamp = tonumber(json_value(event.replayTimestamp))
  local event_time = replay_timestamp and math.floor(replay_timestamp / 1000) or nil
  local agent_id = json_value(event.agentId)
  local source = tostring(json_value(data.source) or '')
  if event.type == 'user.message' and event.data then
    local content = data.content or data.prompt
    if content then
      if agent_id or source:find('^agent%-') then
        table.insert(context.agent_messages, {
          content = content,
          created_at = event_time,
        })
      else
        buffers.append_block(member_id, 'conversation', 'You', content, event_time)
      end
    end
  elseif
    agent_id
    and (
      event.type:find('^assistant%.')
      or event.type == 'tool.execution_start'
      or event.type == 'tool.execution_complete'
    )
  then
    -- Sub-agent internals belong to the Task lifecycle, not the root Copilot transcript.
    return
  elseif event.type == 'assistant.turn_start' then
    buffers.begin_response(member_id, data.turnId or event.id, event_time)
  elseif event.type == 'assistant.turn_end' or event.type == 'session.idle' then
    buffers.finish_response(member_id, event_time)
  elseif event.type == 'assistant.message' and data.content then
    buffers.complete_conversation(member_id, data.messageId or event.id, data.content, event_time)
  elseif event.type == 'assistant.reasoning' and data.content then
    buffers.begin_response(member_id, data.reasoningId or event.id, event_time)
    buffers.complete_activity(member_id, data.reasoningId or event.id, data.content, event_time)
  elseif event.type == 'tool.execution_start' then
    local call_id = data.toolCallId or event.id
    local prompt = agent_tool_prompt(data.toolName, data.arguments)
    if prompt then
      local key = tostring(prompt):gsub('\r\n', '\n'):gsub('^%s+', ''):gsub('%s+$', '')
      context.agent_tool_prompts[key] = (context.agent_tool_prompts[key] or 0) + 1
      context.tool_arguments[tostring(call_id)] = data.arguments
    end
    update_tool_call(member_id, call_id, data.toolName, 'running', {
      arguments = data.arguments,
      created_at = event_time,
    })
  elseif event.type == 'tool.execution_complete' then
    update_tool_call(member_id, data.toolCallId or event.id, data.toolName, data.success == false and 'failed' or 'completed', {
      result = data.result,
      error = data.error,
      created_at = event_time,
    })
  elseif event.type == 'subagent.started' then
    local arguments = context.tool_arguments[tostring(data.toolCallId or '')]
    history_task(member_id, {
      id = tostring(event.agentId or data.toolCallId or event.id),
      toolCallId = data.toolCallId,
      type = data.agentName or 'agent',
      description = data.agentDescription or data.agentDisplayName or 'Background agent',
      prompt = agent_tool_prompt('task', arguments),
      model = data.model,
    }, 'running', event_time)
  elseif event.type == 'subagent.completed' or event.type == 'subagent.failed' then
    history_task(member_id, {
      id = tostring(event.agentId or data.toolCallId or event.id),
      toolCallId = data.toolCallId,
      type = data.agentName or 'agent',
      error = data.error,
    }, event.type == 'subagent.failed' and 'failed'
      or data.cancelled == true and 'cancelled'
      or 'completed', event_time)
  elseif event.type == 'system.notification' then
    history_notification(member_id, event, event_time)
  elseif event.type == 'permission.requested' then
    context.permissions[tostring(data.requestId or event.id)] = data.permissionRequest or {}
  elseif event.type == 'permission.completed' then
    local request_id = tostring(data.requestId or '')
    local request = context.permissions[request_id]
    if request then
      local result = type(data.result) == 'table' and data.result or {}
      local approved = result.kind == 'approved' or result.kind == 'approved-for-session'
      buffers.upsert_timeline(member_id, 'permission:' .. request_id, {
        kind = 'permission',
        label = request.kind or 'tool',
        status = approved and 'completed' or 'denied',
        detail = ('%s: %s'):format(
          approved and 'approved' or 'denied',
          tostring(permission_detail(request))
        ),
        created_at = event_time,
      })
      context.permissions[request_id] = nil
    end
  elseif event.type == 'session.schedule_created' then
    update_schedule(member_id, data.id, 'created', data, event.id, event_time)
  elseif event.type == 'session.schedule_cancelled' then
    update_schedule(member_id, data.id, 'cancelled', data, event.id, event_time)
  elseif event.type == 'session.schedule_rearmed' then
    update_schedule(member_id, data.id, 'rearmed', data, event.id, event_time)
  elseif event.type == 'session.error' or event.type == 'session.warning' or event.type == 'session.info' then
    local heading = event.type == 'session.error' and 'Session error'
      or event.type == 'session.warning' and 'Session warning'
      or 'Session information'
    buffers.append_activity_block(member_id, heading, data.message or vim.inspect(data))
  end
end

local function finish_history_context(member_id, context)
  buffers.finish_response(member_id)
  for _, message in ipairs(context.agent_messages) do
    local key = tostring(message.content):gsub('\r\n', '\n'):gsub('^%s+', ''):gsub('%s+$', '')
    local matches = context.agent_tool_prompts[key] or 0
    if matches > 0 then
      context.agent_tool_prompts[key] = matches - 1
    else
      buffers.append_block(
        member_id,
        'conversation',
        'Task',
        message.content,
        message.created_at
      )
    end
  end
end

local function model_id(model)
  return model.selectionId or model.id or model.modelId or model.name
end

local function model_name(model)
  return model.name or model.displayName or model_id(model) or 'Unknown model'
end

local function send_mcp_action(target, action, server_name)
  send('mcp.' .. action, {
    target = target,
    serverName = server_name,
  })
end

local function select_mcp_server(target, servers, action)
  local entries = {}
  for _, server in ipairs(servers or {}) do
    table.insert(entries, {
      display = ('%s — %s'):format(server.name, server.status or 'unknown'),
      ordinal = table.concat({
        server.name or '',
        server.status or '',
        server.error or '',
      }, ' '),
      server = server,
    })
  end
  if #entries == 0 then
    notify('No MCP servers are configured for this session.', vim.log.levels.INFO)
    return
  end
  picker(action and ('MCP server — ' .. action) or 'MCP servers', entries, function(item)
    local server = item.server
    if action then
      send_mcp_action(target, action, server.name)
      return
    end
    local actions = {
      { display = 'Show server details', action = 'show' },
      { display = 'List server tools', action = 'tools' },
      {
        display = server.status == 'disabled' and 'Enable server' or 'Disable server',
        action = server.status == 'disabled' and 'enable' or 'disable',
      },
      { display = 'Reload all MCP servers', action = 'reload' },
    }
    picker(('MCP — %s'):format(server.name), actions, function(selected)
      if selected.action == 'reload' then
        send('mcp.reload', { target = target })
      else
        send_mcp_action(target, selected.action, server.name)
      end
    end)
  end)
end

local function append_mcp_list(member_id, servers)
  local lines = { '| Server | Status |', '| --- | --- |' }
  for _, server in ipairs(servers or {}) do
    table.insert(lines, ('| %s | %s |'):format(server.name or '?', server.status or 'unknown'))
  end
  if #lines == 2 then table.insert(lines, '| _None configured_ | — |') end
  buffers.append_block(member_id, 'conversation', 'Copilot', table.concat(lines, '\n'))
end

function M._on_event(message)
  local payload = message.payload or {}
  if message.type == 'hello' then
    state.recoverable_fleets = payload.recoverableFleets or {}
    local status = payload.status or {}
    -- Reconcile against a host that may already have Standard and Fleets running
    -- (for example when the UI reattaches to a live host).
    if status.standard then
      add_to_order('standard')
      ensure_member('standard', (payload.standard and payload.standard.displayName) or 'Copilot')
      if state.mode == 'stopped' then state.mode = 'standard' end
    end
    -- status.fleets is authoritative: rebuild each reported Fleet, and after a host
    -- restart drop any local Fleet or member the host no longer reports so stale
    -- buffers/order entries never linger.
    local reported_fleets = {}
    local reported_members = {}
    for _, fleet in ipairs(status.fleets or {}) do
      local fleet_id = fleet.fleetId
      reported_fleets[fleet_id] = true
      local record = state.fleets[fleet_id] or { members = {} }
      local previous_members = record.members or {}
      record.name = fleet.name
      record.entryMember = fleet.entryMember
      record.members = {}
      for _, member_info in ipairs(fleet.members or {}) do
        ensure_member(member_info.id, member_info.displayName)
        add_to_order(member_info.id)
        table.insert(record.members, member_info.id)
        reported_members[member_info.id] = true
        state.member_meta[member_info.id] = { fleetId = fleet_id, fleetName = fleet.name }
      end
      -- Remove members this Fleet previously had but no longer reports.
      for _, member_id in ipairs(previous_members) do
        if not reported_members[member_id] then
          reset_member(member_id)
          remove_from_order(member_id)
          if state.selected == member_id then state.selected = 'standard' end
        end
      end
      state.fleets[fleet_id] = record
    end
    -- Remove entire Fleets the host no longer reports.
    for fleet_id, record in pairs(state.fleets) do
      if not reported_fleets[fleet_id] then
        for _, member_id in ipairs(record.members or {}) do
          reset_member(member_id)
          remove_from_order(member_id)
          if state.selected == member_id then state.selected = 'standard' end
        end
        state.fleets[fleet_id] = nil
      end
    end
    for _, member_info in ipairs(status.members or {}) do
      if buffers.get_member(member_info.id) then
        buffers.set_state(member_info.id, member_info.state == 'busy' and 'busy' or 'idle')
      end
    end
    if not buffers.get_member(state.selected) then state.selected = 'standard' end
    if is_ui_open() and buffers.get_member(state.selected) then refresh_member(state.selected) end
    return
  elseif message.type == 'sessions.list' then
    local entries = {}
    for _, session in ipairs(payload.sessions or {}) do
      local summary = session.summary
      if not summary or summary == '' then summary = session.sessionId end
      local activity = session.inUse and '[active elsewhere] ' or ''
      table.insert(entries, {
        display = ('%s%s — %s'):format(
          activity,
          summary,
          relative_age(session.modifiedAgoSeconds)
        ),
        ordinal = table.concat({
          summary,
          session.sessionId or '',
          session.modifiedTime or '',
          session.inUse and 'active in use' or '',
        }, ' '),
        session = session,
      })
    end
    if #entries == 0 then
      notify('No previous Copilot sessions were found for this workspace.', vim.log.levels.INFO)
      return
    end
    local displayed_entries = entries
    if options.frontend.picker == 'telescope' then
      displayed_entries = {}
      for index = #entries, 1, -1 do table.insert(displayed_entries, entries[index]) end
    end
    picker('Resume Copilot session', displayed_entries, function(item, restore_cursor_animation)
      if item.session.inUse then
        if restore_cursor_animation then restore_cursor_animation() end
        notify('That Copilot session is active in another process.', vim.log.levels.WARN)
        return
      end
      state.resume_cursor_animation_restore = restore_cursor_animation
      state.resume_request_id = send('session.resume', { sessionId = item.session.sessionId })
      if not state.resume_request_id then
        restore_resume_cursor_animation()
      elseif restore_cursor_animation then
        vim.defer_fn(function()
          if state.resume_cursor_animation_restore == restore_cursor_animation then
            restore_resume_cursor_animation()
          end
        end, 60000)
      end
    end, {
      preserve_order = true,
      sorting_strategy = 'ascending',
      default_selection_index = #displayed_entries,
      result_limit = #displayed_entries,
      on_complete = function(active_picker)
        if
          active_picker.closed
          or not vim.api.nvim_buf_is_valid(active_picker.results_bufnr)
          or not vim.api.nvim_win_is_valid(active_picker.results_win)
        then
          return
        end
        local row = active_picker:get_row(#displayed_entries)
        local line_count = vim.api.nvim_buf_line_count(active_picker.results_bufnr)
        if row >= 0 and row < line_count then
          active_picker:set_selection(row)
          vim.api.nvim_win_set_cursor(active_picker.results_win, { row + 1, 0 })
        end
      end,
      suppress_cursor_events = true,
    })
    return
  elseif message.type == 'commands.list' then
    local target = payload.target or state.selected
    local available = commands.merge(payload.commands or {}, client_commands())
    state.command_requests[target] = nil
    state.command_catalog_loaded[target] = true
    commands.set_catalog(target, available)
    if payload.purpose ~= 'cache' then show_commands(target, available) end
    return
  elseif message.type == 'model.list' then
    local target = payload.target or event_member(message)
    local model_state = payload.state or {}
    local current = model_state.current or {}
    local current_id = current.modelId
    local entries = {}
    for _, model in ipairs(model_state.models or {}) do
      local id = model_id(model)
      table.insert(entries, {
        display = ('%s%s — %s'):format(
          id == current_id and '🟢 ' or '',
          model_name(model),
          id or 'unknown'
        ),
        ordinal = table.concat({ model_name(model), id or '' }, ' '),
        model = model,
      })
    end
    if #entries == 0 then
      notify('No models are available for this session.', vim.log.levels.INFO)
      return
    end
    picker(('Copilot model — current: %s'):format(current_id or 'unknown'), entries, function(item)
      local id = model_id(item.model)
      if id and id ~= current_id then
        send('model.switch', { target = target, modelId = id })
      end
    end)
    return
  elseif message.type == 'model.changed' then
    local model = payload.model or {}
    local member_id = event_member(message)
    local metrics = state.session_metrics[member_id] or {}
    metrics.model_id = model.modelId or model_id(model) or metrics.model_id
    state.session_metrics[member_id] = metrics
    update_conversation_label(member_id)
    buffers.append_block(
      member_id,
      'conversation',
      'Copilot',
      ('Model switched to `%s`.'):format(model.modelId or model_id(model) or 'unknown')
    )
    return
  elseif message.type == 'session.metrics' then
    local member_id = event_member(message)
    state.session_metrics[member_id] = {
      model_id = payload.modelId,
      aic_used = payload.aicUsed,
    }
    update_conversation_label(member_id)
    return
  elseif message.type == 'mcp.list' then
    local target = payload.target or event_member(message)
    if payload.purpose == 'display' then
      append_mcp_list(target, payload.servers or {})
    else
      select_mcp_server(target, payload.servers or {}, payload.action)
    end
    return
  elseif message.type == 'mcp.show' then
    local server
    for _, candidate in ipairs(payload.servers or {}) do
      if candidate.name == payload.serverName then
        server = candidate
        break
      end
    end
    if not server then
      notify(('MCP server not found: %s'):format(payload.serverName or '?'), vim.log.levels.ERROR)
      return
    end
    buffers.append_block(
      event_member(message),
      'conversation',
      'Copilot',
      ('**MCP server `%s`**\n\n```lua\n%s\n```'):format(server.name, vim.inspect(server))
    )
    return
  elseif message.type == 'mcp.tools' then
    local lines = { ('**Tools from `%s`**'):format(payload.serverName or '?'), '' }
    for _, tool in ipairs(payload.tools or {}) do
      table.insert(lines, ('- `%s` — %s'):format(tool.name or '?', tool.description or ''))
    end
    if #lines == 2 then table.insert(lines, '_No tools are currently exposed._') end
    buffers.append_block(event_member(message), 'conversation', 'Copilot', table.concat(lines, '\n'))
    return
  elseif message.type == 'mcp.changed' then
    local status = payload.enabled and 'enabled' or 'disabled'
    local server
    for _, candidate in ipairs(payload.state and payload.state.servers or {}) do
      if candidate.name == payload.serverName then
        server = candidate
        break
      end
    end
    if server then
      update_environment(
        event_member(message),
        'MCP ' .. (server.name or payload.serverName),
        server.status == 'failed' and 'failed' or 'completed',
        server.status or status
      )
    end
    buffers.append_block(
      event_member(message),
      'conversation',
      'Copilot',
      ('MCP server `%s` %s.'):format(payload.serverName or '?', status)
    )
    return
  elseif message.type == 'mcp.reloaded' then
    buffers.append_block(
      event_member(message),
      'conversation',
      'Copilot',
      ('Reloaded %d MCP server%s.'):format(
        tonumber(payload.serverCount) or 0,
        tonumber(payload.serverCount) == 1 and '' or 's'
      )
    )
    return
  elseif message.type == 'command.result' then
    local member_id = event_member(message)
    local result = payload.result or {}
    local result_text = result.text or result.content
    if result.kind == 'text' and result_text and result_text ~= '' then
      buffers.append_block(member_id, 'conversation', 'Copilot', result_text)
    elseif result.kind == 'completed' and result.message and result.message ~= '' then
      buffers.append_block(member_id, 'conversation', 'Copilot', result.message)
    elseif result.kind == 'agent-prompt' and result.notice and result.notice ~= '' then
      buffers.append_activity_block(member_id, '/' .. (payload.name or 'command'), result.notice)
    elseif result.kind == 'select-subcommand' then
      local entries = {}
      for _, option in ipairs(result.options or {}) do
        table.insert(entries, {
          display = ('%s — %s'):format(option.name, option.description),
          ordinal = option.name .. ' ' .. option.description,
          option = option,
        })
      end
      picker(result.title or ('/' .. result.command), entries, function(item)
        invoke_command(payload.target or member_id, result.command, item.option.name)
      end)
    end
    return
  elseif message.type == 'tasks.list' then
    local target = payload.target or event_member(message)
    if payload.purpose == 'refresh' then
      merge_tasks(target, payload.tasks or {})
      return
    end
    if payload.purpose == 'select' then
      merge_tasks(target, payload.tasks or {})
      local entries = {}
      for _, task in ipairs(state.tasks[target] or {}) do
        table.insert(entries, {
          display = ('%s [%s] %s'):format(
            buffers.status_symbol(task.status),
            task.type or 'task',
            task_description(task)
          ),
          ordinal = table.concat({
            task.status or '',
            task.type or '',
            task_description(task),
            task.id or '',
          }, ' '),
          task = task,
        })
      end
      if #entries == 0 then
        notify(('No tracked tasks for %s.'):format(target))
      else
        picker(('Copilot tasks — %s'):format(target), entries, function(item)
          show_task(item.task, target)
        end)
      end
      return
    end
    local active = {}
    for _, task in ipairs(payload.tasks or {}) do
      if task.status == 'running' or task.status == 'idle' then
        local detail = task.type == 'shell' and task.command
          or task.description
          or task.prompt
          or task.id
        table.insert(active, {
          display = ('Cancel [%s] %s — %s'):format(task.status, task.type, detail),
          ordinal = table.concat({ task.status, task.type, detail, task.id }, ' '),
          task = task,
        })
      end
    end
    if #active == 0 then
      notify(('No active background tasks for %s.'):format(payload.target or state.selected))
      return
    end
    picker(('Cancel background task — %s'):format(payload.target or state.selected), active, function(item)
      send('tasks.cancel', {
        target = payload.target or state.selected,
        taskId = item.task.id,
      })
    end)
    return
  elseif message.type == 'tasks.cancelled' then
    if payload.cancelled then
      local target = payload.target or event_member(message)
      for _, task in ipairs(state.tasks[target] or {}) do
        if task.id == payload.taskId then
          merge_tasks(target, {
            {
              id = task.id,
              status = 'cancelled',
            },
          })
        end
      end
      notify(('Cancelled background task %s.'):format(payload.taskId or ''))
    else
      notify(
        ('Background task %s is no longer cancellable.'):format(payload.taskId or ''),
        vim.log.levels.WARN
      )
    end
    return
  elseif message.type == 'tasks.changed' then
    merge_tasks(event_member(message), payload.tasks or {})
    if state.task_detail then render_task_detail() end
    if state.status_buf and vim.api.nvim_buf_is_valid(state.status_buf) then
      update_status_buffer()
    end
    return
  elseif message.type == 'tasks.progress' then
    if type(state.task_detail) == 'table' and state.task_detail.id == payload.taskId then
      state.task_progress = type(payload.progress) == 'table' and payload.progress or nil
      state.task_progress_loaded = true
      render_task_detail()
    end
    return
  elseif message.type == 'tasks.error' then
    buffers.append_activity_block(
      event_member(message),
      'Task status error',
      payload.message or 'Could not refresh task status'
    )
    return
  elseif message.type == 'background.cancelled' then
    notify(('Cancelled %d background agent(s).'):format(payload.count or 0))
    return
  elseif message.type == 'environment.progress' then
    local component = payload.component or 'Environment'
    local member_id = event_member(message)
    buffers.set_state(member_id, 'loading')
    update_environment(member_id, component, 'running', payload.message or 'Loading...')
    return
  elseif message.type == 'environment.loaded' then
    local component = payload.component or 'Environment'
    local items = payload.items or {}
    local detail = ('%d loaded'):format(#items)
    if component == 'MCP servers' then
      local member_id = event_member(message)
      remove_environment(member_id, component)
      local current = {}
      for _, server in ipairs(items) do
        local server_component = 'MCP ' .. (server.name or 'unknown')
        current[server_component] = true
        local status = server.status or 'unknown'
        local row_status = status == 'failed' and 'failed'
          or status == 'disabled' and 'cancelled'
          or (status == 'pending' or status == 'connecting' or status == 'starting') and 'running'
          or 'completed'
        update_environment(member_id, server_component, row_status, status)
      end
      local environment = state.environment[member_id]
      for name in pairs(vim.deepcopy(environment and environment.components or {})) do
        if name:find('^MCP ') and not current[name] then remove_environment(member_id, name) end
      end
      return
    end
    update_environment(event_member(message), component, 'completed', detail)
    return
  elseif message.type == 'environment.error' then
    local member_id = event_member(message)
    local component = payload.component or 'Environment'
    local detail = payload.message or 'Loading failed'
    update_environment(member_id, component, 'failed', detail)
    return
  elseif message.type == 'environment.status' then
    local detail = payload.status or 'unknown'
    if payload.error and payload.error ~= '' then detail = detail .. ': ' .. payload.error end
    local row_status = 'completed'
    if
      payload.status == 'pending'
      or payload.status == 'connecting'
      or payload.status == 'starting'
    then
      row_status = 'running'
    elseif payload.status == 'disabled' or payload.status == 'stopped' then
      row_status = 'cancelled'
    elseif
      payload.status == 'failed'
      or payload.status == 'error'
      or (payload.error and payload.error ~= '')
    then
      row_status = 'failed'
    end
    update_environment(
      event_member(message),
      payload.component or 'Environment',
      row_status,
      detail
    )
    return
  elseif message.type == 'session.recreated' then
    buffers.append_activity_block(
      event_member(message),
      'Session recovery',
      payload.message or 'Empty session recreated'
    )
    return
  elseif message.type == 'request.error' or message.type == 'protocol.error' then
    if state.prompt_calls[message.requestId] then
      fail_prompt(message.requestId, payload.message)
    end
    if message.requestId and message.requestId == state.resume_request_id then
      restore_resume_cursor_animation()
    end
    notify(payload.message or 'Native Copilot request failed.', vim.log.levels.ERROR)
    return
  elseif message.type == 'fleet.requested' then
    buffers.append_activity_block(
      'standard',
      'Fleet requested',
      ('%s will start alongside Standard when the current turn becomes idle.'):format(
        payload.fleetId or 'Fleet'
      )
    )
    return
  elseif message.type == 'standard.ready' then
    close_task_detail()
    state.mode = 'standard'
    add_to_order('standard')
    ensure_member('standard', payload.displayName or 'Copilot')
    buffers.set_state('standard', 'idle')
    if not buffers.get_member(state.selected) then state.selected = 'standard' end
    if protocol.is_running() then send('hello') end
    if is_ui_open() and buffers.get_member(state.selected) then
      M.show_member(state.selected)
      focus_prompt()
    end
    restore_resume_cursor_animation(100)
    return
  elseif message.type == 'session.loading' then
    -- Only the Standard session is reloaded; concurrent Fleets are untouched.
    close_task_detail()
    reset_member('standard', true)
    state.mode = 'standard-loading'
    add_to_order('standard')
    ensure_member('standard', 'Copilot')
    buffers.set_state('standard', 'loading')
    state.selected = 'standard'
    if is_ui_open() then refresh_member('standard') end
    return
  elseif message.type == 'fleet.loading' then
    local fleet_id = payload.fleetId
    state.fleets[fleet_id] = {
      name = payload.name,
      entryMember = payload.entryMember,
      recovered = payload.recovered,
      members = {},
    }
    local connecting = {}
    for _, member_id in ipairs(payload.connectingMembers or {}) do connecting[member_id] = true end
    for _, member_info in ipairs(payload.members or {}) do
      ensure_member(member_info.id, member_info.displayName)
      add_to_order(member_info.id)
      table.insert(state.fleets[fleet_id].members, member_info.id)
      state.member_meta[member_info.id] = { fleetId = fleet_id, fleetName = payload.name }
      buffers.set_state(member_info.id, connecting[member_info.id] and 'loading' or 'standby')
    end
    if payload.entryMember and buffers.get_member(payload.entryMember) then
      buffers.append_activity_block(
        payload.entryMember,
        payload.recovered and 'Recovering Fleet' or 'Starting Fleet',
        ('Connecting %d of %d configured members...'):format(
          #(payload.connectingMembers or {}),
          #(payload.members or {})
        )
      )
    end
    if is_ui_open() and not buffers.get_member(state.selected) then
      state.selected = payload.entryMember or state.selected
      if buffers.get_member(state.selected) then refresh_member(state.selected) end
    end
    return
  elseif message.type == 'fleet.ready' then
    local fleet_id = payload.fleetId
    local fleet = state.fleets[fleet_id] or { members = {} }
    fleet.name = payload.name
    fleet.entryMember = payload.entryMember
    fleet.recovered = payload.recovered
    fleet.members = {}
    for _, member_info in ipairs(payload.members or {}) do
      ensure_member(member_info.id, member_info.displayName)
      add_to_order(member_info.id)
      table.insert(fleet.members, member_info.id)
      state.member_meta[member_info.id] = { fleetId = fleet_id, fleetName = payload.name }
    end
    state.fleets[fleet_id] = fleet
    if is_ui_open() and buffers.get_member(state.selected) then refresh_member(state.selected) end
    return
  elseif message.type == 'fleet.updated' then
    local fleet_id = payload.fleetId
    local fleet = state.fleets[fleet_id]
    if not fleet then return end
    for _, member_id in ipairs(payload.removed or {}) do
      reset_member(member_id)
      remove_from_order(member_id)
      if state.selected == member_id then
        state.selected = 'standard'
        if is_ui_open() and buffers.get_member('standard') then refresh_member('standard') end
      end
    end
    for _, member_info in ipairs(payload.added or {}) do
      ensure_member(member_info.id, member_info.displayName)
      add_to_order(member_info.id)
      state.member_meta[member_info.id] = { fleetId = fleet_id, fleetName = fleet.name }
    end
    for _, member_info in ipairs(payload.updated or {}) do
      ensure_member(member_info.id, member_info.displayName)
      state.member_meta[member_info.id] = { fleetId = fleet_id, fleetName = fleet.name }
    end
    fleet.entryMember = payload.entryMember or fleet.entryMember
    fleet.members = {}
    for _, member_info in ipairs(payload.members or {}) do
      table.insert(fleet.members, member_info.id)
    end
    return
  elseif message.type == 'fleet.stopped' then
    local fleet_id = payload.fleetId
    for _, member_id in ipairs(payload.members or {}) do
      reset_member(member_id)
      remove_from_order(member_id)
      if state.selected == member_id then state.selected = 'standard' end
    end
    state.fleets[fleet_id] = nil
    if not buffers.get_member(state.selected) then state.selected = 'standard' end
    if is_ui_open() and buffers.get_member(state.selected) then refresh_member(state.selected) end
    return
  elseif message.type == 'fleet.error' then
    buffers.append_activity_block(
      'standard',
      'Fleet error',
      ('%s: %s'):format(payload.fleetId or 'Fleet', payload.message or 'startup failed')
    )
    return
  elseif message.type == 'fleet.agent.updated' then
    notify(('Fleet %s: %s %s'):format(
      payload.fleetId or '?',
      payload.action or 'updated',
      payload.agentId or ''
    ))
    return
  elseif message.type == 'fleet.agent.moved' then
    notify(('Moved %s from Fleet %s to Fleet %s%s'):format(
      payload.agentId or '?',
      payload.sourceFleetId or '?',
      payload.destinationFleetId or '?',
      payload.sessionPreserved and ' (history preserved)' or ''
    ))
    return
  end

  local member_id = event_member(message)
  local entry = ensure_member(member_id)
  if message.type == 'session.history' then
    local first_event = type(payload.events) == 'table' and payload.events[1] or nil
    local first_timestamp = first_event and tonumber(json_value(first_event.replayTimestamp))
    buffers.prepare_history(
      member_id,
      first_timestamp and math.floor(first_timestamp / 1000) or nil
    )
    local context = {
      permissions = {},
      agent_messages = {},
      agent_tool_prompts = {},
      tool_arguments = {},
    }
    for _, event in ipairs(payload.events or {}) do history_event(member_id, event, context) end
    finish_history_context(member_id, context)
  elseif message.type == 'scheduled.prompt' then
    local content = payload.displayPrompt or payload.content or 'Scheduled prompt'
    local schedule_id = json_value(payload.scheduleId)
      or tostring(json_value(payload.source) or ''):match('^schedule%-(.+)$')
      or '?'
    update_schedule(
      member_id,
      schedule_id,
      'fired',
      payload,
      payload.eventId or message.id
    )
    buffers.append_block(member_id, 'conversation', 'You', content)
    buffers.begin_response(member_id, 'scheduled:' .. tostring(payload.eventId or message.id))
  elseif message.type == 'prompt.queued' then
    -- Runtime acknowledgement; locally queued prompts are not sent until they reach the FIFO head.
  elseif message.type == 'prompt.failed' then
    fail_prompt(tostring(payload.id or message.id), payload.message)
  elseif message.type == 'schedule.created' then
    update_schedule(member_id, payload.id, 'created', payload, message.id)
  elseif message.type == 'schedule.cancelled' then
    update_schedule(member_id, payload.id, 'cancelled', payload, message.id)
  elseif message.type == 'schedule.rearmed' then
    update_schedule(member_id, payload.id, 'rearmed', {
      nextRunAt = payload.nextRunAt
        and os.date('%Y-%m-%d %H:%M:%S', math.floor(payload.nextRunAt / 1000))
        or nil,
    }, message.id)
  elseif message.type == 'prompt.accepted' then
    -- The user turn is rendered immediately on submission so queued work is visible without delay.
  elseif message.type == 'conversation.delta' then
    buffers.append_conversation_delta(member_id, payload.messageId or message.id, payload.content or '')
  elseif message.type == 'conversation.message' then
    buffers.complete_conversation(
      member_id,
      payload.messageId or message.id,
      payload.content or ''
    )
  elseif message.type == 'activity.delta' then
    buffers.append_activity_delta(member_id, payload.reasoningId or message.id, payload.content or '')
  elseif message.type == 'activity.reasoning' then
    buffers.complete_activity(
      member_id,
      payload.reasoningId or message.id,
      payload.content or ''
    )
  elseif message.type == 'system.notification' then
    local event_timestamp = tonumber(json_value(payload.eventTimestamp))
    history_notification(
      member_id,
      {
        id = payload.eventId or message.id,
        data = payload,
      },
      event_timestamp and math.floor(event_timestamp / 1000) or nil
    )
  elseif message.type == 'activity.event' then
    local event_type = payload.eventType or 'activity'
    local data = type(payload.data) == 'table' and payload.data or {}
    if event_type == 'tool.execution_start' then
      local call_id = data.toolCallId or message.id
      local tool_name = data.toolName or data.mcpToolName or 'tool'
      update_tool_call(member_id, call_id, tool_name, 'running', {
        arguments = data.arguments,
      })
    elseif event_type == 'tool.execution_complete' then
      local call_id = data.toolCallId or message.id
      local activity = state.tool_calls[member_id]
      local existing = activity and activity.items[call_id]
      update_tool_call(
        member_id,
        call_id,
        existing and existing.name or 'tool',
        data.success == true and 'completed' or 'failed',
        {
          result = json_value(data.result),
          error = json_value(data.error),
        }
      )
      local linked_task_settled = data.success ~= true
        and settle_linked_task(member_id, data, existing, 'failed')
        or false
      if linked_task_settled and type(state.task_detail) == 'table' then
        render_task_detail()
      end
    else
      local detail = data.intent or data.message or vim.inspect(data)
      buffers.append_activity_block(member_id, event_type, tostring(detail))
    end
  elseif message.type == 'permission.requested' then
    request_permission(payload, member_id)
  elseif message.type == 'member.error' then
    buffers.append_activity_block(member_id, 'Error', payload.message or vim.inspect(payload))
    buffers.set_state(member_id, 'error')
  elseif message.type == 'member.foreground_idle' then
    finish_foreground_turn(member_id)
  elseif message.type == 'member.state' then
    local member_state = payload.state or 'unknown'
    buffers.set_state(member_id, member_state)
    if member_state == 'busy' then
      buffers.begin_response(member_id, payload.turnId or message.id)
    elseif member_state == 'idle' then
      local environment = state.environment[member_id]
      local startup = environment and environment.components['Copilot environment']
      if startup and startup.status == 'running' then
        update_environment(member_id, 'Copilot environment', 'completed', 'ready')
      end
    end
  elseif message.type == 'mailbox.queued' or message.type == 'mailbox.delivered' then
    buffers.append_block(
      member_id,
      'messages',
      message.type == 'mailbox.queued' and 'Sent' or 'Received',
      ('**%s → %s**\n\n%s'):format(payload.source or '?', payload.target or '?', payload.content or '')
    )
  elseif message.type == 'mailbox.failed' then
    buffers.append_block(member_id, 'messages', 'Delivery failed', payload.message or 'Unknown error')
  end

  if update_status_buffer and state.status_buf and vim.api.nvim_buf_is_valid(state.status_buf) then
    update_status_buffer()
  end
  if entry and message.target == 'conversation' and message.done then
    buffers.increment_unread(member_id)
  end
end

function M.setup(user_options)
  options = vim.tbl_deep_extend('force', vim.deepcopy(defaults), user_options or {})
  buffers.setup({
    stream_flush_ms = options.stream_flush_ms,
    follow_bottom = options.follow_bottom,
    bottom_padding = options.bottom_padding,
    timestamp_format = options.timestamp_format,
    conversation = options.conversation,
  })
  vim.keymap.set('n', options.mappings.toggle, M.toggle, {
    desc = 'Toggle native Copilot',
  })
  vim.keymap.set('n', options.mappings.fleet, M.select_fleet, {
    desc = 'Select or stop Copilot Fleet',
  })
  vim.keymap.set('n', options.mappings.select, M.select, {
    desc = 'Select Copilot mode, agent, or view',
  })
  vim.api.nvim_create_user_command('NativeCopilotToggle', M.toggle, {})
  vim.api.nvim_create_user_command('NativeCopilotSelect', M.select_fleet, {})
  vim.api.nvim_create_user_command('NativeCopilotAgents', M.select, {})
  vim.api.nvim_create_user_command('NativeCopilotStatus', M.show_status, {})
  vim.api.nvim_create_user_command('NativeCopilotTasks', M.select_task, {})
  vim.api.nvim_create_user_command('NativeCopilotAbort', M.abort, {})
  vim.api.nvim_create_user_command('NativeCopilotCancelBackground', M.cancel_background, {})
  vim.api.nvim_create_user_command('NativeCopilotReloadMcp', M.reload_mcp, {})
  vim.api.nvim_create_autocmd('BufWinEnter', {
    callback = function(args) buffers.on_shown(args.buf) end,
  })
  vim.api.nvim_create_autocmd({ 'CursorMoved', 'WinScrolled' }, {
    callback = function(args)
      local win = args.event == 'WinScrolled' and tonumber(args.match) or nil
      if not win or not vim.api.nvim_win_is_valid(win) then
        win = vim.api.nvim_get_current_win()
      end
      buffers.on_view_moved(win)
    end,
  })
  vim.api.nvim_create_autocmd('TabClosed', {
    callback = function()
      if state.tab and not vim.api.nvim_tabpage_is_valid(state.tab) then
        state.tab = nil
        state.main_win = nil
        state.prompt_win = nil
        state.overview = false
        restore_compact_ui_options()
      end
    end,
  })
  vim.api.nvim_create_autocmd('VimLeavePre', {
    callback = function() protocol.stop_sync(5500) end,
  })
end

function M.shutdown()
  protocol.stop_sync(5500)
end

return M
