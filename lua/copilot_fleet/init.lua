local protocol = require('copilot_fleet.protocol')
local buffers = require('copilot_fleet.buffers')
local commands = require('copilot_fleet.commands')

local M = {}
local data_root = vim.fn.stdpath('data')
local legacy_database = data_root .. '/copilot-fleet/state.sqlite'
local default_database = data_root .. '/native-copilot/state.sqlite'
if vim.fn.filereadable(legacy_database) == 1 then default_database = legacy_database end

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
  }
end

local defaults = {
  node_command = 'node',
  runtime_command = vim.env.NVIM_COPILOT_CMD or vim.env.COPILOT_CLI_CMD,
  config_path = vim.fn.stdpath('config') .. '/copilot/fleets.json',
  database_path = default_database,
  workspace = nil,
  prompt_height = 8,
  task_height = 5,
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
  task_win = nil,
  task_buf = nil,
  task_rows = {},
  task_detail = nil,
  task_progress = nil,
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
    vim.b[state.prompt_buf].copilot_fleet_target = state.selected
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
    end
    send('command.invoke', {
      target = state.selected,
      name = command.name,
      input = command.input,
    })
  else
    send('prompt.send', { target = state.selected, content = content })
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
  vim.b[buf].copilot_fleet_prompt = true
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
  if not state.task_buf or vim.api.nvim_get_current_buf() ~= state.task_buf then return nil end
  if state.task_detail then return state.task_detail end
  return state.task_rows[vim.api.nvim_win_get_cursor(0)[1]]
end

local function task_status_label(tasks)
  local counts = { active = 0, completed = 0, failed = 0, cancelled = 0 }
  for _, task in ipairs(tasks) do
    if task.status == 'running' or task.status == 'idle' then
      counts.active = counts.active + 1
    elseif counts[task.status] ~= nil then
      counts[task.status] = counts[task.status] + 1
    end
  end
  local parts = {}
  if counts.active > 0 then table.insert(parts, ('○ %d active'):format(counts.active)) end
  if counts.completed > 0 then table.insert(parts, ('✓ %d done'):format(counts.completed)) end
  if counts.failed > 0 then table.insert(parts, ('✗ %d failed'):format(counts.failed)) end
  if counts.cancelled > 0 then table.insert(parts, ('– %d cancelled'):format(counts.cancelled)) end
  return #parts > 0 and table.concat(parts, '  ') or 'idle'
end

local function environment_status_label(environment)
  if not environment or #environment.order == 0 then return nil end
  local settled = 0
  for _, component in ipairs(environment.order) do
    local item = environment.components[component]
    if item and item.status ~= 'running' then settled = settled + 1 end
  end
  return ('environment %d/%d'):format(settled, #environment.order)
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
end

local function set_task_lines(lines)
  if not state.task_buf or not vim.api.nvim_buf_is_valid(state.task_buf) then return end
  vim.bo[state.task_buf].readonly = false
  vim.bo[state.task_buf].modifiable = true
  vim.api.nvim_buf_set_lines(state.task_buf, 0, -1, false, lines)
  vim.bo[state.task_buf].modifiable = false
  vim.bo[state.task_buf].readonly = true
end

local function render_task_buffer()
  if not state.task_buf or not vim.api.nvim_buf_is_valid(state.task_buf) then return end
  local tasks = state.tasks[state.selected] or {}
  state.task_rows = {}
  if state.task_detail then
    local task = state.task_detail
    local progress = state.task_progress
    local lines = {
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
    set_task_lines(lines)
    for _, win in ipairs(vim.fn.win_findbuf(state.task_buf)) do
      vim.wo[win].winbar = (' Task details · %s  |  <BS>/q back  |  dd cancel '):format(
        task.status or 'unknown'
      )
      vim.api.nvim_win_set_height(win, options.task_detail_height)
    end
    return
  end

  local lines = {}
  local environment = state.environment[state.selected]
  for _, component in ipairs(environment and environment.order or {}) do
    local item = environment.components[component]
    if item then
      table.insert(lines, ('%s [environment] %s — %s'):format(
        task_symbols[item.status] or '?',
        item.component,
        item.detail or item.status
      ))
    end
  end
  for _, task in ipairs(tasks) do
    table.insert(lines, ('%s [%s] %s'):format(
      task_symbols[task.status] or '?',
      task.type or 'task',
      task_description(task)
    ))
    state.task_rows[#lines] = task
  end
  if #lines == 0 then lines = { 'No tracked tasks or environment activity.' } end
  set_task_lines(lines)
  local entry = buffers.get_member(state.selected)
  local target = entry and entry.display_name or state.selected
  local member_state = entry and entry.state or 'unknown'
  local status = task_status_label(tasks)
  local environment_status = environment_status_label(environment)
  if environment_status then status = status .. '  ' .. environment_status end
  for _, win in ipairs(vim.fn.win_findbuf(state.task_buf)) do
    vim.wo[win].winbar = (' Tasks · %s · %s · %s  |  <Enter> details  |  dd cancel '):format(
      target,
      member_state,
      status
    )
    vim.api.nvim_win_set_height(win, options.task_height)
    vim.api.nvim_win_set_cursor(win, { #lines, 0 })
  end
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
  end
  state.tasks[member_id] = current
  if state.task_detail and state.task_detail.id and by_id[state.task_detail.id] then
    state.task_detail = by_id[state.task_detail.id]
  end
end

local function cancel_cursor_task()
  local task = task_at_cursor()
  if not task then return end
  if task.status ~= 'running' and task.status ~= 'idle' then
    notify(('Task %s is already %s.'):format(task.id or '', task.status or 'finished'))
    return
  end
  send('tasks.cancel', { target = state.selected, taskId = task.id })
end

local function show_cursor_task()
  local task = task_at_cursor()
  if not task then return end
  state.task_detail = task
  state.task_progress = nil
  render_task_buffer()
  send('tasks.progress', { target = state.selected, taskId = task.id })
end

local function show_task_list()
  if not state.task_detail then return end
  state.task_detail = nil
  state.task_progress = nil
  render_task_buffer()
end

local function ensure_task_buffer()
  if state.task_buf and vim.api.nvim_buf_is_valid(state.task_buf) then return state.task_buf end
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(buf, 'native-copilot://tasks')
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'hide'
  vim.bo[buf].swapfile = false
  vim.bo[buf].filetype = 'native-copilot-tasks'
  vim.bo[buf].modifiable = false
  vim.bo[buf].readonly = true
  vim.keymap.set('n', 'dd', cancel_cursor_task, {
    buffer = buf,
    desc = 'Cancel Copilot task under cursor',
  })
  vim.keymap.set('n', '<CR>', show_cursor_task, {
    buffer = buf,
    desc = 'Show Copilot task details',
  })
  vim.keymap.set('n', '<BS>', show_task_list, {
    buffer = buf,
    desc = 'Return to Copilot task list',
  })
  vim.keymap.set('n', 'q', show_task_list, {
    buffer = buf,
    desc = 'Return to Copilot task list',
  })
  vim.keymap.set('n', 'r', function()
    send('tasks.list', { target = state.selected, purpose = 'refresh' })
  end, {
    buffer = buf,
    desc = 'Refresh Copilot tasks',
  })
  state.task_buf = buf
  render_task_buffer()
  return buf
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
      vim.cmd('normal! j')
    end
  end, {
    buffer = buf,
    desc = 'Select Copilot recipient in overview',
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
    elseif win == state.task_win then
      -- Keep the task strip between the main view and prompt.
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
      and win ~= state.task_win
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
  vim.cmd('aboveleft split')
  state.task_win = vim.api.nvim_get_current_win()
  vim.api.nvim_win_set_buf(state.task_win, ensure_task_buffer())
  vim.api.nvim_win_set_height(state.task_win, options.task_height)
  vim.wo[state.task_win].winfixheight = true
  vim.wo[state.task_win].cursorline = true
  render_task_buffer()
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
  vim.api.nvim_set_current_tabpage(state.tab)
  vim.cmd('tabclose')
  state.tab = nil
  state.main_win = nil
  state.prompt_win = nil
  state.task_win = nil
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
  state.task_detail = nil
  state.task_progress = nil
  local win = close_non_prompt_windows()
  vim.api.nvim_win_set_buf(win, entry.views[view_id or 'conversation'].buf)
  buffers.mark_read(member_id)
  update_prompt_label()
  render_task_buffer()
  vim.api.nvim_set_current_win(win)
end

function M.show_overview()
  ensure_ui()
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
    vim.b[state.status_buf].copilot_fleet = true
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
  state.task_detail = nil
  state.task_progress = nil
  render_task_buffer()
  if state.task_win and vim.api.nvim_win_is_valid(state.task_win) then
    vim.api.nvim_set_current_win(state.task_win)
  end
  send('tasks.list', { target = state.selected, purpose = 'view' })
end

function M.cancel_background()
  if not start_host() then return end
  send('session.cancel-background', { target = state.selected })
end

function M.abort()
  if not start_host() then return end
  send('session.abort', { target = state.selected })
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
      table.insert(entries, {
        display = ('%s — %s'):format(summary, session.modifiedTime or 'unknown time'),
        ordinal = table.concat({
          summary,
          session.sessionId or '',
          session.modifiedTime or '',
        }, ' '),
        session = session,
      })
    end
    if #entries == 0 then
      notify('No previous Copilot sessions were found for this workspace.', vim.log.levels.INFO)
      return
    end
    picker('Resume Copilot session', entries, function(item)
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
      buffers.append_block(member_id, 'conversation', '/' .. (payload.name or 'command'), result.text)
    elseif result.kind == 'completed' and result.message and result.message ~= '' then
      buffers.append_block(member_id, 'conversation', '/' .. (payload.name or 'command'), result.message)
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
        send('command.invoke', {
          target = payload.target or member_id,
          name = result.command,
          input = item.option.name,
        })
      end)
    end
    return
  elseif message.type == 'tasks.list' then
    if payload.purpose == 'view' or payload.purpose == 'refresh' then
      merge_tasks(payload.target or event_member(message), payload.tasks or {})
      render_task_buffer()
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
      for _, task in ipairs(state.tasks[payload.target or event_member(message)] or {}) do
        if task.id == payload.taskId then task.status = 'cancelled' end
      end
      render_task_buffer()
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
    render_task_buffer()
    if state.status_buf and vim.api.nvim_buf_is_valid(state.status_buf) then
      update_status_buffer()
    end
    return
  elseif message.type == 'tasks.progress' then
    if state.task_detail and state.task_detail.id == payload.taskId then
      state.task_progress = payload.progress
      render_task_buffer()
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
    render_task_buffer()
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
    render_task_buffer()
    return
  elseif message.type == 'environment.error' then
    local member_id = event_member(message)
    local component = payload.component or 'Environment'
    local detail = payload.message or 'Loading failed'
    update_environment(member_id, component, 'failed', detail)
    render_task_buffer()
    buffers.append_activity_block(
      member_id,
      component .. ' error',
      detail
    )
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
    render_task_buffer()
    return
  elseif message.type == 'session.recreated' then
    buffers.append_activity_block(
      event_member(message),
      'Session recovery',
      payload.message or 'Empty session recreated'
    )
    return
  elseif message.type == 'request.error' or message.type == 'protocol.error' then
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
    buffers.reset()
    state.configured_buffers = {}
    state.tasks = {}
    state.environment = {}
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
    render_task_buffer()
    return
  elseif message.type == 'session.loading' then
    commands.reset_catalogs()
    state.command_requests = {}
    buffers.reset()
    state.configured_buffers = {}
    state.tasks = {}
    state.environment = {}
    state.task_detail = nil
    state.task_progress = nil
    state.mode = 'standard-loading'
    state.active_fleet = nil
    state.member_order = { 'standard' }
    state.selected = 'standard'
    ensure_member('standard', 'Copilot')
    buffers.set_state('standard', 'loading')
    if is_ui_open() then M.show_member('standard') end
    render_task_buffer()
    return
  elseif message.type == 'mode.changed' then
    commands.reset_catalogs()
    state.command_requests = {}
    state.mode = payload.mode or 'stopped'
    state.active_fleet = payload.fleetId
    state.task_detail = nil
    state.task_progress = nil
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
    render_task_buffer()
    return
  end

  local member_id = event_member(message)
  local entry = ensure_member(member_id)
  if message.type == 'session.history' then
    for _, event in ipairs(payload.events or {}) do history_event(member_id, event) end
  elseif message.type == 'prompt.accepted' then
    buffers.append_block(member_id, 'conversation', 'You', payload.content or '')
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
    local detail = data.toolName or data.intent or data.message or vim.inspect(data)
    buffers.append_activity_block(member_id, event_type, tostring(detail))
  elseif message.type == 'permission.requested' then
    request_permission(payload, member_id)
  elseif message.type == 'member.error' then
    buffers.append_activity_block(member_id, 'Error', payload.message or vim.inspect(payload))
    buffers.set_state(member_id, 'error')
  elseif message.type == 'member.state' then
    buffers.set_state(member_id, payload.state or 'unknown')
    render_task_buffer()
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
  vim.api.nvim_create_user_command('CopilotFleetToggle', M.toggle, {})
  vim.api.nvim_create_user_command('CopilotFleetSelect', M.select_fleet, {})
  vim.api.nvim_create_user_command('CopilotFleetAgents', M.select, {})
  vim.api.nvim_create_user_command('CopilotFleetStatus', M.show_status, {})
  vim.api.nvim_create_user_command('CopilotFleetTasks', M.select_task, {})
  vim.api.nvim_create_user_command('CopilotFleetAbort', M.abort, {})
  vim.api.nvim_create_user_command('CopilotFleetCancelBackground', M.cancel_background, {})
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
