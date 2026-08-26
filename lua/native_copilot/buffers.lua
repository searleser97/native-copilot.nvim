local M = {}

local registry = {}
local activity_namespace = vim.api.nvim_create_namespace('native_copilot_inline_activity')
local message_heading_namespace = vim.api.nvim_create_namespace('native_copilot_message_heading')
local timeline_namespace = vim.api.nvim_create_namespace('native_copilot_timeline')
local options = {
  stream_flush_ms = 80,
  follow_bottom = true,
  timestamp_format = '%H:%M:%S',
  now = os.time,
  conversation = {
    user_label = '👨 You',
    copilot_label = '🤖 Copilot',
    day_header_format = '%A, %B %d',
  },
}

local function timestamp(now)
  return os.date(options.timestamp_format, now or options.now())
end

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

local function follow_bottom(view)
  if not options.follow_bottom or view.id ~= 'conversation' then return end
  local last_line = vim.api.nvim_buf_line_count(view.buf)
  for _, win in ipairs(vim.fn.win_findbuf(view.buf)) do
    if vim.api.nvim_win_is_valid(win) then
      pcall(vim.api.nvim_win_set_cursor, win, { last_line, 0 })
      pcall(vim.api.nvim_win_call, win, function()
        vim.cmd('normal! zb')
      end)
    end
  end
end

local function finalize_render(view)
  follow_bottom(view)
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
    awaiting_response = nil,
    message_heading = nil,
    current_day = initial_day,
    last_block_kind = nil,
    last_activity = nil,
    timeline = {},
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

function M.setup(user_options)
  options = vim.tbl_deep_extend('force', options, user_options or {})
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

function M.append_block(member_id, view_id, heading, content)
  local entry = M.ensure_member(member_id)
  local view = entry.views[view_id]
  local now = ensure_day_header(view, options.now())
  flush(view)
  local line_count = vim.api.nvim_buf_line_count(view.buf)
  local last = vim.api.nvim_buf_get_lines(view.buf, line_count - 1, line_count, false)[1] or ''
  local prefix = last == '' and '\n' or '\n\n'
  local display_heading
  if view_id == 'conversation' and heading == 'You' then
    display_heading = options.conversation.user_label
  elseif view_id == 'conversation' and heading == 'Copilot' then
    display_heading = options.conversation.copilot_label
  else
    local level = view_id == 'conversation' and '#' or '##'
    display_heading = ('%s %s'):format(level, heading)
  end
  append(view, ('%s%s · %s\n\n%s\n'):format(prefix, display_heading, timestamp(now), content), true)
end

local function begin_inline_activity(view, activity_id, heading)
  local now = ensure_day_header(view, options.now())
  flush(view)
  local continuation = view.last_block_kind == 'activity' and view.last_activity ~= nil
  local line_count = vim.api.nvim_buf_line_count(view.buf)
  local start_row = continuation and view.last_activity.start_row or line_count
  view.active_activity = {
    id = activity_id,
    start_row = start_row,
    body_start_row = continuation and line_count or start_row + 2,
    content = '',
    extmark = continuation and view.last_activity.extmark or nil,
  }
  if continuation then
    view.pending = view.pending .. '>\n> '
  else
    view.pending = view.pending .. ('\n> **%s** · %s\n>\n> '):format(heading, timestamp(now))
  end
  flush(view)
  view.last_activity = {
    start_row = view.active_activity.start_row,
    extmark = view.active_activity.extmark,
  }
  view.last_block_kind = 'activity'
end

local function touch_activity_heading(view, heading)
  if not view.active_activity then return end
  with_modifiable(view.buf, function()
    vim.api.nvim_buf_set_lines(
      view.buf,
      view.active_activity.start_row,
      view.active_activity.start_row + 1,
      false,
      { ('> **%s** · %s'):format(heading, timestamp()) }
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
  view.active_activity.content = view.active_activity.content .. content
  view.pending = view.pending .. content:gsub('\n', '\n> ')
  schedule_flush(view)
end

local function replace_activity_content(view, content)
  local lines = {}
  for _, line in ipairs(vim.split(content:gsub('\r\n', '\n'):gsub('\r', '\n'), '\n', { plain = true })) do
    table.insert(lines, '> ' .. line)
  end
  table.insert(lines, '')
  with_modifiable(view.buf, function()
    vim.api.nvim_buf_set_lines(
      view.buf,
      view.active_activity.body_start_row,
      vim.api.nvim_buf_line_count(view.buf),
      false,
      lines
    )
  end)
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
end

function M.complete_activity(member_id, activity_id, content)
  local entry = M.ensure_member(member_id)
  local view = entry.views.conversation
  if view.active_activity and view.active_activity.id == activity_id then
    view.pending = view.pending .. '\n'
    flush(view)
    if content ~= '' and content ~= view.active_activity.content then
      replace_activity_content(view, content)
    end
    touch_activity_heading(view, 'Reasoning summary')
    view.active_activity = nil
    view.activity_streaming = false
    if not view.streaming then finalize_render(view) end
  else
    M.append_activity_block(member_id, 'Reasoning summary', content)
  end
end

function M.append_activity_block(member_id, heading, content)
  local entry = M.ensure_member(member_id)
  local view = entry.views.conversation
  begin_inline_activity(view, ('%s-%d'):format(heading, vim.uv.hrtime()), heading)
  view.pending = view.pending .. content:gsub('\n', '\n> ') .. '\n'
  flush(view)
  touch_activity_heading(view, heading)
  view.active_activity = nil
  view.activity_streaming = false
  if not view.streaming then finalize_render(view) end
end

local function timeline_lines(kind, label, status, detail, now)
  local symbols = {
    running = '○',
    idle = '○',
    completed = '✓',
    failed = '✗',
    cancelled = '–',
  }
  kind = tostring(kind or 'activity'):gsub('[\r\n]+', ' ')
  label = tostring(label or ''):gsub('[\r\n]+', ' ')
  detail = detail and tostring(detail):gsub('[\r\n]+', ' ') or nil
  local suffix = detail and detail ~= '' and (' — ' .. detail) or ''
  return {
    ('> %s **[%s] %s**%s · %s'):format(
      symbols[status] or '?',
      kind,
      label,
      suffix,
      timestamp(now)
    ),
  }
end

local function reconcile_environment_rows(view, item)
  if item.kind ~= 'environment' then return nil end
  local marker = ('**[environment] %s**'):format(item.label)
  local rows = {}
  for index, line in ipairs(vim.api.nvim_buf_get_lines(view.buf, 0, -1, false)) do
    if line:find(marker, 1, true) then table.insert(rows, index - 1) end
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
  flush(view)
  local now = options.now()
  local record = view.timeline[item_id]
  local lines = timeline_lines(item.kind, item.label, item.status, item.detail, now)
  local start_row = reconcile_environment_rows(view, item)
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
    start_row = vim.api.nvim_buf_line_count(view.buf)
    with_modifiable(view.buf, function()
      vim.api.nvim_buf_set_lines(view.buf, start_row, start_row, false, lines)
    end)
    view.last_block_kind = nil
    record = {}
    view.timeline[item_id] = record
  end

  record.extmark = vim.api.nvim_buf_set_extmark(view.buf, timeline_namespace, start_row, 0, {
    id = record.extmark,
    end_row = start_row + #lines,
    end_col = 0,
    right_gravity = true,
    end_right_gravity = false,
  })
  record.line_count = #lines
  record.item = vim.deepcopy(item)
  record.item.id = item_id
  follow_bottom(view)
  if not view.streaming and not view.activity_streaming then finalize_render(view) end
end

function M.remove_timeline(member_id, item_id)
  local entry = registry[member_id]
  local view = entry and entry.views.conversation
  local record = view and view.timeline[item_id]
  if not record then return end
  local position = vim.api.nvim_buf_get_extmark_by_id(
    view.buf,
    timeline_namespace,
    record.extmark,
    { details = true }
  )
  if record.item and record.item.kind == 'environment' then
    local marker = ('**[environment] %s**'):format(record.item.label)
    local rows = {}
    for index, line in ipairs(vim.api.nvim_buf_get_lines(view.buf, 0, -1, false)) do
      if line:find(marker, 1, true) then table.insert(rows, index - 1) end
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
      return nil, member_id
    end
  end
end

local function touch_message_heading(view, status)
  if not view.message_heading then return end
  local position = vim.api.nvim_buf_get_extmark_by_id(
    view.buf,
    message_heading_namespace,
    view.message_heading,
    {}
  )
  if #position == 0 then return end
  local completed_at = timestamp()
  with_modifiable(view.buf, function()
    vim.api.nvim_buf_set_lines(
      view.buf,
      position[1],
      position[1] + 1,
      false,
      {
        ('%s · %s%s'):format(
          options.conversation.copilot_label,
          completed_at,
          status and (' · ' .. status) or ''
        ),
      }
    )
  end)
end

local function begin_response(view, response_id)
  local now = ensure_day_header(view, options.now())
  flush(view)
  vim.api.nvim_buf_clear_namespace(view.buf, message_heading_namespace, 0, -1)
  local heading_row = vim.api.nvim_buf_line_count(view.buf)
  local started_at = timestamp(now)
  append(
    view,
    ('\n%s · %s · ○ processing…\n\n'):format(
      options.conversation.copilot_label,
      started_at
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
  view.awaiting_response = response_id or true
end

function M.begin_response(member_id, response_id)
  local view = M.ensure_member(member_id).views.conversation
  if view.awaiting_response or view.active_message then return end
  begin_response(view, response_id)
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
    else
      begin_response(view, message_id)
      view.awaiting_response = nil
      first_visible_delta = true
    end
  end
  if first_visible_delta then
    local line_count = vim.api.nvim_buf_line_count(view.buf)
    local last = vim.api.nvim_buf_get_lines(view.buf, line_count - 1, line_count, false)[1] or ''
    if last ~= '' then append(view, '\n', false) end
  end
  append(view, content, false)
end

function M.fail_response(member_id, detail)
  local view = M.ensure_member(member_id).views.conversation
  if not view.awaiting_response and not view.active_message then return end
  flush(view)
  touch_message_heading(view, '✗ ' .. (detail or 'failed'))
  view.awaiting_response = nil
  view.active_message = nil
  view.streaming = false
  finalize_render(view)
end

function M.complete_conversation(member_id, message_id, content)
  local entry = M.ensure_member(member_id)
  local view = entry.views.conversation
  if view.awaiting_response and content == '' then
    return
  elseif view.awaiting_response then
    append(view, content .. '\n', true)
    view.awaiting_response = nil
    touch_message_heading(view)
  elseif view.active_message == message_id then
    append(view, '\n', true)
    touch_message_heading(view)
  else
    M.append_block(member_id, 'conversation', 'Copilot', content)
  end
  view.active_message = nil
end

function M.finish_response(member_id)
  local entry = registry[member_id]
  local view = entry and entry.views.conversation
  if not view or (not view.awaiting_response and not view.active_message) then return end
  flush(view)
  touch_message_heading(view)
  view.awaiting_response = nil
  view.active_message = nil
  view.streaming = false
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
        if view.id == 'conversation' then entry.unread = 0 end
        follow_bottom(view)
        return
      end
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
return M
