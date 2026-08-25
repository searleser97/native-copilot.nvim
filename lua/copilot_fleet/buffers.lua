local M = {}

local registry = {}
local render_generation = {}
local activity_namespace = vim.api.nvim_create_namespace('copilot_fleet_inline_activity')
local options = {
  render_debounce_ms = 200,
  stream_flush_ms = 80,
  follow_bottom = true,
}

local function with_modifiable(buf, operation)
  if not vim.api.nvim_buf_is_valid(buf) then return end
  local was_modifiable = vim.bo[buf].modifiable
  vim.bo[buf].modifiable = true
  operation()
  vim.bo[buf].modifiable = was_modifiable
end

local function render_markdown(buf, enabled)
  if not vim.api.nvim_buf_is_valid(buf) then return end
  local wins = vim.fn.win_findbuf(buf)
  if enabled and #wins == 0 then return end
  pcall(vim.api.nvim_buf_call, buf, function()
    local ok, renderer = pcall(require, 'render-markdown')
    if not ok then return end
    if enabled then
      renderer.buf_enable()
      renderer.render({
        buf = buf,
        win = wins,
        event = 'CopilotFleet',
      })
    else
      renderer.buf_disable()
    end
  end)
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
  view.dirty = true
  render_generation[view.buf] = (render_generation[view.buf] or 0) + 1
  local generation = render_generation[view.buf]
  vim.defer_fn(function()
    if not vim.api.nvim_buf_is_valid(view.buf) then return end
    if
      render_generation[view.buf] ~= generation
      or view.streaming
      or view.activity_streaming
      or not visible(view.buf)
    then
      return
    end
    render_markdown(view.buf, true)
    view.dirty = false
    follow_bottom(view)
  end, options.render_debounce_ms)
end

local function create_buffer(name, member_id, view_id)
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(buf, ('copilot-fleet://%s/%s'):format(member_id, view_id))
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'hide'
  vim.bo[buf].swapfile = false
  vim.bo[buf].undofile = false
  vim.bo[buf].filetype = 'markdown'
  vim.bo[buf].modifiable = false
  vim.b[buf].copilot_fleet = true
  vim.b[buf].copilot_fleet_member = member_id
  vim.b[buf].copilot_fleet_view = view_id
  local initial_lines = { '# ' .. name, '' }
  with_modifiable(buf, function()
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, initial_lines)
  end)
  render_markdown(buf, false)
  return {
    buf = buf,
    member_id = member_id,
    id = view_id,
    pending = '',
    flush_scheduled = false,
    streaming = false,
    activity_streaming = false,
    dirty = false,
    active_message = nil,
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

local function append(view, text, final)
  if text == '' then return end
  if not view.streaming then render_markdown(view.buf, false) end
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
  append(view, ('\n## %s\n\n%s\n'):format(heading, content), true)
end

local function begin_inline_activity(view, activity_id, heading)
  flush(view)
  render_generation[view.buf] = (render_generation[view.buf] or 0) + 1
  view.dirty = true
  render_markdown(view.buf, false)
  local start_row = vim.api.nvim_buf_line_count(view.buf)
  view.active_activity = {
    id = activity_id,
    start_row = start_row,
  }
  view.pending = view.pending .. ('\n> **%s**\n>\n> '):format(heading)
  flush(view)
end

function M.append_activity_delta(member_id, activity_id, content)
  local entry = M.ensure_member(member_id)
  local view = entry.views.conversation
  if not view.active_activity or view.active_activity.id ~= activity_id then
    begin_inline_activity(view, activity_id, 'Reasoning summary')
  end
  view.activity_streaming = true
  view.pending = view.pending .. content:gsub('\n', '\n> ')
  schedule_flush(view)
end

function M.complete_activity(member_id, activity_id, content)
  local entry = M.ensure_member(member_id)
  local view = entry.views.conversation
  if view.active_activity and view.active_activity.id == activity_id then
    view.pending = view.pending .. '\n'
    flush(view)
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
  view.active_activity = nil
  view.activity_streaming = false
  if not view.streaming then finalize_render(view) end
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
  if view.active_message ~= message_id then
    flush(view)
    view.active_message = message_id
    append(view, ('\n## %s\n\n'):format(entry.display_name), false)
  end
  append(view, content, false)
end

function M.complete_conversation(member_id, message_id, content)
  local entry = M.ensure_member(member_id)
  local view = entry.views.conversation
  if view.active_message == message_id then
    append(view, '\n', true)
  else
    M.append_block(member_id, 'conversation', entry.display_name, content)
  end
  view.active_message = nil
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
        if view.dirty and not view.streaming and not view.activity_streaming then
          finalize_render(view)
        end
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
  render_generation = {}
end
return M
