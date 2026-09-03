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
local manual_scroll_cursor
local conversation_height_before_scroll
local reasoning_cursor
local followed_cursor
local processing_result_winbar_seen = false
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
  local payload = message.payload or {}
  if message.type == 'activity.event' and payload.eventType == 'tool.execution_complete' then
    local entry = buffers.get_member(message.memberId or 'standard')
    local windows = entry and vim.fn.win_findbuf(entry.views.conversation.buf) or {}
    local winbar = #windows > 0 and vim.wo[windows[1]].winbar or ''
    processing_result_winbar_seen =
      processing_result_winbar_seen
      or winbar:find('Status: Processing result · 0s', 1, true) ~= nil
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

local function line_at(content, offset)
  local start = (content:sub(1, offset):match('.*()\n') or 0) + 1
  local finish = content:find('\n', offset, true) or (#content + 1)
  return content:sub(start, finish - 1)
end

local function status_sign_at(buf, needle)
  for row, line in ipairs(vim.api.nvim_buf_get_lines(buf, 0, -1, false)) do
    if line:find(needle, 1, true) then
      local marks = vim.api.nvim_buf_get_extmarks(
        buf,
        -1,
        { row - 1, 0 },
        { row, 0 },
        { details = true }
      )
      for _, mark in ipairs(marks) do
        local details = mark[4] or {}
        if details.sign_text then
          return vim.trim(details.sign_text), details.sign_hl_group, details.number_hl_group
        end
      end
    end
  end
end

local function actor_sign_before(buf, needle)
  local row = line_with(buf, needle)
  if not row then return end
  for candidate = row, math.max(1, row - 3), -1 do
    local marks = vim.api.nvim_buf_get_extmarks(
      buf,
      -1,
      { candidate - 1, 0 },
      { candidate, 0 },
      { details = true }
    )
    for _, mark in ipairs(marks) do
      local details = mark[4] or {}
      local sign = details.sign_text and vim.trim(details.sign_text) or nil
      if sign == '👨' or sign == '🤖' or sign == '📝' then return sign end
    end
  end
end

local function has_sign_on_empty_line(buf)
  local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
  local marks = vim.api.nvim_buf_get_extmarks(
    buf,
    -1,
    { 0, 0 },
    { -1, -1 },
    { details = true }
  )
  for _, mark in ipairs(marks) do
    local details = mark[4] or {}
    local line = lines[mark[2] + 1] or ''
    local sign = details.sign_text and vim.trim(details.sign_text) or nil
    if sign and line:match('^%s*$') then return true end
  end
  return false
end

local function task_marker(id, task_type)
  return ('[%s_%s]'):format(task_type or 'shell_cmd', id)
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
    local session_id = content:find('[SessionId][e2e-standard-session]', 1, true)
    local first_environment = content:find('[environment]', 1, true)
    if not check(
      session_id
        and first_environment
        and session_id < first_environment
        and content:find('\n\n[SessionId][e2e-standard-session]', 1, true),
      'new sessions rendered a separated identity marker before environment rows'
    ) then
      return
    end
    if not check(
      not has_sign_on_empty_line(buf),
      'environment lifecycle signs remained on their owning rows'
    ) then
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
    submit('Delay the assistant turn start so the pending UI can be checked.')
    local pending_content = text(buf)
    local prompt_offset = pending_content:find('Delay the assistant turn start', 1, true)
    if not check(
      prompt_offset
        and line_at(pending_content, prompt_offset)
          == 'Delay the assistant turn start so the pending UI can be checked.'
        and actor_sign_before(buf, 'Delay the assistant turn start') == '👨'
        and not pending_content:find('writing', 1, true),
      'prompt submission waited for SDK turn start before showing writing'
    ) then
      return
    end
    phase = 'delayed-turn-start'
    schedule_tick()
  elseif phase == 'delayed-turn-start' then
    if not content:find('The delayed assistant turn started normally.', 1, true) then
      schedule_tick()
      return
    end
    if not check(
      actor_sign_before(buf, 'The delayed assistant turn started normally.') == '🤖'
        and not content:find('writing', 1, true)
        and not content:find('🤖 · ', 1, true),
      'delayed SDK turn completed without leaving a writing indicator'
    ) then
      return
    end
    local insert_submitted = submit(
      'Start a foreground turn that waits for steering.',
      '<C-s>',
      'i'
    )
    if not check(
      insert_submitted == true and text(assert(prompt())) == '',
      'insert-mode Ctrl-S submitted through the public prompt API'
    ) then
      return
    end
    phase = 'steering-running'
    schedule_tick()
  elseif phase == 'steering-running' then
    if not content:find('The foreground turn is waiting for steering.', 1, true) then
      schedule_tick()
      return
    end
    if not check(
      submit('Steer the active foreground turn now.') == true,
      'busy Copilot accepted an immediate steering submission'
    ) then
      return
    end
    phase = 'steering-complete'
    schedule_tick()
  elseif phase == 'steering-complete' then
    local steering_prompt = content:find('Steer the active foreground turn now.', 1, true)
    local steering_reply = steering_prompt
      and content:find(
        'SCRIPTED-REPLY: Steer the active foreground turn now.',
        steering_prompt,
        true
      )
    if not steering_reply then
      schedule_tick()
      return
    end
    local queue = find_buffer(function(candidate)
      return text(candidate):find('Steer the active foreground turn now.', 1, true) ~= nil
        and vim.b[candidate].native_copilot_prompt_queue == true
    end)
    if not check(
      queue == nil,
      'immediate steering bypassed the explicit FIFO prompt queue'
    ) then
      return
    end
    submit('Run a background workspace validation and keep explaining while it finishes.')
    phase = 'task'
    schedule_tick()
  elseif phase == 'task' then
    local create_row = content:find('create — src/generated.ts', 1, true)
    local edit_row = create_row
      and content:find('edit — src/existing.ts', create_row, true)
    local stream_begin =
      content:find('I started the workspace validation in the background.', 1, true)
    local stream_end = content:find('without splitting this message.', stream_begin or 1, true)
    local task_complete =
      content:find(
        task_marker('e2e-task') .. ' completed',
        stream_end or 1,
        true
      )
    if not (create_row and edit_row and stream_begin and stream_end and task_complete) then
      schedule_tick()
      return
    end
    if not check(
      create_row < edit_row and edit_row < stream_begin,
      'create and edit Tools show their target paths'
    ) then
      return
    end
    if not check(stream_begin < stream_end and stream_end < task_complete, 'task completion deferred after reply') then
      return
    end
    if not check(
      select(
        2,
        content:gsub(
          vim.pesc(task_marker('e2e-task') .. ' completed'),
          ''
        )
      ) == 1,
      'task completion rendered once'
    ) then
      return
    end
    local task_complete_line = line_at(content, task_complete)
    if not check(
      not task_complete_line:find('🟢', 1, true)
        and not task_complete_line:find('🟡', 1, true),
      'Task-authored completion omitted a redundant status icon'
    ) then
      return
    end
    local task_complete_heading = content:sub(1, task_complete):match('([^\n]*)\n\n[^\n]*$')
    if not check(
      task_complete_heading
        and actor_sign_before(buf, task_marker('e2e-task') .. ' completed') == '📝',
      'task completion rendered under the Task actor'
    ) then
      return
    end
    if not check(
      content:find(
        'powershell — Validate workspace in background'
          .. ' · '
          .. task_marker('e2e-task'),
        1,
        true
      ) ~= nil,
      'background shell metadata stayed on the original Tool row'
    ) then
      return
    end
    local background_tool_line = line_at(
      content,
      content:find('powershell — Validate workspace in background', 1, true)
    )
    if not check(
      not background_tool_line:find('[e2e-async-shell]', 1, true),
      'background shell hides its internal Tool call ID'
    ) then
      return
    end
    if not check(
      not content:find(
        task_marker('e2e-task') .. ' moved to background',
        1,
        true
      ),
      'initially background shell did not invent a promotion transition'
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
        manual_scroll_cursor = vim.api.nvim_win_get_cursor(conversation_windows[1])
        return vim.fn.winsaveview().topline
      end)
    end
    phase = 'manual-scroll'
    schedule_tick()
  elseif phase == 'manual-scroll' then
    submit('Read the completed validation output and summarize the result.')
    local conversation_windows = vim.fn.win_findbuf(buf)
    local submission_followed_bottom
    if #conversation_windows > 0 then
      local win = conversation_windows[1]
      submission_followed_bottom = vim.api.nvim_win_call(win, function()
        local last_line = vim.api.nvim_buf_line_count(buf)
        local cursor = vim.api.nvim_win_get_cursor(win)
        return cursor[1] == last_line and vim.fn.line('w$') >= last_line
      end)
      manual_scroll_top = vim.api.nvim_win_call(win, function()
        vim.api.nvim_win_set_cursor(win, { 1, 0 })
        vim.cmd('normal! zt')
        manual_scroll_cursor = vim.api.nvim_win_get_cursor(win)
        return vim.fn.winsaveview().topline
      end)
      buffers.on_view_moved(win, 'CursorMoved')
    end
    if not check(
      submission_followed_bottom == true,
      'sending a user message restores following and scrolls to EOF'
    ) then
      return
    end
    phase = 'tool'
    schedule_tick()
  elseif phase == 'tool' then
    local tool_prompt = content:find('Read the completed validation output', 1, true)
    local copilot_header = tool_prompt
      and content:find('\n%d%d:%d%d:%d%d\n\n', tool_prompt)
    local tool_row = copilot_header
      and content:find(
        'powershell — Read completed validation output and summarize only the final status',
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
      processing_result_winbar_seen,
      'winbar reports Copilot processing a completed Tool result'
    ) then
      return
    end
    if not check(
      copilot_header < tool_row
        and tool_row < reply,
      'foreground synchronous shell Tool updated one row in place'
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
      'ordinary synchronous PowerShell Tool hides its unnecessary call ID'
    ) then
      return
    end
    if not check(
      not tool_line:find(task_marker('e2e-sync-shell'), 1, true),
      'ordinary synchronous PowerShell hides its internal shell ID'
    ) then
      return
    end
    local tool_sign, tool_sign_hl, tool_number_hl =
      status_sign_at(buf, 'powershell — Read completed validation output')
    if not check(
      tool_sign == '✓'
        and tool_sign_hl == 'NativeCopilotStatusCompleted'
        and tool_number_hl == nil,
      'completed Tool colors only its gutter sign'
    ) then
      return
    end
    if not check(
      tool_line:find('... · ', 1, true) ~= nil
        and not tool_line:find('unrelated diagnostic details', 1, true),
      'long Tool summaries are truncated inline'
    ) then
      return
    end
    local conversation_windows = vim.fn.win_findbuf(buf)
    local preserved_scroll
    local preserved_cursor
    if #conversation_windows > 0 then
      preserved_scroll = vim.api.nvim_win_call(conversation_windows[1], function()
        local preserved = vim.fn.winsaveview().topline == manual_scroll_top
        preserved_cursor =
          vim.deep_equal(vim.api.nvim_win_get_cursor(conversation_windows[1]), manual_scroll_cursor)
        if conversation_height_before_scroll then
          vim.api.nvim_win_set_height(
            conversation_windows[1],
            math.min(conversation_height_before_scroll, 8)
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
    if not check(
      preserved_cursor == true,
      'new output preserves the conversation cursor'
    ) then
      return
    end
    phase = 'resume-follow'
    schedule_tick()
  elseif phase == 'resume-follow' then
    local conversation_windows = vim.fn.win_findbuf(buf)
    if #conversation_windows > 0 then
      reasoning_cursor = vim.api.nvim_win_get_cursor(conversation_windows[1])
    end
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
        'powershell — Refresh validation metadata · '
          .. task_marker('e2e-reasoning-task'),
        1,
        true
      )
    local reasoning_task_promoted = reasoning_task_start
      and content:find(
        task_marker('e2e-reasoning-task')
          .. ' moved to background',
        reasoning_task_start,
        true
      )
    local first_reasoning =
      content:find(
        'The completion event arrived while the foreground response was still active.',
        reasoning_task_promoted or 1,
        true
      )
    local resumed_copilot = reasoning_task_promoted
      and content:find('\n%d%d:%d%d:%d%d\n\n', reasoning_task_promoted)
    local second_reasoning = content:find(
      'Next, I need to inspect the completed command before composing the final answer.',
      first_reasoning or 1,
      true
    )
    local tool_row = second_reasoning
      and content:find('read_powershell', second_reasoning, true)
    local final_response = tool_row
      and content:find('The event order is correct:', tool_row, true)
    local task_row = final_response
      and content:find(
        task_marker('e2e-reasoning-task') .. ' completed',
        final_response,
        true
      )
    if not (
      reasoning_task_start
      and reasoning_task_promoted
      and resumed_copilot
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
      select(
        2,
        content:gsub(
          vim.pesc(
            task_marker('e2e-reasoning-task')
              .. ' moved to background'
          ),
          ''
        )
      ) == 1,
      'sync-to-background transition rendered once'
    ) then
      return
    end
    local promoted_line = line_at(content, reasoning_task_promoted)
    if not check(
      not promoted_line:find('🟢', 1, true)
        and not promoted_line:find('🟡', 1, true),
      'Task-authored background promotion omitted a status icon'
    ) then
      return
    end
    local reader_line = line_at(content, tool_row)
    if not check(
      not reader_line:find('[e2e-reasoning-tool]', 1, true),
      'Tool timeline rows hide internal Tool call IDs'
    ) then
      return
    end
    if not check(
      not reader_line:find('— completed', 1, true)
        and not reader_line:find('— processing', 1, true),
      'Tool rows omit textual lifecycle status'
    ) then
      return
    end
    if not check(
      reader_line:match('· %[%d%d:%d%d:%d%d %- %d%d:%d%d:%d%d%]$') ~= nil,
      'completed Tool row shows its start and end time interval'
    ) then
      return
    end
    local promoted_heading = content:sub(1, reasoning_task_promoted):match('([^\n]*)\n\n[^\n]*$')
    if not check(
      promoted_heading
        and actor_sign_before(
          buf,
          task_marker('e2e-reasoning-task') .. ' moved to background'
        ) == '📝',
      'background promotion rendered under the Task actor'
    ) then
      return
    end
    if not check(
      reasoning_task_start < first_reasoning
        and reasoning_task_start < reasoning_task_promoted
        and reasoning_task_promoted < resumed_copilot
        and resumed_copilot < first_reasoning
        and reasoning_task_promoted < first_reasoning
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
    local tool_line = line_with_after(buf, 'read_powershell', second_row)
    local final_row = line_with(buf, 'The event order is correct:')
    local windows = vim.fn.win_findbuf(buf)
    local fold
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
        local cursor = vim.api.nvim_win_get_cursor(windows[1])
        followed_cursor = {
          advanced = cursor[1] > reasoning_cursor[1],
          pinned_to_top = cursor[1] == vim.fn.line('w0'),
          viewport_at_bottom = vim.fn.line('w$') >= vim.api.nvim_buf_line_count(buf),
        }
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
      followed_cursor
        and followed_cursor.advanced
        and followed_cursor.pinned_to_top
        and followed_cursor.viewport_at_bottom,
      'streaming pins the cursor to the top visible line while following EOF'
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
    if not content:find('The approved PowerShell command completed successfully.', 1, true) then
      schedule_tick()
      return
    end
    if not check(
      not content:find('[permission]', 1, true)
        and not has_sign_on_empty_line(buf),
      'interactive permission row and sign are removed after the decision'
    ) then
      return
    end
    resume_cli_session()
  elseif phase == 'resume' then
    local user_message =
      content:find('Inspect this workspace and validate it without blocking the conversation.', 1, true)
    local reasoning =
      content:find('I should inspect the project structure first.', user_message or 1, true)
    local tool_row = reasoning
      and content:find('glob', reasoning, true)
    local instruction = tool_row
      and content:find('[instruction] Repository instructions', tool_row, true)
    local first_reply = instruction
      and content:find(
        'The workspace contains both the TypeScript host and the Neovim Lua client.',
        instruction,
        true
      )
    local task_start = first_reply
      and content:find(
        'powershell — Validate the workspace · ' .. task_marker('cli-shell-7'),
        first_reply,
        true
      )
    local task_complete = task_start
      and content:find(
        task_marker('cli-shell-7') .. ' completed',
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
        task_marker('cli-reviewer', 'agent') .. ' completed',
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
        and content:find(os.date('%H:%M:%S', history_epoch), 1, true) ~= nil
        and actor_sign_before(
          buf,
          'Inspect this workspace and validate it without blocking the conversation.'
        ) == '👨',
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
        and instruction < first_reply
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
    local session_id = content:find('[SessionId][e2e-cli-session]', agent_task, true)
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
      session_id
        and tools
        and session_id < tools
        and content:sub(agent_task, tools):find(
          '\n\n[SessionId][e2e-cli-session]',
          1,
          true
        ),
      'CLI session resume separated identity from history before environment rows'
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
