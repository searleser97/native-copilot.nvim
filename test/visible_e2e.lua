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
local manual_scroll_top
local conversation_height_before_scroll
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

local function line_with_after(buf, needle, after_row)
  local lines = vim.api.nvim_buf_get_lines(buf, after_row or 0, -1, false)
  for index, line in ipairs(lines) do
    if line:find(needle, 1, true) then return (after_row or 0) + index end
  end
end

local function task_marker(id, tool_call_id)
  if tool_call_id then return '[task_' .. tool_call_id .. ']' end
  return '[task_' .. vim.fn.sha256(('standard\0%s'):format(id)):sub(1, 16) .. ']'
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

local function submit(content, lhs, mode)
  local buf = assert(prompt(), 'prompt buffer was not found')
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, { content })
  local mapping = vim.api.nvim_buf_call(buf, function()
    return vim.fn.maparg(lhs or '<CR>', mode or 'n', false, true)
  end)
  assert(mapping.callback, 'prompt submit mapping was not found')
  return vim.api.nvim_buf_call(buf, mapping.callback)
end

local function prompt_mapping(lhs, mode)
  local buf = assert(prompt(), 'prompt buffer was not found')
  local mapping = vim.api.nvim_buf_call(buf, function()
    return vim.fn.maparg(lhs, mode, false, true)
  end)
  assert(mapping.callback, ('prompt mapping %s (%s) was not found'):format(lhs, mode))
  return mapping.callback
end

local function resume_cli_session()
  submit('/resume')
  phase = 'resume'
  schedule_tick()
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
    if not check(
      not has_quoted_environment(content),
      'environment rows rendered without blockquote markers'
    ) then
      return
    end
    if not check(
      content:find('[instruction] Live repository instructions', 1, true)
        and not has_quoted_instruction(content),
      'live instruction discovery used the unquoted instruction timeline'
    ) then
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
    local original_notify = vim.notify
    local outside_warning
    vim.notify = function(message) outside_warning = message end
    local outside_submit = vim.api.nvim_buf_call(buf, native.submit_prompt)
    vim.notify = original_notify
    if not check(
      outside_submit == false
        and outside_warning
          == 'Prompt submission is only available from the Native Copilot prompt buffer.',
      'public prompt submission rejected calls outside the prompt buffer'
    ) then
      return
    end
    local prompt_buf = assert(prompt(), 'prompt buffer was not found')
    local draft = 'Keep this draft while changing recipients.'
    vim.api.nvim_buf_set_lines(prompt_buf, 0, -1, false, { draft })
    native._on_event({
      type = 'fleet.ready',
      payload = {
        fleetId = 'e2e-recipient-cycle',
        name = 'Recipient Cycle',
        entryMember = 'e2e-recipient-cycle/planner',
        members = {
          { id = 'e2e-recipient-cycle/planner', displayName = 'Planner' },
          { id = 'e2e-recipient-cycle/reviewer', displayName = 'Reviewer' },
        },
      },
    })
    prompt_mapping(']a', 'n')()
    local normal_target = vim.b[prompt_buf].native_copilot_target
    local normal_preserved = text(prompt_buf) == draft
      and vim.api.nvim_get_current_buf() == prompt_buf
    native.cycle_member(1)
    local public_api_target = vim.b[prompt_buf].native_copilot_target
    local public_api_preserved = text(prompt_buf) == draft
      and vim.api.nvim_get_current_buf() == prompt_buf
    local removed_insert_mapping = vim.api.nvim_buf_call(prompt_buf, function()
      return vim.fn.maparg('<C-Right>', 'i') == ''
    end)
    if not check(
      normal_target == 'e2e-recipient-cycle/planner'
        and public_api_target == 'e2e-recipient-cycle/reviewer'
        and normal_preserved
        and public_api_preserved
        and removed_insert_mapping,
      'prompt mapping and public API cycled recipients without extra insert bindings'
    ) then
      return
    end
    native._on_event({
      type = 'fleet.stopped',
      payload = {
        fleetId = 'e2e-recipient-cycle',
        members = {
          'e2e-recipient-cycle/planner',
          'e2e-recipient-cycle/reviewer',
        },
      },
    })
    local insert_submitted = submit(
      'Run a background workspace validation and keep explaining while it finishes.',
      '<C-s>',
      'i'
    )
    if not check(
      insert_submitted == true and text(prompt_buf) == '',
      'insert-mode Ctrl-S submitted through the public prompt API'
    ) then
      return
    end
    phase = 'task'
    schedule_tick()
  elseif phase == 'task' then
    local stream_begin =
      content:find('I started the workspace validation in the background.', 1, true)
    local stream_end = content:find('without splitting this message.', stream_begin or 1, true)
    local task_header = content:find('📝 · ', stream_end or 1, true)
    local task_complete =
      content:find(
        task_marker('e2e-task', 'e2e-async-shell') .. ' completed',
        task_header or 1,
        true
      )
    if not (stream_begin and stream_end and task_header and task_complete) then
      schedule_tick()
      return
    end
    if not check(stream_begin < stream_end and stream_end < task_header, 'task completion deferred after reply') then
      return
    end
    if not check(
      select(
        2,
        content:gsub(
          vim.pesc(task_marker('e2e-task', 'e2e-async-shell') .. ' completed'),
          ''
        )
      ) == 1,
      'task completion rendered once'
    ) then
      return
    end
    local conversation_windows = vim.fn.win_findbuf(buf)
    if #conversation_windows > 0 then
      manual_scroll_top = vim.api.nvim_win_call(conversation_windows[1], function()
        conversation_height_before_scroll = vim.api.nvim_win_get_height(conversation_windows[1])
        vim.api.nvim_win_set_height(conversation_windows[1], 8)
        vim.api.nvim_win_set_cursor(conversation_windows[1], { 1, 0 })
        vim.cmd('normal! zt')
        return vim.fn.winsaveview().topline
      end)
    end
    phase = 'manual-scroll'
    schedule_tick()
  elseif phase == 'manual-scroll' then
    submit('Read the completed validation output and summarize the result.')
    phase = 'tool'
    schedule_tick()
  elseif phase == 'tool' then
    local tool_prompt = content:find('Read the completed validation output', 1, true)
    local copilot_header = tool_prompt and content:find('🤖 · ', tool_prompt, true)
    local tool_row = copilot_header
      and content:find(
        '🟢 powershell — Read completed validation output',
        copilot_header,
        true
      )
    local reply = tool_row
      and content:find(
        'The background validation completed successfully with exit code 0.',
        tool_row,
        true
      )
    if not (copilot_header and tool_row and reply) then
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
      not tool_line:find('The background validation completed successfully', 1, true),
      'foreground tool and Copilot reply use separate lines'
    ) then
      return
    end
    if not check(
      not tool_line:find('[e2e-read]', 1, true),
      'synchronous PowerShell summary renders without an unnecessary Tool ID'
    ) then
      return
    end
    local conversation_windows = vim.fn.win_findbuf(buf)
    local preserved_scroll
    if #conversation_windows > 0 then
      preserved_scroll = vim.api.nvim_win_call(conversation_windows[1], function()
        local preserved = vim.fn.winsaveview().topline == manual_scroll_top
        if conversation_height_before_scroll then
          vim.api.nvim_win_set_height(
            conversation_windows[1],
            conversation_height_before_scroll
          )
        end
        vim.api.nvim_win_set_cursor(
          conversation_windows[1],
          { vim.api.nvim_buf_line_count(buf), 0 }
        )
        vim.cmd('normal! zb')
        return preserved
      end)
    end
    if not check(
      preserved_scroll == true,
      'new output preserves a conversation viewport that the user scrolled upward'
    ) then
      return
    end
    phase = 'resume-follow'
    schedule_tick()
  elseif phase == 'resume-follow' then
    submit(
      'Investigate the event-ordering issue, use the available result, and explain your conclusion.'
    )
    phase = 'reasoning-stream'
    schedule_tick()
  elseif phase == 'reasoning-stream' then
    local first_reasoning =
      content:find('The completion event arrived while the foreground response was still active.', 1, true)
    if not first_reasoning then
      schedule_tick()
      return
    end
    if not check(
      not content:find('The event order is correct:', first_reasoning, true),
      'reasoning stream became visible before the final response'
    ) then
      return
    end
    phase = 'reasoning-complete'
    schedule_tick()
  elseif phase == 'reasoning-complete' then
    local reasoning_task_start =
      content:find(
        task_marker('e2e-reasoning-task', 'e2e-reasoning-background') .. ' started',
        1,
        true
      )
    local first_reasoning =
      content:find('The completion event arrived while the foreground response was still active.', 1, true)
    local second_reasoning = content:find(
      'Next, I need to inspect the completed command before composing the final answer.',
      first_reasoning or 1,
      true
    )
    local tool_row = second_reasoning
      and content:find('🟢 read_powershell', second_reasoning, true)
    local final_response = tool_row
      and content:find('The event order is correct:', tool_row, true)
    local task_header = final_response and content:find('📝 · ', final_response, true)
    local task_row = task_header
      and content:find(
        task_marker('e2e-reasoning-task', 'e2e-reasoning-background') .. ' completed',
        task_header,
        true
      )
    if not (
      reasoning_task_start
      and first_reasoning
      and second_reasoning
      and tool_row
      and final_response
      and task_row
    ) then
      schedule_tick()
      return
    end
    if not check(
      select(2, content:gsub('The completion event arrived while the foreground response was still active%.', '')) == 1
        and select(2, content:gsub('Next, I need to inspect the completed command before composing the final answer%.', '')) == 1,
      'consecutive reasoning summaries rendered once'
    ) then
      return
    end
    if not check(
      reasoning_task_start < first_reasoning
        and first_reasoning < second_reasoning
        and second_reasoning < tool_row
        and tool_row < final_response
        and final_response < task_row,
      'reasoning, Tool, final response, and deferred Task kept event order'
    ) then
      return
    end
    local first_row =
      line_with(buf, 'The completion event arrived while the foreground response was still active.')
    local second_row =
      line_with(buf, 'Next, I need to inspect the completed command before composing the final answer.')
    local second_paragraph_row =
      line_with(buf, 'I should preserve this second paragraph inside the same reasoning fold.')
    local third_paragraph_row = line_with(
      buf,
      'Closing the fold from this third paragraph must collapse the complete reasoning block.'
    )
    local tool_line = line_with_after(buf, '🟢 read_powershell', second_row)
    local final_row = line_with(buf, 'The event order is correct:')
    local windows = vim.fn.win_findbuf(buf)
    local fold
    local bottom_margin
    if
      first_row
      and second_row
      and second_paragraph_row
      and third_paragraph_row
      and tool_line
      and final_row
      and #windows > 0
    then
      fold = vim.api.nvim_win_call(windows[1], function()
        bottom_margin = vim.api.nvim_win_get_height(windows[1]) - vim.fn.winline()
        vim.api.nvim_win_set_cursor(windows[1], { third_paragraph_row, 0 })
        local closed_from_third = pcall(vim.cmd, 'normal! zc')
        local first_start = vim.fn.foldclosed(first_row)
        local second_start = vim.fn.foldclosed(second_row)
        local second_paragraph_start = vim.fn.foldclosed(second_paragraph_row)
        local third_paragraph_start = vim.fn.foldclosed(third_paragraph_row)
        local fold_end = vim.fn.foldclosedend(first_row)
        local tool_start = vim.fn.foldclosed(tool_line)
        local final_start = vim.fn.foldclosed(final_row)
        vim.cmd('normal! zR')
        return {
          first_start = first_start,
          second_start = second_start,
          second_paragraph_start = second_paragraph_start,
          third_paragraph_start = third_paragraph_start,
          fold_end = fold_end,
          tool_start = tool_start,
          final_start = final_start,
          closed_from_third = closed_from_third,
          reopened = vim.fn.foldclosed(first_row),
        }
      end)
    end
    if fold then
      append_trace({
        ('fold first=%s second=%s paragraph2=%s paragraph3=%s end=%s tool=%s final=%s closed_from_third=%s reopened=%s'):format(
          fold.first_start,
          fold.second_start,
          fold.second_paragraph_start,
          fold.third_paragraph_start,
          fold.fold_end,
          fold.tool_start,
          fold.final_start,
          fold.closed_from_third,
          fold.reopened
        ),
      })
    end
    if not check(
      fold
        and fold.closed_from_third
        and fold.first_start > 0
        and fold.first_start == fold.second_start
        and fold.first_start == fold.second_paragraph_start
        and fold.first_start == fold.third_paragraph_start
        and fold.fold_end < tool_line
        and fold.tool_start == -1
        and fold.final_start == -1,
      'folding from a later reasoning paragraph collapses the complete reasoning block'
    ) then
      return
    end
    local line_before_second = second_row
      and vim.api.nvim_buf_get_lines(buf, second_row - 2, second_row - 1, false)[1]
    if not check(
      line_before_second and line_before_second:match('^%s*$') ~= nil,
      'consecutive reasoning thoughts are separated by a blank line'
    ) then
      return
    end
    if not check(fold.reopened == -1, 'reasoning fold opens and closes through native fold commands') then
      return
    end
    if not check(
      bottom_margin and bottom_margin >= 2,
      'conversation viewport keeps padding below the final line'
    ) then
      return
    end
    if profile == 'manual-permissions' then
      submit('Run a harmless PowerShell command so I can approve it.')
      phase = 'permission'
      schedule_tick()
    else
      resume_cli_session()
    end
  elseif phase == 'permission' then
    if not (
      content:find(
        "[permission] shell — approved once: Write-Output 'observation approved'",
        1,
        true
      )
      and content:find('The approved PowerShell command completed successfully.', 1, true)
    ) then
      schedule_tick()
      return
    end
    if not check(true, 'interactive permission approved through visible picker') then return end
    resume_cli_session()
  elseif phase == 'resume' then
    local user_message =
      content:find('Inspect this workspace and validate it without blocking the conversation.', 1, true)
    local reasoning =
      content:find('I should inspect the project structure first.', user_message or 1, true)
    local tool_row = reasoning
      and content:find('🟢 glob', reasoning, true)
    local instruction = tool_row
      and content:find('[instruction] Repository instructions', tool_row, true)
    local permission = instruction
      and content:find('[permission] shell — approved: npm run check', instruction, true)
    local first_reply = permission
      and content:find(
        'The workspace contains both the TypeScript host and the Neovim Lua client.',
        permission,
        true
      )
    local task_start = first_reply
      and content:find(
        task_marker('cli-shell-7', 'cli-shell') .. ' started',
        first_reply,
        true
      )
    local task_complete = task_start
      and content:find(
        task_marker('cli-shell-7', 'cli-shell') .. ' completed',
        task_start,
        true
      )
    local second_user = task_complete
      and content:find('Schedule an hourly workspace recheck, then cancel it.', task_complete, true)
    local schedule_created = second_user
      and content:find('[schedule][1] created', second_user, true)
    local schedule_cancelled = schedule_created
      and content:find('[schedule][1] cancelled', schedule_created, true)
    local final_reply = schedule_cancelled
      and content:find(
        'Validation completed successfully, and the temporary recurring check was cancelled.',
        schedule_cancelled,
        true
      )
    local agent_task = final_reply
      and content:find(
        task_marker('cli-reviewer', 'cli-review-tool') .. ' completed',
        final_reply,
        true
      )
    if not (
      user_message
      and reasoning
      and tool_row
      and instruction
      and first_reply
      and task_start
      and task_complete
      and permission
      and second_user
      and schedule_created
      and schedule_cancelled
      and final_reply
      and agent_task
    ) then
      schedule_tick()
      return
    end
    if not check(
      not content:find('Run a background workspace validation', 1, true),
      'resuming a CLI session replaced the previous Standard buffer'
    ) then
      return
    end
    local history_epoch = 1788188400
    if not check(
      content:find(
        ('──────── %s ────────'):format(os.date('%A, %B %d', history_epoch)),
        1,
        true
      ) ~= nil
        and content:find('👨 · ' .. os.date('%H:%M:%S', history_epoch), 1, true) ~= nil,
      'CLI session replay preserved original event timestamps'
    ) then
      return
    end
    local before_history = content:sub(1, user_message)
    local _, historical_day_headers = before_history:gsub('──────── ', '')
    if not check(
      historical_day_headers == 1,
      'CLI session replay began with the persisted historical date header'
    ) then
      return
    end
    if not check(
      user_message < reasoning
        and reasoning < tool_row
        and tool_row < instruction
        and instruction < permission
        and permission < first_reply
        and first_reply < task_start
        and task_start < task_complete
        and task_complete < second_user
        and second_user < schedule_created
        and schedule_created < schedule_cancelled
        and schedule_cancelled < final_reply
        and final_reply < agent_task,
      'CLI session history preserved durable timeline order'
    ) then
      return
    end
    local tools = content:find('[environment] Tools — 4 loaded', agent_task, true)
    local instructions = tools
      and content:find('[environment] Instructions — 1 loaded', tools, true)
    local skills = instructions
      and content:find('[environment] Skills — 0 loaded', instructions, true)
    local plugins = skills
      and content:find('[environment] Plugins — 0 loaded', skills, true)
    local agents = plugins
      and content:find('[environment] Agents — 0 loaded', plugins, true)
    local environment_ready =
      content:find('[environment] Copilot environment — ready', agent_task, true)
    local mcp_ready = profile == 'allow-all'
      and not content:find('[environment] MCP ', agent_task, true)
      or profile == 'allow-all-mcp'
        and content:find('MCP mock-files — connected', agent_task, true)
        and content:find('MCP mock-broken — failed', agent_task, true)
      or profile == 'manual-permissions'
        and content:find('MCP mock-permissions — connected', agent_task, true)
    if not check(
      tools and instructions and skills and plugins and agents and environment_ready and mcp_ready,
      'CLI session resume restored current Tools, MCP, and environment rows'
    ) then
      return
    end
    if not check(
      not content:find('DUPLICATE EPHEMERAL CONTENT', 1, true),
      'CLI session replay omitted ephemeral streaming deltas'
    ) then
      return
    end
    if not check(
      not has_quoted_instruction(content),
      'CLI session replay rendered instruction discovery without blockquote markers'
    ) then
      return
    end
    if not check(
      not content:find('<system_notification>', 1, true),
      'CLI system notifications replayed as structured Task rows'
    ) then
      return
    end
    finish()
  end
end

schedule_tick()
