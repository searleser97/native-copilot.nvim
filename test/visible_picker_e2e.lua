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
local blink_path =
  assert(vim.env.NATIVE_COPILOT_E2E_BLINK, 'NATIVE_COPILOT_E2E_BLINK is required')
local with_smear = vim.env.NATIVE_COPILOT_E2E_WITH_SMEAR == '1'
local smear_path = with_smear
    and assert(vim.env.NATIVE_COPILOT_E2E_SMEAR, 'NATIVE_COPILOT_E2E_SMEAR is required')
  or nil

if smear_path then vim.opt.runtimepath:prepend(smear_path) end
vim.opt.runtimepath:prepend(blink_path)
vim.opt.runtimepath:prepend(plenary_path)
vim.opt.runtimepath:prepend(telescope_path)
vim.opt.runtimepath:prepend(root)
vim.o.termguicolors = true
local scheduled_errors = {}
local original_schedule_wrap = vim.schedule_wrap
vim.schedule_wrap = function(callback)
  return original_schedule_wrap(function(...)
    local argument_count = select('#', ...)
    local arguments = { ... }
    local ok, failure = xpcall(function()
      callback(unpack(arguments, 1, argument_count))
    end, debug.traceback)
    if not ok then table.insert(scheduled_errors, failure) end
  end)
end
require('telescope').setup({
  defaults = {
    layout_strategy = 'flex',
    layout_config = {
      vertical = { width = 0.95, height = 0.95, preview_height = 0.6 },
      horizontal = { width = 0.95, height = 0.95, preview_width = 0.6 },
    },
  },
})
local blink = require('blink.cmp')
blink.setup({
  completion = {
    menu = { auto_show = true },
    list = { selection = { preselect = false, auto_insert = false } },
  },
  sources = {
    default = { 'native_copilot' },
    providers = {
      native_copilot = {
        name = 'Copilot',
        module = 'native_copilot.blink',
        async = true,
      },
    },
  },
})
local smear_cursor
if with_smear then
  smear_cursor = require('smear_cursor')
  smear_cursor.setup({
    smear_insert_mode = false,
  })
  smear_cursor.enabled = false
end

local started_at = vim.uv.now()
local original_lines = vim.o.lines
local original_columns = vim.o.columns
local original_cmdheight = vim.o.cmdheight
local original_laststatus = vim.o.laststatus
local original_showtabline = vim.o.showtabline
local original_eventignore = vim.o.eventignore
local results = {}
local notifications = {}
local completed = false
local phase = 'early-completion'
local last_trace = 0
local resume_picker_ready_at
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
  frontend = { completion = 'blink', picker = 'telescope' },
})
native.open({ reuse_current_tab = true })

local actions = require('telescope.actions')
local action_state = require('telescope.actions.state')
local pickers_module = require('telescope.pickers')
local original_picker_new = pickers_module.new
local inject_short_resume_results = true
pickers_module.new = function(opts, picker_options)
  local picker = original_picker_new(opts, picker_options)
  if picker_options.prompt_title == 'Resume Copilot session' then
    local original_clear_extra_rows = picker.clear_extra_rows
    picker.clear_extra_rows = function(self, results_bufnr)
      original_clear_extra_rows(self, results_bufnr)
      if inject_short_resume_results then
        inject_short_resume_results = false
        local first_descending_line = math.max(
          1,
          self.max_results - vim.api.nvim_win_get_height(self.results_win)
        )
        local line_count = vim.api.nvim_buf_line_count(results_bufnr)
        if line_count > first_descending_line then
          vim.api.nvim_buf_set_lines(results_bufnr, first_descending_line, -1, false, {})
        elseif line_count < first_descending_line then
          local padding = {}
          for _ = line_count + 1, first_descending_line do table.insert(padding, '') end
          vim.api.nvim_buf_set_lines(results_bufnr, -1, -1, false, padding)
        end
      end
    end
  end
  return picker
end

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

local function has_quoted_instruction(content)
  for line in content:gmatch('[^\n]+') do
    if line:match('^%s*>%s+.*%[instruction%]') then return true end
  end
  return false
end

local function line_containing(content, needle)
  local lines = vim.split(content, '\n', { plain = true })
  for _, line in ipairs(lines) do
    if line:find(needle, 1, true) then return line end
  end
end

local function heading_before(content, needle)
  local lines = vim.split(content, '\n', { plain = true })
  for index, line in ipairs(lines) do
    if line:find(needle, 1, true) then
      for previous = index - 1, 1, -1 do
        if lines[previous] ~= '' then return lines[previous] end
      end
    end
  end
end

local function occurrence_count(content, needle)
  local count = 0
  local offset = 1
  while true do
    local start = content:find(needle, offset, true)
    if not start then return count end
    count = count + 1
    offset = start + #needle
  end
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

local function submit(content, lhs, mode)
  local buf = assert(prompt(), 'prompt buffer was not found')
  if not lhs then
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, { content })
    return vim.api.nvim_buf_call(buf, native.submit_prompt)
  end
  local win
  for _, candidate in ipairs(vim.api.nvim_list_wins()) do
    if vim.api.nvim_win_get_buf(candidate) == buf then
      win = candidate
      break
    end
  end
  assert(win and vim.api.nvim_win_is_valid(win), 'prompt window was not found')
  vim.api.nvim_set_current_win(win)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, { '' })
  vim.api.nvim_win_set_cursor(win, { 1, 0 })
  if mode == 'i' then vim.cmd('startinsert') end
  vim.api.nvim_input(content)
  vim.defer_fn(function()
    local keys = vim.api.nvim_replace_termcodes(lhs, true, false, true)
    vim.api.nvim_input(keys)
  end, 100)
  return true
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
  if phase == 'early-completion' then
    if not with_smear then
      local loaded = package.loaded['smear_cursor'] ~= nil
      local available = pcall(require, 'smear_cursor')
      if not check(
        not loaded and not available,
        'Telescope /resume ran without smear-cursor installed'
      ) then
        finish()
        return
      end
    end
    local prompt_bufnr = prompt()
    if not prompt_bufnr then
      schedule_tick()
      return
    end
    local completion_items
    require('native_copilot.blink').new():get_completions({
      bufnr = prompt_bufnr,
      line = '/res',
      cursor = { 1, 4 },
    }, function(response)
      completion_items = response.items
    end)
    local found_resume = false
    for _, item in ipairs(completion_items or {}) do
      if item.label == '/resume' then
        found_resume = true
        break
      end
    end
    if not check(
      found_resume and not content:find('[environment] Copilot environment — ready', 1, true),
      'Blink offered /resume before the environment finished loading'
    ) then
      finish()
      return
    end
    phase = 'ready'
    schedule_tick()
  elseif phase == 'ready' then
    if not content:find('[environment] Copilot environment — ready', 1, true) then
      schedule_tick()
      return
    end
    local session_id = content:find('[SessionId][e2e-standard-session]', 1, true)
    local first_environment = content:find('[environment]', 1, true)
    if not check(
      session_id
        and first_environment
        and session_id < first_environment
        and content:find('\n\n[SessionId][e2e-standard-session]', 1, true),
      'standard session identity preceded environment discovery'
    ) then
      finish()
      return
    end
    if not check(
      not has_quoted_environment(content),
      'environment rows rendered without blockquote markers'
    ) then
      finish()
      return
    end
    if not check(
      content:find('[instruction] Live repository instructions', 1, true)
        and not has_quoted_instruction(content),
      'live instruction discovery used the unquoted instruction timeline'
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
    if not check(
      picker.sorting_strategy == 'descending',
      'ordinary Telescope pickers preserved the configured sorting strategy'
    ) then
      finish()
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
    submit('/reasoning')
    phase = 'reasoning-picker'
  elseif phase == 'reasoning-picker' then
    if not picker then
      schedule_tick()
      return
    end
    choose_where(function(item)
      return item.effort == 'high'
    end)
    phase = 'reasoning-result'
  elseif phase == 'reasoning-result' then
    if not content:find('Reasoning effort switched to `high`%.') then
      schedule_tick()
      return
    end
    pass('/reasoning opened Telescope and switched reasoning effort')
    submit('/reasoning low')
    phase = 'reasoning-direct-result'
  elseif phase == 'reasoning-direct-result' then
    if not content:find('Reasoning effort switched to `low`%.') then
      schedule_tick()
      return
    end
    pass('/reasoning <level> switched reasoning effort directly')
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
    local selected = pcall(choose_where, function(item)
      return item.task and item.task.id == 'e2e-picker-task-completed'
    end)
    if not selected then
      schedule_tick()
      return
    end
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
    phase = 'agent-objective-result'
  elseif phase == 'agent-objective-result' then
    if not content:find(
      'Design and spawn standalone Copilot agents for this objective: Validate command picker behavior'
    ) then
      schedule_tick()
      return
    end
    pass('/fleet <objective> routed the standalone agent request to Standard')
    submit('/fleet')
    phase = 'agent-picker'
  elseif phase == 'agent-picker' then
    if not picker then
      schedule_tick()
      return
    end
    choose_where(function(item) return item.kind == 'recover' end)
    phase = 'agent-result'
  elseif phase == 'agent-result' then
    local planner = find_buffer(function(buf)
      return vim.api.nvim_buf_get_name(buf):find(
        'native%-copilot://agent:e2e0aaaa%-0000%-4000%-8000%-00000000e2e1/conversation'
      ) ~= nil
    end)
    if not planner then
      schedule_tick()
      return
    end
    pass('/fleet opened Telescope and recovered the selected agent')
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
    submit('/resume e2e-older-session-023')
    phase = 'resume-locked-result'
  elseif phase == 'resume-locked-result' then
    local locked_error
    for _, message in ipairs(notifications) do
      if message:find('e2e-older-session-023', 1, true)
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
    if smear_cursor then smear_cursor.enabled = true end
    submit('/resume', '<C-s>', 'i')
    phase = 'resume-picker'
  elseif phase == 'resume-picker' then
    if not picker then
      schedule_tick()
      return
    end
    if not resume_picker_ready_at then
      resume_picker_ready_at = vim.uv.now()
      schedule_tick()
      return
    end
    if vim.uv.now() - resume_picker_ready_at < 500 then
      schedule_tick()
      return
    end
    local selected = action_state.get_selected_entry()
    local session = selected and selected.value and selected.value.session
    local result_count = picker.manager:num_results()
    local range_error
    for _, failure in ipairs(scheduled_errors) do
      if failure:find('Invalid cursor line: out of range', 1, true)
        and failure:find('telescope', 1, true)
      then
        range_error = failure
        break
      end
    end
    if not check(
      range_error == nil,
      '/resume avoided Telescope cursor placement outside the sparse results buffer'
    ) then
      finish(range_error)
      return
    end
    if not check(
      picker.sorting_strategy == 'ascending',
      '/resume used safe newest-first Telescope ordering'
    ) then
      finish()
      return
    end
    if not check(result_count == 2, '/resume handled a sparse session list') then
      finish()
      return
    end
    if not check(
      session and session.sessionId == 'e2e-cli-session',
      '/resume initially selected the most recent sparse-list session at the bottom'
    ) then
      finish()
      return
    end
    actions.close(prompt_buf)
    resume_picker_ready_at = nil
    phase = 'resume-sparse-closed'
    schedule_tick()
  elseif phase == 'resume-sparse-closed' then
    if picker then
      schedule_tick()
      return
    end
    submit('/resume')
    phase = 'resume-picker-locked'
  elseif phase == 'resume-picker-locked' then
    if not picker then
      schedule_tick()
      return
    end
    if not check(
      picker.manager:num_results() == 321,
      '/resume Telescope picker rendered the complete session list'
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
    vim.o.lines = 8
    vim.o.columns = 40
    resume_picker_ready_at = nil
    submit('/resume')
    phase = 'resume-picker-reopened'
  elseif phase == 'resume-picker-reopened' then
    if not picker then
      schedule_tick()
      return
    end
    if not resume_picker_ready_at then
      resume_picker_ready_at = vim.uv.now()
      schedule_tick()
      return
    end
    if vim.uv.now() - resume_picker_ready_at < 2000 then
      schedule_tick()
      return
    end
    local selected = action_state.get_selected_entry()
    local session = selected and selected.value and selected.value.session
    local result_count = picker.manager:num_results()
    local cursor_row = vim.api.nvim_win_get_cursor(picker.results_win)[1]
    local smear_window_count = 0
    for _, win in ipairs(vim.api.nvim_list_wins()) do
      local buf = vim.api.nvim_win_get_buf(win)
      if vim.bo[buf].filetype == 'smear-cursor' then
        smear_window_count = smear_window_count + 1
      end
    end
    if not check(result_count == 321, '/resume reopened the complete session list') then
      finish()
      return
    end
    if not check(
      session and session.sessionId == 'e2e-cli-session',
      '/resume preserved newest-session selection after rejecting a locked entry'
    ) then
      finish()
      return
    end
    if not check(
      cursor_row == result_count,
      '/resume moved the Telescope results cursor to the newest final session'
    ) then
      finish()
      return
    end
    if not check(
      smear_window_count < 20,
      '/resume avoided a smear-cursor window explosion'
    ) then
      finish(('Observed %d smear-cursor windows'):format(smear_window_count))
      return
    end
    if not check(
      vim.o.eventignore == original_eventignore,
      '/resume restored Neovim event handling after positioning the picker'
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
    if smear_cursor and not smear_cursor.enabled then
      schedule_tick()
      return
    end
    if not content:find('CLI session resume restored current Tools', 1, true)
      and not content:find('Inspect this workspace and validate it without blocking', 1, true)
    then
      schedule_tick()
      return
    end
    local resumed_session_id = content:find('[SessionId][e2e-cli-session]', 1, true)
    local resumed_environment = content:find('[environment]', resumed_session_id or 1, true)
    if not check(
      resumed_session_id
        and resumed_environment
        and resumed_session_id < resumed_environment
        and content:find('\n\n[SessionId][e2e-cli-session]', 1, true),
      '/resume rendered a separated session identity before environment rows'
    ) then
      finish()
      return
    end
    local subagent_prompt =
      'Review the workspace validation and report only actionable findings.'
    if not check(
      occurrence_count(content, subagent_prompt) == 0
        and line_containing(content, 'task — Review workspace validation') ~= nil,
      '/resume rendered the concise task description instead of the full prompt inline'
    ) then
      finish()
      return
    end
    local followup_prompt =
      'Also verify that the validation result includes the constrained layout.'
    if not check(
      occurrence_count(content, followup_prompt) == 1
        and not (line_containing(content, followup_prompt) or ''):find(
          '[cli-write-reviewer]',
          1,
          true
        ),
      '/resume rendered a running sub-agent follow-up in write_agent tool details'
    ) then
      finish()
      return
    end
    if not check(
      not content:find('SUBAGENT INTERNAL RESPONSE MUST NOT RENDER AS STANDARD COPILOT', 1, true),
      '/resume kept sub-agent internal responses out of the root Copilot transcript'
    ) then
      finish()
      return
    end
    if not check(
      content:find('[instruction] Repository instructions', 1, true)
        and not has_quoted_instruction(content),
      '/resume restored instruction discovery without blockquote markers'
    ) then
      finish()
      return
    end
    local timestamp_tool = line_containing(content, 'history-timestamp-probe.txt') or ''
    local timestamp_heading = heading_before(content, 'history-timestamp-probe.txt') or ''
    local heading_time = timestamp_heading:match('(%d%d:%d%d:%d%d)')
    local tool_time = timestamp_tool:match('%[(%d%d:%d%d:%d%d) %-')
    if not check(
      heading_time ~= nil and heading_time == tool_time,
      '/resume used the historical tool time for synthetic Copilot headings'
    ) then
      finish()
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
    local prompt_buf = assert(prompt(), 'prompt buffer was not found')
    vim.api.nvim_buf_set_lines(
      prompt_buf,
      0,
      -1,
      false,
      { 'Keep this prompt queued in compact mode.' }
    )
    local queued, queue_error = pcall(
      vim.api.nvim_buf_call,
      prompt_buf,
      native.enqueue_prompt
    )
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
