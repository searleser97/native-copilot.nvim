local protocol = require('native_copilot.protocol')
local buffers = require('native_copilot.buffers')
local commands = require('native_copilot.commands')

local M = {}
local data_root = vim.fn.stdpath('data')
local default_database = data_root .. '/native-copilot/state.sqlite'

local function client_commands(fleets)
  local choices = {}
  for _, fleet in ipairs(fleets or {}) do
    if fleet.valid then
      table.insert(choices, { name = fleet.id, description = fleet.description })
    end
  end
  return {
    {
      name = 'fleet',
      description = 'Start or recover a configured multi-session Copilot Fleet',
      kind = 'client',
      input = { hint = 'fleet id', choices = choices },
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
  }
end

local defaults = {
  node_command = 'node',
  runtime_command = vim.env.NVIM_COPILOT_CMD or vim.env.COPILOT_CLI_CMD,
  config_path = vim.fn.stdpath('config') .. '/copilot/fleets.json',
  database_path = default_database,
  workspace = nil,
  prompt_height = 8,
  task_detail_height = 12,
  overview_max_agents = 4,
  render_debounce_ms = 200,
  stream_flush_ms = 80,
  follow_bottom = true,
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
  prompt_buf = nil,
  task_detail = nil,
  task_progress = nil,
  task_detail_buf = nil,
  task_detail_win = nil,
  task_detail_member = nil,
  detail_item = nil,
  status_buf = nil,
  selected = 'standard',
  mode = 'stopped',
  active_fleet = nil,
  member_order = { 'standard' },
  tasks = {},
  environment = {},
  fleets = {},
  recoverable_fleets = {},
  overview = false,
  configured_buffers = {},
  command_requests = {},
  permission_queue = {},
  permission_prompt_open = false,
  tool_calls = {},
  prompt_calls = {},
  prompt_queues = {},
  active_prompts = {},
  schedules = {},
}

local function notify(message, level)
  vim.notify(message, level or vim.log.levels.INFO, { title = 'Native Copilot' })
end

local function is_ui_open()
  return state.tab and vim.api.nvim_tabpage_is_valid(state.tab)
end

local function current_workspace()
  return options.workspace or vim.uv.cwd()
end

local function ensure_default_config()
  if vim.fn.filereadable(options.config_path) == 1 then return true end
  local source = debug.getinfo(1, 'S').source:sub(2)
  local root = vim.fs.dirname(vim.fs.dirname(vim.fs.dirname(source)))
  local example = root .. '/examples/fleets.json'
  if vim.fn.filereadable(example) ~= 1 then
    notify('Default Fleet configuration template is missing.', vim.log.levels.ERROR)
    return false
  end
  vim.fn.mkdir(vim.fs.dirname(options.config_path), 'p')
  local ok, err = vim.uv.fs_copyfile(example, options.config_path)
  if not ok then
    notify(('Could not create %s: %s'):format(options.config_path, err), vim.log.levels.ERROR)
    return false
  end
  notify('Created editable Fleet configuration at ' .. options.config_path)
  return true
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

local function update_prompt_call(request_id, status, detail)
  local call = state.prompt_calls[request_id]
  if not call then return end
  call.status = status
  buffers.upsert_timeline(call.member_id, 'prompt:' .. request_id, {
    kind = 'prompt',
    label = 'Prompt',
    status = status,
    detail = detail or status,
  })
end

local function track_prompt(member_id, request_id, status)
  if not request_id then return end
  state.prompt_calls[request_id] = {
    member_id = member_id,
    status = status,
  }
  if status == 'running' then
    state.active_prompts[member_id] = state.active_prompts[member_id] or {}
    table.insert(state.active_prompts[member_id], request_id)
  else
    state.prompt_queues[member_id] = state.prompt_queues[member_id] or {}
    table.insert(state.prompt_queues[member_id], request_id)
  end
  update_prompt_call(request_id, status, status == 'running' and 'processing…' or 'queued')
end

local function start_next_prompt(member_id)
  if #(state.active_prompts[member_id] or {}) > 0 then return end
  local queue = state.prompt_queues[member_id] or {}
  local request_id = table.remove(queue, 1)
  if not request_id then return end
  state.active_prompts[member_id] = { request_id }
  update_prompt_call(request_id, 'running', 'processing…')
end

local function complete_active_prompt(member_id)
  local request_ids = state.active_prompts[member_id] or {}
  if #request_ids == 0 then return end
  for _, request_id in ipairs(request_ids) do
    update_prompt_call(request_id, 'completed', 'completed')
  end
  state.active_prompts[member_id] = nil
  start_next_prompt(member_id)
end

local function fail_prompt(request_id, detail)
  local call = state.prompt_calls[request_id]
  if not call then return end
  local member_id = call.member_id
  for index = #(state.prompt_queues[member_id] or {}), 1, -1 do
    if state.prompt_queues[member_id][index] == request_id then
      table.remove(state.prompt_queues[member_id], index)
    end
  end
  for index = #(state.active_prompts[member_id] or {}), 1, -1 do
    if state.active_prompts[member_id][index] == request_id then
      table.remove(state.active_prompts[member_id], index)
    end
  end
  update_prompt_call(request_id, 'failed', detail or 'failed')
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

local function update_schedule(member_id, schedule_id, updates)
  local key = member_id .. ':' .. tostring(schedule_id)
  local schedule = vim.tbl_deep_extend('force', state.schedules[key] or {}, updates or {})
  state.schedules[key] = schedule
  buffers.upsert_timeline(member_id, 'schedule:' .. tostring(schedule_id), {
    kind = 'schedule',
    label = ('Schedule #%s'):format(schedule_id),
    status = schedule.status or 'idle',
    detail = schedule.detail or schedule_description(schedule),
    details = {
      prompt = schedule.displayPrompt or schedule.prompt,
      schedule = schedule_description(schedule),
      nextRunAt = schedule.nextRunAt,
    },
  })
end

local function submit_prompt()
  local content = vim.trim(table.concat(prompt_lines(), '\n'))
  if content == '' then
    notify('The prompt is empty.', vim.log.levels.WARN)
    return
  end
  if state.mode == 'fleet' and not buffers.get_member(state.selected) then
    notify('Select a fleet member before sending.', vim.log.levels.WARN)
    return
  end
  set_prompt_lines({ '' })
  local command = commands.parse(content)
  if command then
    buffers.append_block(state.selected, 'conversation', 'You', content)
    if command.name:lower() == 'tasks' then
      M.select_task()
      return
    elseif command.name:lower() == 'fleet' then
      if command.input then
        M.start_fleet(command.input)
      else
        M.select_fleet()
      end
      return
    elseif command.name:lower() == 'resume' then
      if command.input then
        send('session.resume', { sessionId = command.input })
      else
        send('sessions.list')
      end
      return
    elseif command.name:lower() == 'mcp-reload' then
      send('mcp.reload', { target = state.selected })
      return
    end
    invoke_command(state.selected, command.name, command.input)
  else
    buffers.append_block(state.selected, 'conversation', 'You', content)
    local request_id = send('prompt.send', { target = state.selected, content = content })
    track_prompt(state.selected, request_id, 'idle')
  end
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
  vim.bo[buf].filetype = 'markdown'
  vim.b[buf].ai_prompt = true
  vim.b[buf].native_copilot_prompt = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, { '' })
  vim.keymap.set('n', '<CR>', submit_prompt, {
    buffer = buf,
    desc = 'Send prompt to selected Copilot',
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

local task_symbols = {
  running = '○',
  idle = '○',
  completed = '✓',
  failed = '✗',
  cancelled = '–',
}

local function task_description(task)
  local detail = task.description or task.command or task.prompt or task.id
  return tostring(detail):gsub('[\r\n]+', ' ')
end

local function task_at_cursor()
  local item, member_id = buffers.timeline_item_at_cursor(
    vim.api.nvim_get_current_buf(),
    vim.api.nvim_win_get_cursor(0)[1]
  )
  return item, member_id
end

local function update_tool_call(member_id, call_id, tool_name, status, details)
  local activity = state.tool_calls[member_id]
  if not activity then
    activity = { order = {}, items = {} }
    state.tool_calls[member_id] = activity
  end
  local item = activity.items[call_id]
  if not item then
    item = {
      id = call_id,
      name = tool_name,
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
  buffers.upsert_timeline(member_id, 'tool:' .. call_id, {
    kind = 'tool',
    label = item.name,
    status = status,
    detail = status == 'running' and 'processing…' or status,
    details = item.details,
  })

  while #activity.order > 20 do
    local oldest = table.remove(activity.order, 1)
    activity.items[oldest] = nil
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

  if component ~= 'Copilot environment' and environment.components['Copilot environment'] then
    environment.components['Copilot environment'] = nil
    buffers.remove_timeline(member_id, 'environment:Copilot environment')
    for index, name in ipairs(environment.order) do
      if name == 'Copilot environment' then
        table.remove(environment.order, index)
        break
      end
    end
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
  local current = state.tasks[member_id] or {}
  local by_id = {}
  for _, task in ipairs(current) do by_id[task.id] = task end
  for _, task in ipairs(incoming or {}) do
    if by_id[task.id] then
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
    buffers.upsert_timeline(member_id, 'task:' .. task.id, {
      kind = 'task',
      label = ('[%s] %s'):format(current_task.type or 'task', task_description(current_task)),
      status = current_task.status or 'idle',
      task = current_task,
    })
  end
  state.tasks[member_id] = current
  if state.task_detail and state.task_detail.id and by_id[state.task_detail.id] then
    state.task_detail = by_id[state.task_detail.id]
  end
end

local function cancel_cursor_task()
  local item, member_id = task_at_cursor()
  local task = item and item.kind == 'task' and item.task or nil
  if not task and state.task_detail then
    task = state.task_detail
    member_id = state.task_detail_member
  end
  if not task then return end
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
  state.task_detail_member = nil
  state.detail_item = nil
end

local function render_task_detail()
  local buf = state.task_detail_buf
  local item = state.detail_item
  local task = state.task_detail
  if not buf or not vim.api.nvim_buf_is_valid(buf) or not item then return end
  local progress = state.task_progress
  local lines
  if item.kind == 'task' and task then
    lines = {
      ('%s [%s] %s'):format(
        task_symbols[task.status] or '?',
        task.type or 'task',
        task_description(task)
      ),
      ('Status: %s'):format(task.status or 'unknown'),
      ('ID: %s'):format(task.id or 'unknown'),
      '',
    }
    if not progress then
      table.insert(lines, 'Loading task progress...')
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
        task_symbols[item.status] or '?',
        item.kind or 'activity',
        item.label or 'Activity'
      ),
      ('Status: %s'):format(item.status or 'unknown'),
      '',
    }
    local details = item.details or {}
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
      if field[2] ~= nil and field[2] ~= '' then
        populated = true
        table.insert(lines, field[1] .. ':')
        vim.list_extend(lines, vim.split(vim.inspect(field[2]), '\n', { plain = true }))
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
  vim.bo[buf].filetype = 'markdown'
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
  local width = math.max(40, math.min(100, vim.o.columns - 8))
  local height = math.max(6, math.min(options.task_detail_height, vim.o.lines - 6))
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
  if not task then return end
  state.task_detail = task
  state.task_progress = nil
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

local function cycle_member(step)
  local members = ordered_members()
  if #members == 0 then return end
  local index = 1
  for candidate, member_id in ipairs(members) do
    if member_id == state.selected then
      index = candidate
      break
    end
  end
  index = ((index - 1 + step) % #members) + 1
  M.show_member(members[index])
end

local function configure_agent_buffer(member_id, buf)
  if state.configured_buffers[buf] then return end
  state.configured_buffers[buf] = true
  vim.keymap.set('n', '[a', function() cycle_member(-1) end, {
    buffer = buf,
    desc = 'Previous Copilot member',
  })
  vim.keymap.set('n', ']a', function() cycle_member(1) end, {
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
  local keep
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(state.tab)) do
    if vim.api.nvim_win_get_buf(win) == state.prompt_buf then
      prompt_win = win
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
      and vim.api.nvim_win_is_valid(win)
    then
      pcall(vim.api.nvim_win_close, win, true)
    end
  end
  state.main_win = keep
  state.prompt_win = prompt_win
  return keep
end

local function ensure_ui()
  if is_ui_open() then
    vim.api.nvim_set_current_tabpage(state.tab)
    return
  end
  vim.cmd('tabnew')
  state.tab = vim.api.nvim_get_current_tabpage()
  state.main_win = vim.api.nvim_get_current_win()
  local entry = ensure_member(state.selected, state.selected == 'standard' and 'Copilot' or nil)
  vim.api.nvim_win_set_buf(state.main_win, entry.views.conversation.buf)
  vim.cmd('botright split')
  state.prompt_win = vim.api.nvim_get_current_win()
  vim.api.nvim_win_set_buf(state.prompt_win, ensure_prompt_buffer())
  vim.api.nvim_win_set_height(state.prompt_win, options.prompt_height)
  vim.wo[state.prompt_win].winfixheight = true
  update_prompt_label()
  vim.api.nvim_set_current_win(state.prompt_win)
end

local function start_host()
  if protocol.is_running() then return true end
  if not ensure_default_config() then return false end
  return protocol.start({
    node_command = options.node_command,
    runtime_command = options.runtime_command,
    config_path = options.config_path,
    database_path = options.database_path,
    workspace = current_workspace(),
  }, M._on_event)
end

function M.open()
  if not start_host() then return end
  ensure_ui()
  send('hello')
  if state.mode == 'stopped' then send('mode.standard') end
end

function M.close()
  if not is_ui_open() then return end
  close_task_detail()
  vim.api.nvim_set_current_tabpage(state.tab)
  vim.cmd('tabclose')
  state.tab = nil
  state.main_win = nil
  state.prompt_win = nil
  state.overview = false
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
  vim.api.nvim_win_set_buf(win, entry.views[view_id or 'conversation'].buf)
  buffers.mark_read(member_id)
  update_prompt_label()
  vim.api.nvim_set_current_win(win)
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
  vim.api.nvim_win_set_buf(first, buffers.buffer(members[1], 'conversation'))
  for index = 2, maximum do
    vim.cmd('rightbelow vsplit')
    vim.api.nvim_win_set_buf(0, buffers.buffer(members[index], 'conversation'))
  end
  vim.cmd('wincmd =')
  update_prompt_label()
end

local function update_status_buffer()
  if not state.status_buf or not vim.api.nvim_buf_is_valid(state.status_buf) then
    state.status_buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_name(state.status_buf, 'native-copilot://status')
    vim.bo[state.status_buf].buftype = 'nofile'
    vim.bo[state.status_buf].bufhidden = 'hide'
    vim.bo[state.status_buf].swapfile = false
    vim.bo[state.status_buf].filetype = 'markdown'
    vim.b[state.status_buf].native_copilot = true
  end
  local lines = {
    '# Native Copilot Status',
    '',
    ('- **Mode:** %s'):format(state.mode),
    ('- **Fleet:** %s'):format(state.active_fleet or 'none'),
    ('- **Selected recipient:** %s'):format(state.selected),
    '',
    '| Member | State | Unread |',
    '|---|---:|---:|',
  }
  for _, member_id in ipairs(ordered_members()) do
    local entry = buffers.get_member(member_id)
    table.insert(lines, ('| %s | %s | %d |'):format(entry.display_name, entry.state, entry.unread))
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

local function picker(title, entries, choose)
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

  local pickers = require('telescope.pickers')
  local finders = require('telescope.finders')
  local actions = require('telescope.actions')
  local action_state = require('telescope.actions.state')
  local conf = require('telescope.config').values
  pickers.new({}, {
    prompt_title = title,
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
    sorter = conf.generic_sorter({}),
    attach_mappings = function(prompt_buf)
      actions.select_default:replace(function()
        local selection = action_state.get_selected_entry()
        actions.close(prompt_buf)
        if selection then choose(selection.value) end
      end)
      return true
    end,
  }):find()
end

local function permission_detail(request)
  if request.kind == 'shell' then
    return request.fullCommandText or table.concat(request.commands or {}, ' ')
  end
  return request.path
    or request.url
    or request.toolName
    or request.fileName
    or request.factoryId
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
    send('permission.respond', {
      requestId = pending.requestId,
      approved = item ~= nil and item.approved == true,
    })
    state.permission_prompt_open = false
    vim.schedule(show_next_permission)
  end)
end

local function request_permission(payload, member_id)
  table.insert(state.permission_queue, payload)
  buffers.append_activity_block(
    member_id,
    'Permission',
    ('Approval required for `%s`: %s'):format(
      payload.request and payload.request.kind or 'tool',
      tostring(permission_detail(payload.request or {}))
    )
  )
  show_next_permission()
end

function M.select_commands()
  if not start_host() then return end
  ensure_ui()
  send('commands.list', { target = state.selected, purpose = 'browse' })
end

function M.ensure_commands(target)
  if not target or commands.catalog(target) or state.command_requests[target] then return end
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
          entry.display_name,
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
  if vim.tbl_isempty(state.fleets) then
    send('hello')
    notify('Fleet profiles are loading.', vim.log.levels.INFO)
    return
  end
  local entries = {}
  if state.mode == 'fleet' then
    table.insert(entries, { display = 'Stop Fleet and return to Standard Copilot', kind = 'stop' })
  end
  for _, fleet in ipairs(state.fleets) do
    local prefix = fleet.valid and '' or '[INVALID] '
    table.insert(entries, {
      display = ('%s%s (%d members) — %s'):format(
        prefix,
        fleet.name,
        fleet.members,
        fleet.description
      ),
      kind = 'fleet',
      fleet = fleet,
    })
  end
  for _, run in ipairs(state.recoverable_fleets) do
    local fleet
    for _, candidate in ipairs(state.fleets) do
      if candidate.id == run.fleetId then fleet = candidate break end
    end
    if fleet then
      table.insert(entries, {
        display = ('Recover %s · %s · %d sessions'):format(
          fleet.name,
          run.status,
          #(run.members or {})
        ),
        ordinal = table.concat({ 'recover', fleet.name, run.startedAt or '', run.status or '' }, ' '),
        kind = 'recover',
        run = run,
      })
    end
  end
  picker('Copilot Fleets', entries, function(item)
    if item.kind == 'stop' then
      buffers.reset()
      state.configured_buffers = {}
      state.tasks = {}
      state.member_order = { 'standard' }
      state.selected = 'standard'
      ensure_member('standard', 'Copilot')
      send('fleet.stop')
      return
    end
    if item.kind == 'recover' then
      send('fleet.resume', { runId = item.run.id })
      return
    end
    if not item.fleet.valid then
      local diagnostics = {}
      for _, issue in ipairs(item.fleet.issues or {}) do
        table.insert(diagnostics, ('%s: %s'):format(issue.path, issue.message))
      end
      notify(table.concat(diagnostics, '\n'), vim.log.levels.ERROR)
      return
    end
    send('fleet.start', { fleetId = item.fleet.id })
  end)
end

function M.start_fleet(fleet_id)
  if not start_host() then return end
  local selected
  for _, fleet in ipairs(state.fleets) do
    if fleet.id == fleet_id then selected = fleet break end
  end
  if not selected then
    notify(('Unknown Fleet: %s'):format(fleet_id), vim.log.levels.ERROR)
    return
  end
  if not selected.valid then
    notify(('Fleet %s is invalid.'):format(fleet_id), vim.log.levels.ERROR)
    return
  end
  send('fleet.start', { fleetId = fleet_id })
end

local function event_member(message)
  return message.memberId or 'standard'
end

local function history_event(member_id, event)
  if event.type == 'user.message' and event.data then
    local content = event.data.content or event.data.prompt
    if content then buffers.append_block(member_id, 'conversation', 'You', content) end
  elseif event.type == 'assistant.message' and event.data and event.data.content then
    buffers.complete_conversation(member_id, event.data.messageId or event.id, event.data.content)
  elseif event.type == 'assistant.reasoning' and event.data and event.data.content then
    buffers.complete_activity(member_id, event.data.reasoningId or event.id, event.data.content)
  end
end

function M._on_event(message)
  local payload = message.payload or {}
  if message.type == 'hello' then
    state.fleets = payload.fleets or {}
    state.recoverable_fleets = payload.recoverableFleets or {}
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
    picker('Resume Copilot session', entries, function(item)
      if item.session.inUse then
        notify('That Copilot session is active in another process.', vim.log.levels.WARN)
        return
      end
      send('session.resume', { sessionId = item.session.sessionId })
    end)
    return
  elseif message.type == 'commands.list' then
    local target = payload.target or state.selected
    local available = commands.merge(payload.commands or {}, client_commands(state.fleets))
    state.command_requests[target] = nil
    commands.set_catalog(target, available)
    if payload.purpose ~= 'cache' then show_commands(target, available) end
    return
  elseif message.type == 'command.result' then
    local member_id = event_member(message)
    local result = payload.result or {}
    if result.kind == 'text' and result.text and result.text ~= '' then
      buffers.append_block(member_id, 'conversation', 'Copilot', result.text)
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
            task_symbols[task.status] or '?',
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
          task.status = 'cancelled'
          merge_tasks(target, { task })
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
    if state.task_detail and state.task_detail.id == payload.taskId then
      state.task_progress = payload.progress
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
      local statuses = {}
      for _, server in ipairs(items) do
        local status = server.status or 'unknown'
        statuses[status] = (statuses[status] or 0) + 1
      end
      local parts = {}
      for status, count in pairs(statuses) do
        table.insert(parts, ('%d %s'):format(count, status))
      end
      table.sort(parts)
      if #parts > 0 then detail = table.concat(parts, ', ') end
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
    if payload.status == 'connecting' or payload.status == 'starting' then
      row_status = 'running'
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
    notify(payload.message or 'Native Copilot request failed.', vim.log.levels.ERROR)
    return
  elseif message.type == 'fleet.requested' then
    buffers.append_activity_block(
      'standard',
      'Fleet requested',
      ('%s will start when the current turn becomes idle.'):format(payload.fleetId or 'Fleet')
    )
    return
  elseif message.type == 'fleet.loading' then
    commands.reset_catalogs()
    state.command_requests = {}
    close_task_detail()
    buffers.reset()
    state.configured_buffers = {}
    state.tasks = {}
    state.environment = {}
    state.tool_calls = {}
    state.prompt_calls = {}
    state.prompt_queues = {}
    state.active_prompts = {}
    state.schedules = {}
    state.mode = 'fleet-loading'
    state.active_fleet = payload.fleetId
    state.member_order = {}
    local connecting = {}
    for _, member_id in ipairs(payload.connectingMembers or {}) do connecting[member_id] = true end
    for _, member_info in ipairs(payload.members or {}) do
      table.insert(state.member_order, member_info.id)
      ensure_member(member_info.id, member_info.displayName)
      buffers.set_state(member_info.id, connecting[member_info.id] and 'loading' or 'standby')
    end
    state.selected = payload.entryMember or state.member_order[1]
    if state.selected then
      buffers.append_activity_block(
        state.selected,
        payload.recovered and 'Recovering Fleet' or 'Starting Fleet',
        ('Connecting %d of %d configured members...'):format(
          #(payload.connectingMembers or {}),
          #state.member_order
        )
      )
    end
    if is_ui_open() and state.selected then M.show_member(state.selected) end
    return
  elseif message.type == 'session.loading' then
    commands.reset_catalogs()
    state.command_requests = {}
    close_task_detail()
    buffers.reset()
    state.configured_buffers = {}
    state.tasks = {}
    state.environment = {}
    state.tool_calls = {}
    state.prompt_calls = {}
    state.prompt_queues = {}
    state.active_prompts = {}
    state.schedules = {}
    state.task_detail = nil
    state.task_progress = nil
    state.mode = 'standard-loading'
    state.active_fleet = nil
    state.member_order = { 'standard' }
    state.selected = 'standard'
    ensure_member('standard', 'Copilot')
    buffers.set_state('standard', 'loading')
    if is_ui_open() then M.show_member('standard') end
    return
  elseif message.type == 'mode.changed' then
    commands.reset_catalogs()
    state.command_requests = {}
    close_task_detail()
    state.mode = payload.mode or 'stopped'
    state.active_fleet = payload.fleetId
    if payload.mode == 'standard' then
      state.member_order = { 'standard' }
      state.selected = 'standard'
      ensure_member('standard', payload.displayName or 'Copilot')
      if protocol.is_running() then send('hello') end
    elseif payload.mode == 'fleet' then
      state.member_order = {}
      for _, member_info in ipairs(payload.members or {}) do
        table.insert(state.member_order, member_info.id)
        ensure_member(member_info.id, member_info.displayName)
      end
      state.selected = payload.entryMember or state.member_order[1]
    end
    if is_ui_open() and buffers.get_member(state.selected) then
      M.show_member(state.selected)
      focus_prompt()
    end
    return
  end

  local member_id = event_member(message)
  local entry = ensure_member(member_id)
  if message.type == 'session.history' then
    for _, event in ipairs(payload.events or {}) do history_event(member_id, event) end
  elseif message.type == 'scheduled.prompt' then
    local content = payload.displayPrompt or payload.content or 'Scheduled prompt'
    buffers.append_block(member_id, 'conversation', 'You', content)
    local prompt_id = 'scheduled:' .. tostring(payload.eventId or message.id)
    track_prompt(member_id, prompt_id, payload.delivery == 'queued' and 'idle' or 'running')
  elseif message.type == 'prompt.queued' then
    track_prompt(member_id, tostring(payload.id or message.id), 'idle')
  elseif message.type == 'prompt.failed' then
    fail_prompt(tostring(payload.id or message.id), payload.message)
  elseif message.type == 'schedule.created' then
    update_schedule(member_id, payload.id, vim.tbl_extend('force', payload, {
      status = 'idle',
    }))
  elseif message.type == 'schedule.cancelled' then
    update_schedule(member_id, payload.id, {
      status = 'cancelled',
      detail = 'cancelled',
    })
  elseif message.type == 'schedule.rearmed' then
    update_schedule(member_id, payload.id, {
      status = 'idle',
      detail = 'rearmed',
      nextRunAt = payload.nextRunAt
        and os.date('%Y-%m-%d %H:%M:%S', math.floor(payload.nextRunAt / 1000))
        or nil,
    })
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
  elseif message.type == 'activity.event' then
    local event_type = payload.eventType or 'activity'
    local data = payload.data or {}
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
          result = data.result,
          error = data.error,
        }
      )
    else
      local detail = data.intent or data.message or vim.inspect(data)
      buffers.append_activity_block(member_id, event_type, tostring(detail))
    end
  elseif message.type == 'permission.requested' then
    request_permission(payload, member_id)
  elseif message.type == 'member.error' then
    buffers.append_activity_block(member_id, 'Error', payload.message or vim.inspect(payload))
    buffers.set_state(member_id, 'error')
  elseif message.type == 'member.state' then
    local member_state = payload.state or 'unknown'
    buffers.set_state(member_id, member_state)
    if member_state == 'busy' then
      start_next_prompt(member_id)
    elseif member_state == 'idle' then
      complete_active_prompt(member_id)
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
    render_debounce_ms = options.render_debounce_ms,
    stream_flush_ms = options.stream_flush_ms,
    follow_bottom = options.follow_bottom,
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
  vim.api.nvim_create_autocmd('TabClosed', {
    callback = function()
      if state.tab and not vim.api.nvim_tabpage_is_valid(state.tab) then
        state.tab = nil
        state.main_win = nil
        state.prompt_win = nil
        state.overview = false
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
