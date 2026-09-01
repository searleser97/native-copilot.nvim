if vim.v.vim_did_enter == 0 then
  local script = debug.getinfo(1, 'S').source:sub(2)
  vim.api.nvim_create_autocmd('VimEnter', {
    once = true,
    callback = function() dofile(script) end,
  })
  return
end

local root = assert(vim.env.NATIVE_COPILOT_E2E_ROOT, 'NATIVE_COPILOT_E2E_ROOT is required')
local profile = assert(vim.env.NATIVE_COPILOT_E2E_PROFILE, 'NATIVE_COPILOT_E2E_PROFILE is required')
local result_path = assert(vim.env.NATIVE_COPILOT_E2E_RESULT, 'NATIVE_COPILOT_E2E_RESULT is required')
local snapshot_path =
  assert(vim.env.NATIVE_COPILOT_E2E_SNAPSHOT, 'NATIVE_COPILOT_E2E_SNAPSHOT is required')
local trace_path = assert(vim.env.NATIVE_COPILOT_E2E_TRACE, 'NATIVE_COPILOT_E2E_TRACE is required')
local database_path =
  assert(vim.env.NATIVE_COPILOT_E2E_DATABASE, 'NATIVE_COPILOT_E2E_DATABASE is required')
local started_at = vim.uv.now()
local phase = 'ready'
local results = {}
local last_trace = 0
local completed = false
local tick

vim.opt.runtimepath:prepend(root)
vim.o.termguicolors = true
vim.fn.writefile({ 'loaded=true', 'profile=' .. profile }, trace_path)

local function append_trace(lines)
  vim.fn.writefile(lines, trace_path, 'a')
end

vim.ui.select = function(items, _, on_choice)
  vim.schedule(function() on_choice(items[1]) end)
end

local native = require('native_copilot')
local buffers = require('native_copilot.buffers')
local on_event = native._on_event
native._on_event = function(message)
  append_trace({ 'event=' .. tostring(message.type) })
  local ok, failure = xpcall(on_event, debug.traceback, message)
  if not ok then
    append_trace({ 'event_error=' .. tostring(failure):gsub('\n', '\\n') })
    error(failure)
  end
end

native.setup({
  workspace = root,
  database_path = database_path,
  runtime_command_resolver = nil,
  frontend = { completion = 'native', picker = 'native' },
})
native.open({ reuse_current_tab = true })

local function find_buffer(predicate)
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if predicate(buf) then return buf end
  end
end

local function conversation()
  return find_buffer(function(buf)
    return vim.api.nvim_buf_get_name(buf):find('native%-copilot://standard/conversation') ~= nil
  end)
end

local function prompt()
  return find_buffer(function(buf) return vim.b[buf].native_copilot_prompt == true end)
end

local function text(buf)
  return table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), '\n')
end

local function line_with(buf, needle)
  for row, line in ipairs(vim.api.nvim_buf_get_lines(buf, 0, -1, false)) do
    if line:find(needle, 1, true) then return row end
  end
end

local function pass(label)
  results[#results + 1] = 'PASS ' .. label
end

local function finish(failure)
  if completed then return end
  completed = true
  local buf = conversation()
  if buf then vim.fn.writefile(vim.api.nvim_buf_get_lines(buf, 0, -1, false), snapshot_path) end
  if failure then results[#results + 1] = 'FAIL ' .. failure end
  vim.fn.writefile(results, result_path)
  if vim.env.NATIVE_COPILOT_E2E_OBSERVE == '1' then
    vim.api.nvim_echo({
      { failure and 'Visible E2E failed — observation window left open.'
        or 'Visible E2E passed — observation window left open.' },
    }, false, {})
    return
  end
  vim.defer_fn(function() vim.cmd('qa!') end, failure and 1500 or 500)
end

local function schedule_tick()
  vim.defer_fn(function()
    local ok, error = xpcall(tick, debug.traceback)
    if not ok then finish(error) end
  end, 25)
end

local function check(condition, label)
  if not condition then
    finish(label)
    return false
  end
  pass(label)
  return true
end

local function submit(content)
  local buf = assert(prompt(), 'prompt buffer was not found')
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, { content })
  local mapping = vim.api.nvim_buf_call(buf, function()
    return vim.fn.maparg('<CR>', 'n', false, true)
  end)
  assert(mapping.callback, 'prompt submit mapping was not found')
  mapping.callback()
end

tick = function()
  local buf = conversation()
  local content = buf and text(buf) or ''
  if vim.uv.now() - last_trace >= 500 then
    append_trace({
      'phase=' .. phase,
      'elapsed=' .. tostring(vim.uv.now() - started_at),
      'conversation=' .. tostring(buf),
      'prompt=' .. tostring(prompt()),
      'content=' .. content:gsub('\n', '\\n'):sub(-2000),
    })
    last_trace = vim.uv.now()
  end
  if vim.uv.now() - started_at > 10000 then
    finish('visible E2E timed out in phase ' .. phase)
    return
  end

  if phase == 'ready' then
    if not content:find('[environment] Copilot environment — ready', 1, true) then
      schedule_tick()
      return
    end
    if not check(content:find('[environment] Tools — 4 loaded', 1, true), 'mock tools initialized') then
      return
    end
    if profile == 'allow-all' then
      if not check(not content:find('[environment] MCP ', 1, true), 'minimal profile omitted MCP servers') then
        return
      end
    elseif profile == 'allow-all-mcp' then
      if not check(content:find('MCP mock-files — connected', 1, true), 'mock MCP connected') then
        return
      end
      if not check(content:find('MCP mock-broken — failed', 1, true), 'mock MCP failure rendered') then
        return
      end
    else
      if not check(
        content:find('MCP mock-permissions — connected', 1, true),
        'permission profile MCP initialized'
      ) then
        return
      end
    end
    submit('E2E_TASK_DEFERRAL')
    phase = 'task'
    schedule_tick()
  elseif phase == 'task' then
    local stream_begin = content:find('STREAM-BEGIN', 1, true)
    local stream_end = content:find('STREAM-END', stream_begin or 1, true)
    local task_header = content:find('📝 · ', stream_end or 1, true)
    local task_complete = content:find('[task][e2e-task] completed', task_header or 1, true)
    if not (stream_begin and stream_end and task_header and task_complete) then
      schedule_tick()
      return
    end
    if not check(stream_begin < stream_end and stream_end < task_header, 'task completion deferred after reply') then
      return
    end
    if not check(
      select(2, content:gsub('%[task%]%[e2e%-task%] completed', '')) == 1,
      'task completion rendered once'
    ) then
      return
    end
    submit('E2E_TOOL_AUTHORSHIP')
    phase = 'tool'
    schedule_tick()
  elseif phase == 'tool' then
    local tool_prompt = content:find('E2E_TOOL_AUTHORSHIP', 1, true)
    local copilot_header = tool_prompt and content:find('🤖 · ', tool_prompt, true)
    local tool_row = copilot_header
      and content:find('[tool][e2e-read] read_powershell', copilot_header, true)
    local reply = tool_row and content:find('TOOL-AUTHOR-OK', tool_row, true)
    local task_header = reply and content:find('📝 · ', reply, true)
    local prior_task = task_header
      and content:find('[task][e2e-prior-task] completed', task_header, true)
    if not (copilot_header and tool_row and reply and task_header and prior_task) then
      schedule_tick()
      return
    end
    if not check(
      copilot_header < tool_row
        and tool_row < reply,
      'foreground tool rendered inside Copilot block'
    ) then
      return
    end
    local tool_line = content:sub(tool_row, content:find('\n', tool_row, true) or #content)
    if not check(
      not tool_line:find('TOOL-AUTHOR-OK', 1, true),
      'foreground tool and Copilot reply use separate lines'
    ) then
      return
    end
    if not check(
      reply < task_header and task_header < prior_task,
      'background task remained deferred until the foreground reply completed'
    ) then
      return
    end
    submit('E2E_REASONING_FOLDS')
    phase = 'reasoning-stream'
    schedule_tick()
  elseif phase == 'reasoning-stream' then
    local first_reasoning = content:find('REASONING-ONE-BEGIN', 1, true)
    if not first_reasoning then
      schedule_tick()
      return
    end
    if not check(
      not content:find('REASONING-FINAL-RESPONSE', first_reasoning, true),
      'reasoning stream became visible before the final response'
    ) then
      return
    end
    phase = 'reasoning-complete'
    schedule_tick()
  elseif phase == 'reasoning-complete' then
    local first_reasoning = content:find('REASONING-ONE-BEGIN', 1, true)
    local second_reasoning = content:find('REASONING-TWO-BEGIN', first_reasoning or 1, true)
    local tool_row = second_reasoning
      and content:find('[tool][e2e-reasoning-tool] reasoning_tool', second_reasoning, true)
    local final_response = tool_row
      and content:find('REASONING-FINAL-RESPONSE', tool_row, true)
    local task_header = final_response and content:find('📝 · ', final_response, true)
    local task_row = task_header
      and content:find('[task][e2e-reasoning-task] completed', task_header, true)
    if not (first_reasoning and second_reasoning and tool_row and final_response and task_row) then
      schedule_tick()
      return
    end
    if not check(
      select(2, content:gsub('REASONING%-ONE%-BEGIN', '')) == 1
        and select(2, content:gsub('REASONING%-TWO%-BEGIN', '')) == 1,
      'consecutive reasoning summaries rendered once'
    ) then
      return
    end
    if not check(
      first_reasoning < second_reasoning
        and second_reasoning < tool_row
        and tool_row < final_response
        and final_response < task_row,
      'reasoning, Tool, final response, and deferred Task kept event order'
    ) then
      return
    end
    local first_row = line_with(buf, 'REASONING-ONE-BEGIN')
    local second_row = line_with(buf, 'REASONING-TWO-BEGIN')
    local tool_line = line_with(buf, '[tool][e2e-reasoning-tool] reasoning_tool')
    local final_row = line_with(buf, 'REASONING-FINAL-RESPONSE')
    local windows = vim.fn.win_findbuf(buf)
    local fold
    if first_row and second_row and tool_line and final_row and #windows > 0 then
      fold = vim.api.nvim_win_call(windows[1], function()
        vim.cmd('normal! zx')
        vim.cmd('normal! zM')
        local first_start = vim.fn.foldclosed(first_row)
        local second_start = vim.fn.foldclosed(second_row)
        local fold_end = vim.fn.foldclosedend(first_row)
        local tool_start = vim.fn.foldclosed(tool_line)
        local final_start = vim.fn.foldclosed(final_row)
        vim.cmd('normal! zR')
        return {
          first_start = first_start,
          second_start = second_start,
          fold_end = fold_end,
          tool_start = tool_start,
          final_start = final_start,
          reopened = vim.fn.foldclosed(first_row),
        }
      end)
    end
    if fold then
      append_trace({
        ('fold first=%s second=%s end=%s tool=%s final=%s reopened=%s'):format(
          fold.first_start,
          fold.second_start,
          fold.fold_end,
          fold.tool_start,
          fold.final_start,
          fold.reopened
        ),
      })
    end
    if not check(
      fold
        and fold.first_start > 0
        and fold.first_start == fold.second_start
        and fold.fold_end < tool_line
        and fold.tool_start == -1
        and fold.final_start == -1,
      'consecutive reasoning summaries share a fold that excludes Tool and response rows'
    ) then
      return
    end
    if not check(fold.reopened == -1, 'reasoning fold opens and closes through native fold commands') then
      return
    end
    if profile == 'manual-permissions' then
      submit('E2E_PERMISSION')
      phase = 'permission'
      schedule_tick()
    else
      finish()
    end
  elseif phase == 'permission' then
    if not (
      content:find('[permission] shell — approved once: Write-Output E2E_PERMISSION', 1, true)
      and content:find('PERMISSION-APPROVED', 1, true)
    ) then
      schedule_tick()
      return
    end
    if not check(true, 'interactive permission approved through visible picker') then return end
    finish()
  end
end

schedule_tick()
