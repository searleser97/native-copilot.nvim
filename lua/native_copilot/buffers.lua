local M = {}

local registry = {}
local status_symbols = {
  running = '🟡',
  idle = '🟡',
  completed = '🟢',
  failed = '🔴',
  cancelled = '⚪',
  denied = '🚫',
  unknown = '❓',
}
local actor_symbols = {
  task = '📝',
  schedule = '⏰',
}
local actor_option_names = {
  task = 'task_label',
  schedule = 'scheduler_label',
  tool = 'tool_label',
}
local activity_namespace = vim.api.nvim_create_namespace('native_copilot_inline_activity')
local activity_body_namespace = vim.api.nvim_create_namespace('native_copilot_activity_body')
local activity_fold_namespace = vim.api.nvim_create_namespace('native_copilot_activity_fold')
local message_heading_namespace = vim.api.nvim_create_namespace('native_copilot_message_heading')
local header_highlight_namespace =
  vim.api.nvim_create_namespace('native_copilot_header_highlight')
local user_message_namespace = vim.api.nvim_create_namespace('native_copilot_user_message')
local task_message_namespace = vim.api.nvim_create_namespace('native_copilot_task_message')
local timeline_namespace = vim.api.nvim_create_namespace('native_copilot_timeline')
local content_indent = '   '
local quote_indent = content_indent .. '>'
local options = {
  stream_flush_ms = 80,
  follow_bottom = true,
  bottom_padding = 2,
  timestamp_format = '%H:%M:%S',
  now = os.time,
  conversation = {
    user_label = '👨',
    copilot_label = '🤖',
    task_label = '📝',
    tool_label = '🛠️ Tool',
    scheduler_label = '⏰ Scheduler',
    day_header_format = '%A, %B %d',
  },
}

local function timestamp(now)
  return os.date(options.timestamp_format, now or options.now())
end

local function blend_color(base, accent, accent_ratio)
  local function channel(color, shift)
    return math.floor(color / (2 ^ shift)) % 0x100
  end
  local function blend_channel(base_channel, accent_channel)
    return math.floor(base_channel + (accent_channel - base_channel) * accent_ratio + 0.5)
  end
  local red = blend_channel(channel(base, 16), channel(accent, 16))
  local green = blend_channel(channel(base, 8), channel(accent, 8))
  local blue = blend_channel(channel(base, 0), channel(accent, 0))
  return red * 0x10000 + green * 0x100 + blue
end

local function color_luminance(color)
  local red = math.floor(color / 0x10000) % 0x100
  local green = math.floor(color / 0x100) % 0x100
  local blue = color % 0x100
  return (red * 299 + green * 587 + blue * 114) / 1000
end

local function setup_highlights()
  vim.api.nvim_set_hl(0, 'NativeCopilotUserHeader', {
    default = true,
    link = 'DiagnosticInfo',
  })
  vim.api.nvim_set_hl(0, 'NativeCopilotAssistantHeader', {
    default = true,
    link = 'Special',
  })
  vim.api.nvim_set_hl(0, 'NativeCopilotActorHeader', {
    default = true,
    link = 'Identifier',
  })
  vim.api.nvim_set_hl(0, 'NativeCopilotHeaderMeta', {
    default = true,
    link = 'Comment',
  })
  vim.api.nvim_set_hl(0, 'NativeCopilotUserMessage', {
    default = true,
    link = 'CursorLine',
  })
  local normal = vim.api.nvim_get_hl(0, {
    name = 'Normal',
    link = false,
  })
  local fallback_background = vim.o.background == 'light' and 0xffffff or 0x000000
  local background = normal.bg or fallback_background
  local light_background = color_luminance(background) >= 128
  local purple = light_background and 0x7c3aed or 0xa855f7
  local ratio = light_background and 0.20 or 0.30
  vim.api.nvim_set_hl(0, 'NativeCopilotTaskMessage', {
    bg = blend_color(background, purple, ratio),
  })
end

setup_highlights()
vim.api.nvim_create_autocmd('ColorScheme', {
  group = vim.api.nvim_create_augroup('NativeCopilotHighlights', { clear = true }),
  callback = setup_highlights,
})

local function with_modifiable(buf, operation)
  if not vim.api.nvim_buf_is_valid(buf) then return end
  local was_modifiable = vim.bo[buf].modifiable
  vim.bo[buf].modifiable = true
  operation()
  vim.bo[buf].modifiable = was_modifiable
end

local function visible(buf)
  return #vim.fn.win_findbuf(buf) > 0
end

local function viewport_at_bottom(view, win)
  if not vim.api.nvim_win_is_valid(win) or vim.api.nvim_win_get_buf(win) ~= view.buf then
    return false
  end
  return vim.api.nvim_win_call(win, function()
    return vim.fn.line('w$') >= vim.api.nvim_buf_line_count(view.buf)
  end)
end

local function follow_bottom(view)
  if not options.follow_bottom or view.id ~= 'conversation' then return end
  local last_line = vim.api.nvim_buf_line_count(view.buf)
  for _, win in ipairs(vim.fn.win_findbuf(view.buf)) do
    if vim.api.nvim_win_is_valid(win) and view.follow_windows[win] ~= false then
      view.following_update = true
      pcall(vim.api.nvim_win_set_cursor, win, { last_line, 0 })
      pcall(vim.api.nvim_win_call, win, function()
        vim.cmd('normal! zb')
        local padding = math.max(
          0,
          math.min(options.bottom_padding or 0, vim.api.nvim_win_get_height(win) - 1)
        )
        if padding > 0 then
          vim.cmd(('execute "normal! %d\\<C-E>"'):format(padding))
        end
      end)
      view.follow_windows[win] = true
      view.following_update = false
    end
  end
end

local function finalize_render(view)
  follow_bottom(view)
end

local function configure_folds(view)
  if view.id ~= 'conversation' then return end
  local foldexpr = 'v:lua.require("native_copilot.buffers").foldexpr(v:lnum)'
  for _, win in ipairs(vim.fn.win_findbuf(view.buf)) do
    if vim.api.nvim_win_is_valid(win) then
      local first_setup = vim.wo[win].foldmethod ~= 'expr'
        or vim.wo[win].foldexpr ~= foldexpr
      vim.wo[win].foldmethod = 'expr'
      vim.wo[win].foldexpr = foldexpr
      if first_setup then vim.wo[win].foldlevel = 99 end
      vim.wo[win].foldminlines = 0
      vim.wo[win].foldenable = true
    end
  end
end

local function refresh_folds(view)
  if view.id ~= 'conversation' then return end
  for _, win in ipairs(vim.fn.win_findbuf(view.buf)) do
    if vim.api.nvim_win_is_valid(win) then
      vim.api.nvim_win_call(win, function()
        local cursor = vim.api.nvim_win_get_cursor(win)
        local closed = {}
        local line = 1
        local line_count = vim.api.nvim_buf_line_count(view.buf)
        while line <= line_count do
          local start_line = vim.fn.foldclosed(line)
          if start_line >= 0 then
            table.insert(closed, start_line)
            line = vim.fn.foldclosedend(line) + 1
          else
            line = line + 1
          end
        end
        vim.cmd('silent! normal! zx')
        for _, start_line in ipairs(closed) do
          if vim.fn.foldclosed(start_line) < 0 then
            vim.api.nvim_win_set_cursor(win, { start_line, 0 })
            vim.cmd('silent! normal! zc')
          end
        end
        local cursor_line = math.min(cursor[1], vim.api.nvim_buf_line_count(view.buf))
        local cursor_text = vim.api.nvim_buf_get_lines(
          view.buf,
          cursor_line - 1,
          cursor_line,
          false
        )[1] or ''
        vim.api.nvim_win_set_cursor(win, {
          cursor_line,
          math.min(cursor[2], #cursor_text),
        })
      end)
    end
  end
end

local function create_buffer(name, member_id, view_id)
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(buf, ('native-copilot://%s/%s'):format(member_id, view_id))
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'hide'
  vim.bo[buf].swapfile = false
  vim.bo[buf].undofile = false
  vim.bo[buf].filetype = 'native-copilot'
  vim.bo[buf].modifiable = false
  vim.b[buf].native_copilot = true
  vim.b[buf].native_copilot_member = member_id
  vim.b[buf].native_copilot_view = view_id
  local initial_day
  local initial_lines
  if view_id == 'conversation' then
    local now = options.now()
    initial_day = os.date('%Y-%m-%d', now)
    initial_lines = {
      ('──────── %s ────────'):format(os.date(options.conversation.day_header_format, now)),
      '',
    }
  else
    initial_lines = { '# ' .. name, '' }
  end
  with_modifiable(buf, function()
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, initial_lines)
  end)
  return {
    buf = buf,
    member_id = member_id,
    id = view_id,
    pending = '',
    flush_scheduled = false,
    streaming = false,
    activity_streaming = false,
    active_message = nil,
    response_active = false,
    response_started_at = nil,
    response_line_start = true,
    response_resume_after_actor = false,
    response_has_owned_timeline = false,
    awaiting_response = nil,
    message_heading = nil,
    writing_generation = 0,
    writing_step = 1,
    current_day = initial_day,
    last_block_kind = nil,
    last_activity = nil,
    activity_records = {},
    timeline = {},
    deferred_timeline = {
      order = {},
      items = {},
    },
    timeline_time_overrides = {},
    follow_windows = {},
    following_update = false,
  }
end

local function member(member_id)
  return registry[member_id]
end

function M.ensure_member(member_id, display_name)
  local existing = member(member_id)
  if existing then
    existing.display_name = display_name or existing.display_name
    return existing
  end
  local created = {
    id = member_id,
    display_name = display_name or member_id,
    unread = 0,
    state = 'idle',
    views = {},
  }
  created.views.conversation = create_buffer(created.display_name, member_id, 'conversation')
  created.views.messages = create_buffer(created.display_name .. ' — Messages', member_id, 'messages')
  registry[member_id] = created
  return created
end

function M.get_member(member_id)
  return registry[member_id]
end

function M.members()
  return registry
end

function M.buffer(member_id, view_id)
  local entry = registry[member_id]
  return entry and entry.views[view_id or 'conversation'].buf or nil
end

function M.prepare_history(member_id, event_time)
  local view = M.ensure_member(member_id).views.conversation
  local now = event_time or options.now()
  vim.api.nvim_buf_clear_namespace(view.buf, timeline_namespace, 0, -1)
  vim.api.nvim_buf_clear_namespace(view.buf, activity_namespace, 0, -1)
  vim.api.nvim_buf_clear_namespace(view.buf, activity_body_namespace, 0, -1)
  with_modifiable(view.buf, function()
    vim.api.nvim_buf_set_lines(view.buf, 0, -1, false, {
      ('──────── %s ────────'):format(os.date(options.conversation.day_header_format, now)),
      '',
    })
  end)
  view.pending = ''
  view.flush_scheduled = false
  view.streaming = false
  view.activity_streaming = false
  view.active_message = nil
  view.response_active = false
  view.response_started_at = nil
  view.response_line_start = true
  view.response_resume_after_actor = false
  view.response_has_owned_timeline = false
  view.awaiting_response = nil
  view.message_heading = nil
  view.last_activity = nil
  view.activity_records = {}
  view.timeline = {}
  view.deferred_timeline = {
    order = {},
    items = {},
  }
  view.timeline_time_overrides = {}
  view.current_day = os.date('%Y-%m-%d', now)
  view.last_block_kind = nil
  view.history_prepared = true
  view.history_environment_started = false
end

local function flush(view)
  view.flush_scheduled = false
  if view.pending == '' or not vim.api.nvim_buf_is_valid(view.buf) then return end
  local content = view.pending:gsub('\r\n', '\n'):gsub('\r', '\n')
  view.pending = ''
  local line_count = vim.api.nvim_buf_line_count(view.buf)
  local last = vim.api.nvim_buf_get_lines(view.buf, line_count - 1, line_count, false)[1] or ''
  local replacement = vim.split(last .. content, '\n', { plain = true })
  with_modifiable(view.buf, function()
    vim.api.nvim_buf_set_lines(view.buf, line_count - 1, line_count, false, replacement)
  end)
  if view.active_activity then
    view.active_activity.extmark = vim.api.nvim_buf_set_extmark(
      view.buf,
      activity_namespace,
      view.active_activity.start_row,
      0,
      {
        id = view.active_activity.extmark,
        end_row = vim.api.nvim_buf_line_count(view.buf),
        end_col = 0,
        hl_group = 'Comment',
        hl_eol = true,
        priority = 200,
      }
    )
    view.active_activity.body_extmark = vim.api.nvim_buf_set_extmark(
      view.buf,
      activity_body_namespace,
      view.active_activity.body_start_row,
      0,
      {
        id = view.active_activity.body_extmark,
        end_row = vim.api.nvim_buf_line_count(view.buf),
        end_col = 0,
        right_gravity = false,
        end_right_gravity = false,
      }
    )
    if view.active_activity.plain then
      view.active_activity.fold_extmark = vim.api.nvim_buf_set_extmark(
        view.buf,
        activity_fold_namespace,
        view.active_activity.fold_start_row,
        0,
        {
          id = view.active_activity.fold_extmark,
          end_row = vim.api.nvim_buf_line_count(view.buf),
          end_col = 0,
          right_gravity = false,
          end_right_gravity = false,
        }
      )
    end
  end
  follow_bottom(view)
end

local function schedule_flush(view)
  if view.flush_scheduled then return end
  view.flush_scheduled = true
  vim.defer_fn(function()
    if vim.api.nvim_buf_is_valid(view.buf) then flush(view) end
  end, options.stream_flush_ms)
end

local function ensure_trailing_empty_rows(view, count)
  flush(view)
  local lines = vim.api.nvim_buf_get_lines(view.buf, 0, -1, false)
  local trailing = 0
  for index = #lines, 1, -1 do
    if lines[index]:match('^%s*$') then
      trailing = trailing + 1
    else
      break
    end
  end
  if trailing == count then return end
  with_modifiable(view.buf, function()
    if trailing > count then
      vim.api.nvim_buf_set_lines(
        view.buf,
        #lines - (trailing - count),
        #lines,
        false,
        {}
      )
    else
      local additions = {}
      for _ = 1, count - trailing do table.insert(additions, '') end
      vim.api.nvim_buf_set_lines(view.buf, #lines, #lines, false, additions)
    end
  end)
end

local function prepare_pending_block(view, blank_lines)
  ensure_trailing_empty_rows(view, blank_lines + 1)
end

local function trim_blank_boundary_lines(content)
  local lines = vim.split(
    content:gsub('\r\n', '\n'):gsub('\r', '\n'),
    '\n',
    { plain = true }
  )
  while #lines > 0 and lines[1]:match('^%s*$') do table.remove(lines, 1) end
  while #lines > 0 and lines[#lines]:match('^%s*$') do table.remove(lines) end
  return table.concat(lines, '\n')
end

function M.setup(user_options)
  options = vim.tbl_deep_extend('force', options, user_options or {})
  setup_highlights()
end

local function ensure_day_header(view, now)
  if view.id ~= 'conversation' then return now end
  now = now or options.now()
  local day = os.date('%Y-%m-%d', now)
  if view.current_day == day then return now end

  flush(view)
  local line_count = vim.api.nvim_buf_line_count(view.buf)
  local last = vim.api.nvim_buf_get_lines(view.buf, line_count - 1, line_count, false)[1] or ''
  local prefix = last == '' and '\n' or '\n\n'
  view.pending = view.pending
    .. prefix
    .. ('──────── %s ────────\n'):format(os.date(options.conversation.day_header_format, now))
  flush(view)
  view.current_day = day
  view.last_block_kind = nil
  return now
end

local function append(view, text, final)
  if text == '' then return end
  view.last_block_kind = nil
  view.streaming = not final
  view.pending = view.pending .. text
  schedule_flush(view)
  if final then
    flush(view)
    view.streaming = false
    finalize_render(view)
  end
end

local function highlight_header(buf, row, line, group)
  local separator = line:find(' · ', 1, true)
  if not separator then return end
  vim.api.nvim_buf_clear_namespace(buf, header_highlight_namespace, row, row + 1)
  vim.api.nvim_buf_set_extmark(buf, header_highlight_namespace, row, 0, {
    end_row = row,
    end_col = separator - 1,
    hl_group = group,
    priority = 210,
  })
  vim.api.nvim_buf_set_extmark(buf, header_highlight_namespace, row, separator - 1, {
    end_row = row,
    end_col = #line,
    hl_group = 'NativeCopilotHeaderMeta',
    priority = 210,
  })
end

function M.append_block(member_id, view_id, heading, content, event_time)
  local entry = M.ensure_member(member_id)
  local view = entry.views[view_id]
  local now = ensure_day_header(view, event_time or options.now())
  prepare_pending_block(view, 1)
  local line_count = vim.api.nvim_buf_line_count(view.buf)
  local display_heading
  if view_id == 'conversation' and heading == 'You' then
    display_heading = options.conversation.user_label
    content = trim_blank_boundary_lines(content)
    content = content_indent .. content:gsub('\n', '\n' .. content_indent)
  elseif view_id == 'conversation' and heading == 'Copilot' then
    display_heading = options.conversation.copilot_label
    content = trim_blank_boundary_lines(content)
    content = content_indent .. content:gsub('\n', '\n' .. content_indent)
  elseif view_id == 'conversation' and heading == 'Task' then
    display_heading = options.conversation.task_label
    content = trim_blank_boundary_lines(content)
    content = content_indent .. content:gsub('\n', '\n' .. content_indent)
  else
    local level = view_id == 'conversation' and '#' or '##'
    display_heading = ('%s%s %s'):format(content_indent, level, heading)
    content = content_indent .. content:gsub('\n', '\n' .. content_indent)
  end
  append(view, ('%s · %s\n\n%s\n'):format(display_heading, timestamp(now), content), true)
  if view_id == 'conversation' then view.last_block_kind = 'message' end
  if
    view_id == 'conversation'
    and (heading == 'You' or heading == 'Copilot' or heading == 'Task')
  then
    local lines = vim.api.nvim_buf_get_lines(view.buf, line_count - 1, -1, false)
    for index, line in ipairs(lines) do
      if line:find(display_heading .. ' · ', 1, true) == 1 then
        local heading_row = line_count + index - 2
        highlight_header(
          view.buf,
          heading_row,
          line,
          heading == 'You' and 'NativeCopilotUserHeader'
            or heading == 'Copilot' and 'NativeCopilotAssistantHeader'
            or 'NativeCopilotActorHeader'
        )
        if heading == 'You' then
          vim.api.nvim_buf_set_extmark(view.buf, user_message_namespace, heading_row, 0, {
            end_row = vim.api.nvim_buf_line_count(view.buf) - 1,
            end_col = 0,
            hl_group = 'NativeCopilotUserMessage',
            hl_eol = true,
            right_gravity = false,
            end_right_gravity = false,
            priority = 100,
          })
        elseif heading == 'Task' then
          vim.api.nvim_buf_set_extmark(view.buf, task_message_namespace, heading_row, 0, {
            end_row = vim.api.nvim_buf_line_count(view.buf) - 1,
            end_col = 0,
            hl_group = 'NativeCopilotTaskMessage',
            hl_eol = true,
            right_gravity = false,
            end_right_gravity = false,
            priority = 100,
          })
        end
        break
      end
    end
  end
end

local function begin_inline_activity(view, activity_id, heading, event_time)
  ensure_day_header(view, event_time or options.now())
  flush(view)
  local plain = heading == 'Reasoning summary'
  local continuation = view.last_block_kind == 'activity'
    and view.last_activity ~= nil
    and view.last_activity.plain == plain
  if not continuation then prepare_pending_block(view, 1) end
  local line_count = vim.api.nvim_buf_line_count(view.buf)
  local start_row
  local body_start_row
  if plain then
    body_start_row = line_count - 1
    start_row = continuation and view.last_activity.start_row or body_start_row
  elseif continuation then
    start_row = view.last_activity.start_row
    body_start_row = line_count - 1
  else
    start_row = line_count - 1
    body_start_row = start_row + 2
  end
  local activity = {
    id = activity_id,
    start_row = start_row,
    body_start_row = body_start_row,
    fold_start_row = continuation and view.last_activity.fold_start_row or body_start_row,
    content = '',
    extmark = continuation and view.last_activity.extmark or nil,
    fold_extmark = continuation and view.last_activity.fold_extmark or nil,
    plain = plain,
  }
  view.active_activity = activity
  view.activity_records[activity_id] = activity
  if plain then
    view.pending = view.pending .. (continuation and ('\n' .. content_indent) or content_indent)
  elseif continuation then
    view.pending = view.pending .. quote_indent .. '\n' .. quote_indent .. ' '
  else
    view.pending = view.pending
      .. ('%s **%s**\n%s\n%s '):format(
        quote_indent,
        heading,
        quote_indent,
        quote_indent
      )
  end
  flush(view)
  view.last_activity = {
    start_row = view.active_activity.start_row,
    fold_start_row = view.active_activity.fold_start_row,
    extmark = view.active_activity.extmark,
    fold_extmark = view.active_activity.fold_extmark,
    plain = plain,
  }
  view.last_block_kind = 'activity'
end

local function touch_activity_heading(view, activity, heading)
  if not activity or activity.plain then return end
  with_modifiable(view.buf, function()
    vim.api.nvim_buf_set_lines(
      view.buf,
      activity.start_row,
      activity.start_row + 1,
      false,
      { ('%s **%s**'):format(quote_indent, heading) }
    )
  end)
end

function M.append_activity_delta(member_id, activity_id, content)
  local entry = M.ensure_member(member_id)
  local view = entry.views.conversation
  if not view.active_activity or view.active_activity.id ~= activity_id then
    begin_inline_activity(view, activity_id, 'Reasoning summary')
  end
  view.activity_streaming = true
  if view.active_activity.content == '' then content = content:gsub('^%s+', '') end
  view.active_activity.content = view.active_activity.content .. content
  local line_prefix = view.active_activity.plain
      and ('\n' .. content_indent)
    or ('\n' .. quote_indent .. ' ')
  view.pending = view.pending .. content:gsub('\n', line_prefix)
  schedule_flush(view)
end

local function replace_activity_content(view, activity, content)
  if not activity.body_extmark then return false end
  local position = vim.api.nvim_buf_get_extmark_by_id(
    view.buf,
    activity_body_namespace,
    activity.body_extmark,
    { details = true }
  )
  if #position == 0 then return false end
  local fold_start_row = activity.fold_start_row
  if activity.fold_extmark then
    local fold_position = vim.api.nvim_buf_get_extmark_by_id(
      view.buf,
      activity_fold_namespace,
      activity.fold_extmark,
      {}
    )
    if #fold_position > 0 then fold_start_row = fold_position[1] end
  end
  local lines = {}
  local line_prefix = activity.plain and content_indent or (quote_indent .. ' ')
  for _, line in ipairs(vim.split(content:gsub('\r\n', '\n'):gsub('\r', '\n'), '\n', { plain = true })) do
    table.insert(lines, line_prefix .. line)
  end
  table.insert(lines, '')
  with_modifiable(view.buf, function()
    vim.api.nvim_buf_set_lines(
      view.buf,
      position[1],
      position[3].end_row,
      false,
      lines
    )
  end)
  activity.body_extmark = vim.api.nvim_buf_set_extmark(
    view.buf,
    activity_body_namespace,
    position[1],
    0,
    {
      id = activity.body_extmark,
      end_row = position[1] + #lines,
      end_col = 0,
      right_gravity = false,
      end_right_gravity = false,
    }
  )
  if activity.plain then
    activity.fold_extmark = vim.api.nvim_buf_set_extmark(
      view.buf,
      activity_fold_namespace,
      fold_start_row,
      0,
      {
        id = activity.fold_extmark,
        end_row = position[1] + #lines,
        end_col = 0,
        right_gravity = false,
        end_right_gravity = false,
      }
    )
    activity.fold_start_row = fold_start_row
  end
  return true
end

function M.complete_activity(member_id, activity_id, content, event_time)
  local entry = M.ensure_member(member_id)
  local view = entry.views.conversation
  local activity = view.active_activity and view.active_activity.id == activity_id
      and view.active_activity
    or view.activity_records[activity_id]
  if activity then
    if activity.plain then
      content = trim_blank_boundary_lines(content)
    end
    local was_active = view.active_activity == activity
    if was_active then
      view.pending = view.pending .. '\n'
      flush(view)
    end
    if content ~= '' and content ~= activity.content then
      replace_activity_content(view, activity, content)
    end
    activity.content = content ~= '' and content or activity.content
    activity.completed = true
    if was_active then
      touch_activity_heading(view, activity, 'Reasoning summary')
      view.active_activity = nil
      view.activity_streaming = false
      if not view.streaming then finalize_render(view) end
    end
    refresh_folds(view)
  else
    M.append_activity_block(member_id, 'Reasoning summary', content, event_time)
    view.activity_records[activity_id] = {
      id = activity_id,
      content = content,
      completed = true,
    }
  end
end

function M.append_activity_block(member_id, heading, content, event_time)
  local entry = M.ensure_member(member_id)
  local view = entry.views.conversation
  begin_inline_activity(
    view,
    ('%s-%d'):format(heading, vim.uv.hrtime()),
    heading,
    event_time
  )
  local line_prefix = view.active_activity.plain
      and ('\n' .. content_indent)
    or ('\n' .. quote_indent .. ' ')
  view.pending = view.pending .. content:gsub('\n', line_prefix) .. '\n'
  flush(view)
  touch_activity_heading(view, view.active_activity, heading)
  view.active_activity = nil
  view.activity_streaming = false
  refresh_folds(view)
  if not view.streaming then finalize_render(view) end
end

local function timeline_lines(item, now)
  local kind = item.kind
  local label = item.label
  local status = item.status
  local detail = item.detail
  kind = tostring(kind or 'activity'):gsub('[\r\n]+', ' ')
  label = tostring(label or ''):gsub('[\r\n]+', ' ')
  detail = detail and tostring(detail):gsub('[\r\n]+', ' ') or nil
  local suffix = detail and detail ~= '' and (' — ' .. detail) or ''
  local compact_lifecycle = not item.actor_message and (kind == 'task' or kind == 'tool')
  local prefix = (kind == 'environment' or kind == 'instruction') and ''
    or compact_lifecycle and content_indent
    or (quote_indent .. ' ')
  local identity = item.identifier ~= nil
      and ('[%s][%s]'):format(kind, tostring(item.identifier):gsub('[\r\n]+', ' '))
    or ('[%s]'):format(kind)
  local event = item.event and (tostring(item.event) .. ' · ') or ''
  if item.actor_message then
    local actor_heading
    if item.actor or item.actor_label then
      local actor = item.actor or (kind == 'tool' and '🛠️' or actor_symbols[kind]) or '💬'
      actor_heading = item.actor_label and (actor .. ' ' .. item.actor_label) or actor
    else
      local option_name = actor_option_names[kind]
      actor_heading = option_name and options.conversation[option_name] or kind
    end
    return {
      ('%s · %s'):format(actor_heading, timestamp(now)),
      '',
      ('%s%s %s %s%s%s'):format(
        content_indent,
        status_symbols[status] or status_symbols.unknown,
        identity,
        event,
        label,
        suffix
      ),
    }
  end
  local actor = item.actor or (kind ~= 'task' and actor_symbols[kind] or nil)
  local actor_prefix = actor and (actor .. ' ') or ''
  return {
    ('%s%s%s %s %s%s%s · %s'):format(
      prefix,
      actor_prefix,
      status_symbols[status] or status_symbols.unknown,
      identity,
      event,
      label,
      suffix,
      timestamp(now)
    ),
  }
end

local function line_has_timeline_label(line, kind, label)
  local marker = ('[%s] %s'):format(kind, label)
  local start = line:find(marker, 1, true)
  if not start then return false end
  local suffix = line:sub(start + #marker)
  return suffix == '' or suffix:find(' —', 1, true) == 1 or suffix:find(' ·', 1, true) == 1
end

local function environment_insert_row(view)
  local lines = vim.api.nvim_buf_get_lines(view.buf, 0, -1, false)
  local last_environment
  for index, line in ipairs(lines) do
    if line:find('[environment] ', 1, true) then
      last_environment = index - 1
    end
  end
  if last_environment then return last_environment + 1 end
  for index, line in ipairs(lines) do
    if line:find(options.conversation.user_label .. ' · ', 1, true) == 1
      or line:find(options.conversation.copilot_label .. ' · ', 1, true) == 1
    then
      return math.max(1, index - 2)
    end
  end
  return nil
end

local function shift_tracked_rows(view, start_row, count)
  local function shift(record, field)
    if record and record[field] and record[field] >= start_row then
      record[field] = record[field] + count
    end
  end
  for _, activity in pairs(view.activity_records) do
    shift(activity, 'start_row')
    shift(activity, 'body_start_row')
    shift(activity, 'fold_start_row')
  end
  shift(view.last_activity, 'start_row')
  shift(view.last_activity, 'body_start_row')
  shift(view.last_activity, 'fold_start_row')
  for _, timeline in pairs(view.timeline) do
    shift(timeline, 'start_row')
  end
end

function M.status_symbol(status)
  return status_symbols[status] or status_symbols.unknown
end

function M.foldexpr(lnum)
  local buf = vim.api.nvim_get_current_buf()
  local row = lnum - 1
  local folds = vim.api.nvim_buf_get_extmarks(
    buf,
    activity_fold_namespace,
    0,
    -1,
    { details = true }
  )
  for _, fold in ipairs(folds) do
    local start_row = fold[2]
    local end_row = fold[4].end_row or start_row
    if row == start_row then return '>1' end
    if row > start_row and row < end_row then return '1' end
  end
  return '0'
end

local function reconcile_environment_rows(view, item)
  if item.kind ~= 'environment' then return nil end
  local rows = {}
  for index, line in ipairs(vim.api.nvim_buf_get_lines(view.buf, 0, -1, false)) do
    if line_has_timeline_label(line, 'environment', item.label) then
      table.insert(rows, index - 1)
    end
  end
  if #rows == 0 then return nil end

  for index = #rows, 2, -1 do
    local row = rows[index]
    with_modifiable(view.buf, function()
      vim.api.nvim_buf_set_lines(view.buf, row, row + 1, false, {})
    end)
  end
  return rows[1]
end

function M.upsert_timeline(member_id, item_id, item)
  local entry = M.ensure_member(member_id)
  local view = entry.views.conversation
  if
    view.active_activity
    and not item.actor_message
    and (item.kind == 'task' or item.kind == 'tool')
  then
    view.pending = view.pending .. '\n'
    flush(view)
    view.active_activity = nil
    view.activity_streaming = false
  end
  flush(view)
  if item.actor_message
    and (item.kind == 'task' or item.kind == 'tool')
    and (view.streaming or view.active_message or view.awaiting_response)
  then
    local deferred = view.deferred_timeline
    local queued = deferred.items[item_id]
    if not queued then
      table.insert(deferred.order, item_id)
      queued = { created_at = item.created_at or options.now() }
      deferred.items[item_id] = queued
    end
    queued.item = vim.deepcopy(item)
    return
  end
  local record = view.timeline[item_id]
  local start_row = reconcile_environment_rows(view, item)
  if record
    and record.item
    and record.item.kind == item.kind
    and record.item.label == item.label
    and record.item.status == item.status
    and record.item.detail == item.detail
  then
    local position = vim.api.nvim_buf_get_extmark_by_id(
      view.buf,
      timeline_namespace,
      record.extmark,
      {}
    )
    if #position > 0 then
      record.item = vim.deepcopy(item)
      record.item.id = item_id
      return
    end
  end
  local overridden_time = view.timeline_time_overrides[item_id]
  view.timeline_time_overrides[item_id] = nil
  local now = record and record.created_at or overridden_time or item.created_at or options.now()
  local lines = timeline_lines(item, now)
  if start_row then
    with_modifiable(view.buf, function()
      vim.api.nvim_buf_set_lines(view.buf, start_row, start_row + 1, false, lines)
    end)
  elseif record then
    local position = vim.api.nvim_buf_get_extmark_by_id(
      view.buf,
      timeline_namespace,
      record.extmark,
      { details = true }
    )
    if #position > 0 then
      start_row = position[1]
      local end_row = start_row + record.line_count
      with_modifiable(view.buf, function()
        vim.api.nvim_buf_set_lines(view.buf, start_row, end_row, false, lines)
      end)
    end
  end

  if not start_row then
    ensure_day_header(view, now)
    local first_history_environment = item.kind == 'environment'
      and view.history_prepared
      and not view.history_environment_started
    start_row = item.kind == 'environment'
        and not first_history_environment
        and environment_insert_row(view)
      or nil
    if start_row then
      shift_tracked_rows(view, start_row, #lines)
      with_modifiable(view.buf, function()
        vim.api.nvim_buf_set_lines(view.buf, start_row, start_row, false, lines)
      end)
    else
      if
        item.actor_message
        or view.last_block_kind == 'actor_message'
        or view.last_block_kind == 'activity'
        or view.last_block_kind == 'message'
        or view.last_block_kind == 'header'
      then
        ensure_trailing_empty_rows(view, 1)
      end
      start_row = vim.api.nvim_buf_line_count(view.buf)
      with_modifiable(view.buf, function()
        vim.api.nvim_buf_set_lines(view.buf, start_row, start_row, false, lines)
      end)
      view.last_block_kind = item.actor_message and 'actor_message' or 'timeline'
      if item.actor_message and view.response_active then
        view.response_resume_after_actor =
          view.response_resume_after_actor or not view.response_line_start
        view.response_line_start = true
      end
    end
    record = {}
    view.timeline[item_id] = record
  end
  if item.kind == 'environment' then view.history_environment_started = true end

  local timeline_highlight
  if item.actor_message and item.kind == 'task' then
    timeline_highlight = 'NativeCopilotTaskMessage'
  elseif not item.actor_message and (item.kind == 'task' or item.kind == 'tool') then
    timeline_highlight = 'NativeCopilotActorHeader'
  end
  record.extmark = vim.api.nvim_buf_set_extmark(view.buf, timeline_namespace, start_row, 0, {
    id = record.extmark,
    end_row = start_row + #lines,
    end_col = 0,
    hl_group = timeline_highlight,
    hl_eol = timeline_highlight ~= nil,
    right_gravity = true,
    end_right_gravity = false,
  })
  record.line_count = #lines
  record.start_row = start_row
  record.created_at = record.created_at or now
  record.item = vim.deepcopy(item)
  record.item.id = item_id
  if item.copilot_owned and view.response_active then
    view.response_has_owned_timeline = true
  end
  if item.actor_message then
    highlight_header(view.buf, start_row, lines[1], 'NativeCopilotActorHeader')
  end
  follow_bottom(view)
  if not view.streaming and not view.activity_streaming then finalize_render(view) end
end

local function flush_deferred_timeline(member_id, view)
  local deferred = view.deferred_timeline
  if #deferred.order == 0 then return end
  view.deferred_timeline = {
    order = {},
    items = {},
  }
  for _, item_id in ipairs(deferred.order) do
    local queued = deferred.items[item_id]
    if queued then
      view.timeline_time_overrides[item_id] = queued.created_at
      M.upsert_timeline(member_id, item_id, queued.item)
    end
  end
end

function M.remove_timeline(member_id, item_id)
  local entry = registry[member_id]
  local view = entry and entry.views.conversation
  if not view then return end
  view.deferred_timeline.items[item_id] = nil
  view.timeline_time_overrides[item_id] = nil
  local record = view and view.timeline[item_id]
  if not record then return end
  local position = vim.api.nvim_buf_get_extmark_by_id(
    view.buf,
    timeline_namespace,
    record.extmark,
    { details = true }
  )
  if record.item and record.item.kind == 'environment' then
    local rows = {}
    for index, line in ipairs(vim.api.nvim_buf_get_lines(view.buf, 0, -1, false)) do
      if line_has_timeline_label(line, 'environment', record.item.label) then
        table.insert(rows, index - 1)
      end
    end
    for index = #rows, 1, -1 do
      with_modifiable(view.buf, function()
        vim.api.nvim_buf_set_lines(view.buf, rows[index], rows[index] + 1, false, {})
      end)
    end
  elseif #position > 0 then
    local end_row = position[1] + record.line_count
    with_modifiable(view.buf, function()
      vim.api.nvim_buf_set_lines(view.buf, position[1], end_row, false, {})
    end)
  end
  view.timeline[item_id] = nil
  finalize_render(view)
end

function M.timeline_item_at_cursor(buf, row)
  for member_id, entry in pairs(registry) do
    local view = entry.views.conversation
    if view.buf == buf then
      local zero_row = row - 1
      for _, record in pairs(view.timeline) do
        local position = vim.api.nvim_buf_get_extmark_by_id(
          view.buf,
          timeline_namespace,
          record.extmark,
          { details = true }
        )
        if #position > 0 then
          local end_row = position[3].end_row or (position[1] + record.line_count)
          if zero_row >= position[1] and zero_row < end_row then
            return record.item, member_id
          end
        end
      end
      local line = vim.api.nvim_buf_get_lines(view.buf, zero_row, zero_row + 1, false)[1] or ''
      local nearest
      local nearest_distance
      for _, record in pairs(view.timeline) do
        local item = record.item
        local marker = item and tostring(item.label or '') or nil
        if marker
          and marker ~= ''
          and line:find(marker, 1, true)
          and line:find('[' .. tostring(item.kind or 'activity'), 1, true)
        then
          local distance = math.abs((record.start_row or zero_row) - zero_row)
          if not nearest_distance or distance < nearest_distance then
            nearest = item
            nearest_distance = distance
          end
        end
      end
      if nearest then return nearest, member_id end
      return nil, member_id
    end
  end
end

local function set_message_heading(view, content)
  if not view.message_heading then return end
  local position = vim.api.nvim_buf_get_extmark_by_id(
    view.buf,
    message_heading_namespace,
    view.message_heading,
    {}
  )
  if #position == 0 then return end
  with_modifiable(view.buf, function()
    vim.api.nvim_buf_set_lines(
      view.buf,
      position[1],
      position[1] + 1,
      false,
      { content }
    )
  end)
  highlight_header(
    view.buf,
    position[1],
    content,
    'NativeCopilotAssistantHeader'
  )
end

local function stop_writing_animation(view)
  view.writing_generation = view.writing_generation + 1
end

local function animate_writing(view, generation)
  vim.defer_fn(function()
    if generation ~= view.writing_generation then return end
    if not view.awaiting_response and not view.active_message then return end
    if not vim.api.nvim_buf_is_valid(view.buf) then return end
    view.writing_step = (view.writing_step % 3) + 1
    set_message_heading(
      view,
      ('%s · writing%s'):format(
        options.conversation.copilot_label,
        string.rep('.', view.writing_step)
      )
    )
    animate_writing(view, generation)
  end, 400)
end

local function touch_message_heading(view, status, detail, event_time)
  stop_writing_animation(view)
  local label = options.conversation.copilot_label
  if status == 'failed' then
    label = M.status_symbol('failed') .. ' ' .. label
  end
  set_message_heading(
    view,
    ('%s · %s%s'):format(
      label,
      timestamp(event_time),
      detail and (' · ' .. detail) or ''
    )
  )
end

local function remove_message_heading(view)
  stop_writing_animation(view)
  if not view.message_heading then return end
  local position = vim.api.nvim_buf_get_extmark_by_id(
    view.buf,
    message_heading_namespace,
    view.message_heading,
    {}
  )
  if #position > 0 then
    local line_count = vim.api.nvim_buf_line_count(view.buf)
    with_modifiable(view.buf, function()
      vim.api.nvim_buf_set_lines(
        view.buf,
        position[1],
        math.min(position[1] + 2, line_count),
        false,
        {}
      )
    end)
  end
  view.message_heading = nil
end

local function begin_response(view, response_id, event_time)
  ensure_day_header(view, event_time or options.now())
  prepare_pending_block(view, 1)
  vim.api.nvim_buf_clear_namespace(view.buf, message_heading_namespace, 0, -1)
  local heading_row = vim.api.nvim_buf_line_count(view.buf) - 1
  stop_writing_animation(view)
  view.writing_step = 1
  view.response_line_start = true
  view.response_resume_after_actor = false
  view.response_started_at = event_time
  append(
    view,
    ('%s · writing.\n\n'):format(
      options.conversation.copilot_label
    ),
    false
  )
  flush(view)
  view.message_heading = vim.api.nvim_buf_set_extmark(
    view.buf,
    message_heading_namespace,
    heading_row,
    0,
    { right_gravity = false }
  )
  highlight_header(
    view.buf,
    heading_row,
    ('%s · writing.'):format(options.conversation.copilot_label),
    'NativeCopilotAssistantHeader'
  )
  view.awaiting_response = response_id or true
  view.response_active = true
  view.response_message_completed = false
  view.last_block_kind = 'header'
  animate_writing(view, view.writing_generation)
end

local function indent_response_delta(view, content)
  content = content:gsub('\r\n', '\n'):gsub('\r', '\n')
  local result = {}
  local offset = 1
  while offset <= #content do
    local newline = content:find('\n', offset, true)
    local line_end = newline and newline - 1 or #content
    local segment = content:sub(offset, line_end)
    if segment ~= '' then
      if view.response_line_start then table.insert(result, content_indent) end
      table.insert(result, segment)
      view.response_line_start = false
    end
    if not newline then break end
    table.insert(result, '\n')
    view.response_line_start = true
    offset = newline + 1
  end
  return table.concat(result)
end

function M.begin_response(member_id, response_id, event_time)
  local view = M.ensure_member(member_id).views.conversation
  if view.response_active or view.awaiting_response or view.active_message then return end
  begin_response(view, response_id, event_time)
end

function M.append_conversation_delta(member_id, message_id, content)
  local entry = M.ensure_member(member_id)
  local view = entry.views.conversation
  if view.active_activity then
    view.pending = view.pending .. '\n'
    flush(view)
    view.active_activity = nil
    view.activity_streaming = false
  end
  local first_visible_delta = false
  if view.active_message ~= message_id then
    flush(view)
    view.active_message = message_id
    if view.awaiting_response then
      view.awaiting_response = nil
      first_visible_delta = true
    elseif view.message_heading then
      first_visible_delta = true
    else
      begin_response(view, message_id)
      view.awaiting_response = nil
      first_visible_delta = true
    end
  end
  if first_visible_delta
    or view.last_block_kind == 'activity'
    or view.last_block_kind == 'timeline'
    or view.last_block_kind == 'actor_message'
  then
    prepare_pending_block(view, 1)
  end
  if view.response_resume_after_actor then
    content = content:gsub('^[ \t]+', '')
    if content ~= '' then view.response_resume_after_actor = false end
  end
  append(view, indent_response_delta(view, content), false)
  view.last_block_kind = 'message'
end

function M.fail_response(member_id, detail)
  local view = M.ensure_member(member_id).views.conversation
  if not view.awaiting_response and not view.active_message then return end
  flush(view)
  touch_message_heading(view, 'failed', detail or 'failed')
  view.awaiting_response = nil
  view.active_message = nil
  view.response_active = false
  view.response_started_at = nil
  view.response_line_start = true
  view.response_resume_after_actor = false
  view.response_has_owned_timeline = false
  view.streaming = false
  flush_deferred_timeline(member_id, view)
  finalize_render(view)
end

function M.complete_conversation(member_id, message_id, content, event_time)
  local entry = M.ensure_member(member_id)
  local view = entry.views.conversation
  if view.awaiting_response and content == '' then
    return
  elseif view.awaiting_response then
    if
      view.last_block_kind == 'activity'
      or view.last_block_kind == 'timeline'
      or view.last_block_kind == 'actor_message'
    then
      prepare_pending_block(view, 1)
    end
    append(view, indent_response_delta(view, content) .. '\n', true)
    view.awaiting_response = nil
    touch_message_heading(view, 'completed', nil, event_time)
  elseif view.active_message == message_id then
    append(view, '\n', true)
    touch_message_heading(view, 'completed', nil, event_time)
  elseif view.response_active and view.message_heading then
    prepare_pending_block(view, 1)
    append(view, indent_response_delta(view, content) .. '\n', true)
    touch_message_heading(view, 'completed', nil, event_time)
  else
    M.append_block(member_id, 'conversation', 'Copilot', content, event_time)
  end
  view.active_message = nil
  view.response_message_completed = true
  view.response_line_start = true
  view.response_resume_after_actor = false
  view.response_has_owned_timeline = false
  view.last_block_kind = 'message'
  flush_deferred_timeline(member_id, view)
end

function M.finish_response(member_id, event_time)
  local entry = registry[member_id]
  local view = entry and entry.views.conversation
  if not view
    or (not view.response_active and not view.awaiting_response and not view.active_message)
  then
    return
  end
  flush(view)
  if view.awaiting_response
    and not view.active_message
    and not view.response_has_owned_timeline
  then
    remove_message_heading(view)
  elseif not view.response_message_completed then
    touch_message_heading(view, 'completed', nil, view.response_started_at or event_time)
  end
  view.awaiting_response = nil
  view.active_message = nil
  view.response_active = false
  view.response_message_completed = false
  view.response_started_at = nil
  view.response_line_start = true
  view.response_resume_after_actor = false
  view.response_has_owned_timeline = false
  view.streaming = false
  flush_deferred_timeline(member_id, view)
  finalize_render(view)
end

function M.set_state(member_id, new_state)
  local entry = M.ensure_member(member_id)
  entry.state = new_state
end

function M.increment_unread(member_id)
  local entry = M.ensure_member(member_id)
  if not visible(entry.views.conversation.buf) then
    entry.unread = entry.unread + 1
  end
end

function M.mark_read(member_id)
  local entry = registry[member_id]
  if entry then entry.unread = 0 end
end

function M.on_shown(buf)
  for _, entry in pairs(registry) do
    for _, view in pairs(entry.views) do
      if view.buf == buf then
        if view.id == 'conversation' then
          entry.unread = 0
          for _, win in ipairs(vim.fn.win_findbuf(buf)) do
            if vim.api.nvim_win_is_valid(win) then
              vim.wo[win].cursorline = false
              view.follow_windows[win] = true
            end
          end
        end
        configure_folds(view)
        follow_bottom(view)
        return
      end
    end
  end
end

function M.on_view_moved(win)
  if not win or not vim.api.nvim_win_is_valid(win) then return end
  local buf = vim.api.nvim_win_get_buf(win)
  for _, entry in pairs(registry) do
    local view = entry.views.conversation
    if view.buf == buf then
      if not view.following_update then
        view.follow_windows[win] = viewport_at_bottom(view, win)
      end
      return
    end
  end
end

function M.reset()
  for _, entry in pairs(registry) do
    for _, view in pairs(entry.views) do
      if vim.api.nvim_buf_is_valid(view.buf) then
        pcall(vim.api.nvim_buf_delete, view.buf, { force = true })
      end
    end
  end
  registry = {}
end

-- Removes a single member's buffers without disturbing other members, so one
-- Fleet stopping or an agent being removed never clears the Standard session or
-- another concurrently active Fleet.
function M.remove_member(member_id)
  local entry = registry[member_id]
  if not entry then return end
  for _, view in pairs(entry.views) do
    if vim.api.nvim_buf_is_valid(view.buf) then
      pcall(vim.api.nvim_buf_delete, view.buf, { force = true })
    end
  end
  registry[member_id] = nil
end
return M
