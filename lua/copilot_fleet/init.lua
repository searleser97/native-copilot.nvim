local protocol = require('copilot_fleet.protocol')
local buffers = require('copilot_fleet.buffers')
local commands = require('copilot_fleet.commands')

local M = {}

local defaults = {
  node_command = 'node',
  config_path = vim.fn.stdpath('config') .. '/copilot/fleets.json',
  database_path = vim.fn.stdpath('data') .. '/copilot-fleet/state.sqlite',
  workspace = nil,
  prompt_height = 8,
  overview_max_agents = 4,
  render_debounce_ms = 200,
  stream_flush_ms = 80,
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
  status_buf = nil,
  selected = 'standard',
  mode = 'stopped',
  active_fleet = nil,
  member_order = { 'standard' },
  fleets = {},
  overview = false,
  configured_buffers = {},
}

local function notify(message, level)
  vim.notify(message, level or vim.log.levels.INFO, { title = 'Copilot Fleet' })
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
  vim.wo[state.prompt_win].winbar = (' To: %s  |  <Enter> send  |  <C-p> snippets '):format(target)
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
  state.prompt_buf = buf
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
        vim.api.nvim_set_current_win(state.prompt_win)
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
    if win ~= keep and win ~= prompt_win and vim.api.nvim_win_is_valid(win) then
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
  local win = close_non_prompt_windows()
  vim.api.nvim_win_set_buf(win, entry.views[view_id or 'conversation'].buf)
  buffers.mark_read(member_id)
  update_prompt_label()
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
    vim.api.nvim_buf_set_name(state.status_buf, 'copilot-fleet://status')
    vim.bo[state.status_buf].buftype = 'nofile'
    vim.bo[state.status_buf].bufhidden = 'hide'
    vim.bo[state.status_buf].swapfile = false
    vim.bo[state.status_buf].filetype = 'markdown'
    vim.b[state.status_buf].copilot_fleet = true
  end
  local lines = {
    '# Copilot Fleet Status',
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
  local ok = pcall(require, 'telescope.pickers')
  if not ok then
    notify('Telescope is required for Copilot Fleet selection.', vim.log.levels.ERROR)
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

function M.select_commands()
  if not start_host() then return end
  ensure_ui()
  send('commands.list', { target = state.selected })
end

local function show_commands(target, available)
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
  picker('Copilot Fleets', entries, function(item)
    if item.kind == 'stop' then
      buffers.reset()
      state.configured_buffers = {}
      state.member_order = { 'standard' }
      state.selected = 'standard'
      ensure_member('standard', 'Copilot')
      send('fleet.stop')
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
    buffers.reset()
    state.configured_buffers = {}
    state.member_order = {}
    state.selected = 'standard'
    send('fleet.start', { fleetId = item.fleet.id })
  end)
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
    return
  elseif message.type == 'commands.list' then
    show_commands(payload.target or state.selected, payload.commands or {})
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
  elseif message.type == 'request.error' or message.type == 'protocol.error' then
    notify(payload.message or 'Copilot Fleet request failed.', vim.log.levels.ERROR)
    return
  elseif message.type == 'mode.changed' then
    state.mode = payload.mode or 'stopped'
    state.active_fleet = payload.fleetId
    if payload.mode == 'standard' then
      state.member_order = { 'standard' }
      state.selected = 'standard'
      ensure_member('standard', payload.displayName or 'Copilot')
    elseif payload.mode == 'fleet' then
      state.member_order = {}
      for _, member_info in ipairs(payload.members or {}) do
        table.insert(state.member_order, member_info.id)
        ensure_member(member_info.id, member_info.displayName)
      end
      state.selected = payload.entryMember or state.member_order[1]
    end
    if is_ui_open() and buffers.get_member(state.selected) then M.show_member(state.selected) end
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
  elseif message.type == 'member.error' then
    buffers.append_activity_block(member_id, 'Error', payload.message or vim.inspect(payload))
    buffers.set_state(member_id, 'error')
  elseif message.type == 'member.state' then
    buffers.set_state(member_id, payload.state or 'unknown')
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
  vim.api.nvim_create_user_command('CopilotFleetToggle', M.toggle, {})
  vim.api.nvim_create_user_command('CopilotFleetSelect', M.select_fleet, {})
  vim.api.nvim_create_user_command('CopilotFleetAgents', M.select, {})
  vim.api.nvim_create_user_command('CopilotFleetStatus', M.show_status, {})
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
