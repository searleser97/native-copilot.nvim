if vim.v.vim_did_enter == 0 then
  local script = debug.getinfo(1, 'S').source:sub(2)
  vim.api.nvim_create_autocmd('VimEnter', {
    once = true,
    callback = function() dofile(script) end,
  })
  return
end

local root = assert(vim.env.NATIVE_COPILOT_E2E_ROOT, 'NATIVE_COPILOT_E2E_ROOT is required')
local result_path = assert(vim.env.NATIVE_COPILOT_E2E_RESULT, 'NATIVE_COPILOT_E2E_RESULT is required')
local trace_path = assert(vim.env.NATIVE_COPILOT_E2E_TRACE, 'NATIVE_COPILOT_E2E_TRACE is required')
local database_path =
  assert(vim.env.NATIVE_COPILOT_E2E_DATABASE, 'NATIVE_COPILOT_E2E_DATABASE is required')
local telescope_path =
  assert(vim.env.NATIVE_COPILOT_E2E_TELESCOPE, 'NATIVE_COPILOT_E2E_TELESCOPE is required')
local plenary_path =
  assert(vim.env.NATIVE_COPILOT_E2E_PLENARY, 'NATIVE_COPILOT_E2E_PLENARY is required')

vim.opt.runtimepath:prepend(plenary_path)
vim.opt.runtimepath:prepend(telescope_path)
vim.opt.runtimepath:prepend(root)
vim.o.termguicolors = true
require('telescope').setup({})

local started_at = vim.uv.now()
local original_lines = vim.o.lines
local original_columns = vim.o.columns
local original_cmdheight = vim.o.cmdheight
local original_laststatus = vim.o.laststatus
local original_showtabline = vim.o.showtabline
local results = {}
local notifications = {}
local completed = false
local phase = 'ready'
local last_trace = 0
local tick

vim.notify = function(message)
  notifications[#notifications + 1] = tostring(message)
end

local native = require('native_copilot')
local on_event = native._on_event
native._on_event = function(message)
  vim.fn.writefile({ 'event=' .. tostring(message.type) }, trace_path, 'a')
  return on_event(message)
end
native.setup({
  workspace = root,
  database_path = database_path,
  runtime_command_resolver = nil,
  frontend = { completion = 'native', picker = 'telescope' },
})
native.open({ reuse_current_tab = true })

local actions = require('telescope.actions')
local action_state = require('telescope.actions.state')

local function find_buffer(predicate)
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if predicate(buf) then return buf end
  end
end

local function prompt()
  return find_buffer(function(buf) return vim.b[buf].native_copilot_prompt == true end)
end

local function conversation()
  return find_buffer(function(buf)
    return vim.api.nvim_buf_get_name(buf):find('native%-copilot://standard/conversation') ~= nil
  end)
end

local function text(buf)
  return buf and table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), '\n') or ''
end

local function has_quoted_environment(content)
  for line in content:gmatch('[^\n]+') do
    if line:match('^>%s+.*%[environment%]') then return true end
  end
  return false
end

local function telescope_prompt()
  return find_buffer(function(buf) return vim.bo[buf].filetype == 'TelescopePrompt' end)
end

local function current_picker()
  local buf = telescope_prompt()
  local picker = buf and action_state.get_current_picker(buf) or nil
  if picker
    and (
      type(picker.manager) ~= 'table'
      or not picker.results_win
      or not vim.api.nvim_win_is_valid(picker.results_win)
    )
  then
    picker = nil
  end
  return buf, picker
end

local function submit(content)
  local buf = assert(prompt(), 'prompt buffer was not found')
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, { content })
  return vim.api.nvim_buf_call(buf, native.submit_prompt)
end

local function choose_where(predicate)
  local prompt_buf, picker = current_picker()
  assert(prompt_buf and picker, 'Telescope picker was not open')
  local count = picker.manager:num_results()
  for _ = 1, count do
    local selected = action_state.get_selected_entry()
    if selected and predicate(selected.value) then
      actions.select_default(prompt_buf)
      return
    end
    actions.move_selection_next(prompt_buf)
  end
  error('Expected Telescope entry was not found')
end

local function pass(label)
  results[#results + 1] = 'PASS ' .. label
end

local function check(condition, label)
  if condition then
    pass(label)
    return true
  end
  results[#results + 1] = 'FAIL ' .. label
  return false
end

local function finish(failure)
  if completed then return end
  completed = true
  vim.o.lines = original_lines
  vim.o.columns = original_columns
  if failure then results[#results + 1] = 'FAIL ' .. tostring(failure) end
  vim.fn.writefile(results, result_path)
  local snapshot = vim.env.NATIVE_COPILOT_E2E_SNAPSHOT
  if snapshot then vim.fn.writefile(vim.split(text(conversation()), '\n'), snapshot) end
  if #notifications > 0 then vim.fn.writefile(notifications, trace_path, 'a') end
  vim.defer_fn(function() vim.cmd('qa!') end, 500)
end

local function schedule_tick()
  vim.defer_fn(function()
    local ok, failure = xpcall(tick, debug.traceback)
    if not ok then finish(failure) end
  end, 25)
end

tick = function()
  if vim.uv.now() - last_trace >= 500 then
    local active_telescope_prompt = telescope_prompt()
    vim.fn.writefile({
      ('phase=%s elapsed=%d prompt=%s notifications=%d'):format(
        phase,
        vim.uv.now() - started_at,
        tostring(active_telescope_prompt),
        #notifications
      ),
    }, trace_path, 'a')
    last_trace = vim.uv.now()
  end
  if vim.uv.now() - started_at > 30000 then
    finish('Visible Telescope E2E timed out in phase ' .. phase)
    return
  end

  local content = text(conversation())
  local prompt_buf, picker = current_picker()
  if phase == 'ready' then
    if not content:find('[environment] Copilot environment — ready', 1, true) then
      schedule_tick()
      return
    end
    if not check(
      not has_quoted_environment(content),
      'environment rows rendered without blockquote markers'
    ) then
      finish()
      return
    end
    submit('/model')
    phase = 'model-picker'
  elseif phase == 'model-picker' then
    if not picker then
      schedule_tick()
      return
    end
    choose_where(function(item)
      return item.model and item.model.modelId == 'scripted-deep'
    end)
    phase = 'model-result'
  elseif phase == 'model-result' then
    if not content:find('Model switched to `scripted%-deep`%.') then
      schedule_tick()
      return
    end
    pass('/model opened Telescope and switched the selected model')
    submit('/model scripted-fast')
    phase = 'model-direct-result'
  elseif phase == 'model-direct-result' then
    if not content:find('Model switched to `scripted%-fast`%.') then
      schedule_tick()
      return
    end
    pass('/model <id> switched directly without a picker')
    submit('/mcp list')
    phase = 'mcp-list-result'
  elseif phase == 'mcp-list-result' then
    if not content:find('| Server | Status |', 1, true)
      or not content:find('| mock-files | connected |', 1, true)
    then
      schedule_tick()
      return
    end
    pass('/mcp list rendered the current server table')
    submit('/mcp tools mock-files')
    phase = 'mcp-tools-result'
  elseif phase == 'mcp-tools-result' then
    if not content:find('Tools from `mock%-files`', 1) then
      schedule_tick()
      return
    end
    pass('/mcp tools rendered tools for the requested server')
    submit('/mcp disable mock-files')
    phase = 'mcp-disable-result'
  elseif phase == 'mcp-disable-result' then
    if not content:find('MCP server `mock%-files` disabled%.') then
      schedule_tick()
      return
    end
    pass('/mcp disable completed through the host')
    submit('/mcp enable mock-files')
    phase = 'mcp-enable-result'
  elseif phase == 'mcp-enable-result' then
    if not content:find('MCP server `mock%-files` enabled%.') then
      schedule_tick()
      return
    end
    pass('/mcp enable completed through the host')
    submit('/mcp reload')
    phase = 'mcp-reload-result'
  elseif phase == 'mcp-reload-result' then
    if not content:find('Reloaded 2 MCP servers%.') then
      schedule_tick()
      return
    end
    pass('/mcp reload displayed completion feedback')
    submit('/mcp-reload')
    phase = 'mcp-reload-alias-result'
  elseif phase == 'mcp-reload-alias-result' then
    local _, reload_count = content:gsub('Reloaded 2 MCP servers%.', '')
    if reload_count < 2 then
      schedule_tick()
      return
    end
    pass('/mcp-reload displayed completion feedback')
    submit('/mcp')
    phase = 'mcp-server-picker'
  elseif phase == 'mcp-server-picker' then
    if not picker then
      schedule_tick()
      return
    end
    choose_where(function(item)
      return item.server and item.server.name == 'mock-files'
    end)
    phase = 'mcp-action-picker'
  elseif phase == 'mcp-action-picker' then
    if not picker then
      schedule_tick()
      return
    end
    choose_where(function(item) return item.action == 'show' end)
    phase = 'mcp-result'
  elseif phase == 'mcp-result' then
    if not content:find('MCP server `mock%-files`', 1) then
      schedule_tick()
      return
    end
    pass('/mcp opened nested Telescope pickers and rendered server details')
    submit('/tasks')
    phase = 'task-picker'
  elseif phase == 'task-picker' then
    if not picker then
      schedule_tick()
      return
    end
    choose_where(function(item)
      return item.task and item.task.id == 'e2e-picker-task-completed'
    end)
    phase = 'task-detail'
  elseif phase == 'task-detail' then
    local detail = find_buffer(function(buf)
      return text(buf):find('Validate picker command coverage', 1, true) ~= nil
    end)
    if not detail then
      schedule_tick()
      return
    end
    pass('/tasks opened Telescope and displayed the selected task')
    local windows = vim.fn.win_findbuf(detail)
    if #windows > 0 then vim.api.nvim_win_close(windows[1], true) end
    submit('/fleet Validate command picker behavior')
    phase = 'fleet-objective-result'
  elseif phase == 'fleet-objective-result' then
    if not content:find(
      'Design and create a task%-specific Copilot fleet for this objective: Validate command picker behavior'
    ) then
      schedule_tick()
      return
    end
    pass('/fleet <objective> routed the generated Fleet request to Standard')
    submit('/fleet')
    phase = 'fleet-picker'
  elseif phase == 'fleet-picker' then
    if not picker then
      schedule_tick()
      return
    end
    choose_where(function(item) return item.kind == 'recover' end)
    phase = 'fleet-result'
  elseif phase == 'fleet-result' then
    local planner = find_buffer(function(buf)
      return vim.api.nvim_buf_get_name(buf):find(
        'native%-copilot://e2e%-recovered%-fleet/planner/conversation'
      ) ~= nil
    end)
    if not planner then
      schedule_tick()
      return
    end
    pass('/fleet opened Telescope and recovered the selected Fleet')
    native.select_commands()
    phase = 'command-picker'
  elseif phase == 'command-picker' then
    if not picker then
      schedule_tick()
      return
    end
    local count = picker.manager:num_results()
    if not check(count >= 6, 'command browser included client-native and SDK commands') then
      finish()
      return
    end
    choose_where(function(item)
      return item.command and item.command.name == 'context'
    end)
    phase = 'command-result'
  elseif phase == 'command-result' then
    if text(prompt()) ~= '/context' then
      schedule_tick()
      return
    end
    pass('command browser wrote the selected slash command into AI Prompt')
    submit('/context workspace')
    phase = 'sdk-command-result'
  elseif phase == 'sdk-command-result' then
    if not content:find('context workspace', 1, true) then
      schedule_tick()
      return
    end
    pass('SDK-provided slash command executed and rendered its result')
    submit('/resume e2e-older-session-23')
    phase = 'resume-locked-result'
  elseif phase == 'resume-locked-result' then
    local locked_error
    for _, message in ipairs(notifications) do
      if message:find('e2e-older-session-23', 1, true)
        and message:find('active in another process', 1, true)
      then
        locked_error = message
        break
      end
    end
    if not locked_error then
      schedule_tick()
      return
    end
    pass('/resume <id> rejected a session active in another process')
    vim.o.lines = 8
    vim.o.columns = 40
    submit('/resume')
    phase = 'resume-picker'
  elseif phase == 'resume-picker' then
    if not picker then
      schedule_tick()
      return
    end
    local selected = action_state.get_selected_entry()
    local session = selected and selected.value and selected.value.session
    local result_count = picker.manager:num_results()
    if not check(result_count == 25, '/resume Telescope picker rendered the complete session list') then
      finish()
      return
    end
    if not check(
      session and session.sessionId == 'e2e-cli-session',
      '/resume listed and initially selected the most recent session first'
    ) then
      finish()
      return
    end
    choose_where(function(item)
      return item.session and item.session.inUse == true
    end)
    phase = 'resume-picker-locked-result'
  elseif phase == 'resume-picker-locked-result' then
    local locked_warning
    for _, message in ipairs(notifications) do
      if message == 'That Copilot session is active in another process.' then
        locked_warning = message
        break
      end
    end
    if not locked_warning then
      schedule_tick()
      return
    end
    pass('/resume picker rejected a session active in another process')
    submit('/resume')
    phase = 'resume-picker-reopened'
  elseif phase == 'resume-picker-reopened' then
    if not picker then
      schedule_tick()
      return
    end
    local selected = action_state.get_selected_entry()
    local session = selected and selected.value and selected.value.session
    if not check(
      session and session.sessionId == 'e2e-cli-session',
      '/resume preserved newest-session selection after rejecting a locked entry'
    ) then
      finish()
      return
    end
    choose_where(function(item)
      return item.session and item.session.sessionId == 'e2e-cli-session'
    end)
    vim.o.lines = original_lines
    vim.o.columns = original_columns
    phase = 'resume-result'
  elseif phase == 'resume-result' then
    if not content:find('CLI session resume restored current Tools', 1, true)
      and not content:find('Inspect this workspace and validate it without blocking', 1, true)
    then
      schedule_tick()
      return
    end
    local picker_error
    for _, message in ipairs(notifications) do
      local lowered = message:lower()
      if lowered:find('telescope', 1, true)
        or lowered:find('not enough room', 1, true)
        or lowered:find('e36', 1, true)
      then
        picker_error = message
        break
      end
    end
    if not check(not picker_error, 'constrained Telescope commands produced no layout errors') then
      finish()
      return
    end
    pass('/resume selected and restored the newest CLI session through Telescope')
    native.close()
    vim.o.lines = 6
    vim.o.columns = 36
    local opened, open_error = pcall(native.open, { reuse_current_tab = true })
    if not check(
      opened and prompt() ~= nil,
      'Copilot UI reopened without a not-enough-room split failure'
    ) then
      if open_error then results[#results + 1] = 'FAIL ' .. tostring(open_error) end
      finish()
      return
    end
    submit('/tasks')
    phase = 'compact-task-picker'
  elseif phase == 'compact-task-picker' then
    if not picker then
      schedule_tick()
      return
    end
    choose_where(function(item)
      return item.task and item.task.id == 'e2e-picker-task-completed'
    end)
    phase = 'compact-task-detail'
  elseif phase == 'compact-task-detail' then
    local detail = find_buffer(function(buf)
      return text(buf):find('Validate picker command coverage', 1, true) ~= nil
    end)
    if not detail then
      schedule_tick()
      return
    end
    pass('task picker and detail window remained usable in compact mode')
    local windows = vim.fn.win_findbuf(detail)
    if #windows > 0 then vim.api.nvim_win_close(windows[1], true) end
    native._on_event({
      type = 'member.state',
      memberId = 'standard',
      payload = { state = 'busy' },
    })
    local queued, queue_error = pcall(submit, 'Keep this prompt queued in compact mode.')
    local queue = find_buffer(function(buf)
      return text(buf):find('Queued prompts — FIFO', 1, true) ~= nil
    end)
    if not check(
      queued and queue ~= nil,
      'prompt queue opened without a not-enough-room split failure'
    ) then
      if queue_error then results[#results + 1] = 'FAIL ' .. tostring(queue_error) end
      finish()
      return
    end
    native.close()
    if not check(
      vim.o.cmdheight == original_cmdheight
        and vim.o.laststatus == original_laststatus
        and vim.o.showtabline == original_showtabline,
      'compact mode restored Neovim chrome settings on close'
    ) then
      finish()
      return
    end
    vim.cmd('tabnew')
    native.open({ reuse_current_tab = true })
    vim.cmd('tabclose')
    if not check(
      vim.o.cmdheight == original_cmdheight
        and vim.o.laststatus == original_laststatus
        and vim.o.showtabline == original_showtabline,
      'external tab close restored compact Neovim chrome settings'
    ) then
      finish()
      return
    end
    finish()
    return
  end
  schedule_tick()
end

schedule_tick()
