local root = vim.env.COPILOT_FLEET_ROOT
assert(root and root ~= '', 'COPILOT_FLEET_ROOT is required')
vim.opt.runtimepath:prepend(root)

local fleet = require('copilot_fleet')
fleet.setup({ overview_max_agents = 4 })
fleet._on_event({
  v = 1,
  type = 'mode.changed',
  payload = {
    mode = 'fleet',
    fleetId = 'ui-smoke',
    entryMember = 'coordinator',
    members = {
      { id = 'coordinator', displayName = 'Coordinator' },
      { id = 'planner', displayName = 'Planner' },
      { id = 'implementer', displayName = 'Implementer' },
      { id = 'reviewer', displayName = 'Reviewer' },
      { id = 'observer', displayName = 'Observer' },
    },
  },
})
fleet.show_overview()

local wins = vim.api.nvim_tabpage_list_wins(0)
assert(#wins == 5, ('expected four agent windows and one prompt, got %d'):format(#wins))
local visible = {}
for _, win in ipairs(wins) do
  visible[vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(win))] = true
end
assert(visible['copilot-fleet://coordinator/conversation'])
assert(visible['copilot-fleet://planner/conversation'])
assert(visible['copilot-fleet://implementer/conversation'])
assert(visible['copilot-fleet://reviewer/conversation'])
local prompt_visible = false
for name in pairs(visible) do
  if vim.fn.fnamemodify(name, ':t') == 'AI Prompt' then prompt_visible = true end
end
assert(prompt_visible, 'missing prompt buffer; visible=' .. vim.inspect(visible))
assert(not visible['copilot-fleet://observer/conversation'])

fleet._on_event({
  v = 1,
  id = 'observer-message',
  type = 'conversation.message',
  memberId = 'observer',
  target = 'conversation',
  done = true,
  payload = {
    messageId = 'observer-message',
    content = 'Hidden buffers retain this message.',
  },
})
local buffers = require('copilot_fleet.buffers')
assert(buffers.get_member('observer').unread == 1)
local observer_buf = buffers.buffer('observer', 'conversation')
local text = table.concat(vim.api.nvim_buf_get_lines(observer_buf, 0, -1, false), '\n')
assert(text:find('Hidden buffers retain this message.', 1, true))

fleet.show_member('observer')
assert(buffers.get_member('observer').unread == 0)
assert(vim.api.nvim_get_current_buf() == observer_buf)
assert(#vim.api.nvim_tabpage_list_wins(0) == 2, 'member view contains an unexpected activity pane')
fleet._on_event({
  v = 1,
  id = 'reasoning-summary',
  type = 'activity.reasoning',
  memberId = 'observer',
  target = 'activity',
  done = true,
  payload = {
    reasoningId = 'reasoning-summary',
    content = 'The SDK-provided reasoning summary is visible.',
  },
})
local conversation_text = table.concat(
  vim.api.nvim_buf_get_lines(observer_buf, 0, -1, false),
  '\n'
)
assert(conversation_text:find('The SDK-provided reasoning summary is visible.', 1, true))
local namespace = vim.api.nvim_get_namespaces().copilot_fleet_inline_activity
local activity_marks = vim.api.nvim_buf_get_extmarks(observer_buf, namespace, 0, -1, {
  details = true,
})
assert(#activity_marks > 0, 'inline activity has no muted highlight')
assert(activity_marks[#activity_marks][4].hl_group == 'Comment')

fleet._on_event({
  v = 1,
  id = 'tool-activity',
  type = 'activity.event',
  memberId = 'observer',
  target = 'activity',
  done = true,
  payload = {
    eventType = 'Tool',
    data = { toolName = 'view' },
  },
})
fleet._on_event({
  v = 1,
  id = 'observer-response',
  type = 'conversation.delta',
  memberId = 'observer',
  target = 'conversation',
  done = false,
  payload = {
    messageId = 'observer-response',
    content = 'Assistant output remains normally highlighted.',
  },
})
fleet._on_event({
  v = 1,
  id = 'observer-response',
  type = 'conversation.message',
  memberId = 'observer',
  target = 'conversation',
  done = true,
  payload = {
    messageId = 'observer-response',
    content = 'Assistant output remains normally highlighted.',
  },
})
conversation_text = table.concat(vim.api.nvim_buf_get_lines(observer_buf, 0, -1, false), '\n')
assert(conversation_text:find('> **Tool**', 1, true))
assert(conversation_text:find('> view', 1, true))
assert(conversation_text:find('Assistant output remains normally highlighted.', 1, true))
activity_marks = vim.api.nvim_buf_get_extmarks(observer_buf, namespace, 0, -1, {
  details = true,
})
local assistant_row
for row, line in ipairs(vim.api.nvim_buf_get_lines(observer_buf, 0, -1, false)) do
  if line == '## Observer' then assistant_row = row - 1 end
end
assert(assistant_row, 'assistant response heading was not found')
for _, mark in ipairs(activity_marks) do
  assert(mark[4].end_row <= assistant_row, 'activity highlight leaked into assistant output')
end

fleet.close()
fleet.show_member('observer')
assert(#vim.api.nvim_tabpage_list_wins(0) == 2, 'UI reopen created an unexpected activity pane')
fleet.close()
print('nvim UI smoke passed')
