local M = {}

local registry = {}
local render_generation = {}

local function with_modifiable(buf, operation)
  if not vim.api.nvim_buf_is_valid(buf) then return end
  local was_modifiable = vim.bo[buf].modifiable
  vim.bo[buf].modifiable = true
  operation()
  vim.bo[buf].modifiable = was_modifiable
end

local function render_markdown(buf, enabled)
  if not vim.api.nvim_buf_is_valid(buf) then return end
  pcall(vim.api.nvim_buf_call, buf, function()
    local ok, renderer = pcall(require, 'render-markdown')
    if not ok then return end
    if enabled then
      renderer.buf_enable()
      vim.api.nvim_exec_autocmds('TextChanged', { buffer = buf, modeline = false })
    else
      renderer.buf_disable()
    end
  end)
end

local function visible(buf)
  return #vim.fn.win_findbuf(buf) > 0
end

local function finalize_render(view)
  view.dirty = true
  render_generation[view.buf] = (render_generation[view.buf] or 0) + 1
  local generation = render_generation[view.buf]
  vim.defer_fn(function()
    if not vim.api.nvim_buf_is_valid(view.buf) then return end
    if render_generation[view.buf] ~= generation or view.streaming or not visible(view.buf) then
      return
    end
    render_markdown(view.buf, true)
    view.dirty = false
  end, 180)
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
  with_modifiable(buf, function()
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, { '# ' .. name, '' })
  end)
  render_markdown(buf, false)
  return {
    buf = buf,
    member_id = member_id,
    id = view_id,
    pending = '',
    flush_scheduled = false,
    streaming = false,
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
  created.views.activity = create_buffer(created.display_name .. ' — Activity', member_id, 'activity')
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
end

local function schedule_flush(view)
  if view.flush_scheduled then return end
  view.flush_scheduled = true
  vim.defer_fn(function()
    if vim.api.nvim_buf_is_valid(view.buf) then flush(view) end
  end, 80)
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

function M.append_conversation_delta(member_id, message_id, content)
  local entry = M.ensure_member(member_id)
  local view = entry.views.conversation
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

function M.append_activity_delta(member_id, reasoning_id, content)
  local entry = M.ensure_member(member_id)
  local view = entry.views.activity
  if view.active_message ~= reasoning_id then
    flush(view)
    view.active_message = reasoning_id
    append(view, '\n## Reasoning summary\n\n', false)
  end
  append(view, content, false)
end

function M.complete_activity(member_id, reasoning_id, content)
  local entry = M.ensure_member(member_id)
  local view = entry.views.activity
  if view.active_message == reasoning_id then
    append(view, '\n', true)
  else
    M.append_block(member_id, 'activity', 'Reasoning summary', content)
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
        if view.dirty and not view.streaming then
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
return M
