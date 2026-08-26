local root = vim.env.NATIVE_COPILOT_ROOT
assert(root and root ~= '', 'NATIVE_COPILOT_ROOT is required')
vim.opt.runtimepath:prepend(root)

local buffers = require('native_copilot.buffers')
local commands = require('native_copilot.commands')
assert(commands.parse('/autopilot on').name == 'autopilot')
assert(commands.parse('/autopilot on').input == 'on')
assert(commands.parse('/refine first line\nsecond line').input == 'first line\nsecond line')
assert(commands.parse('/future-command').name == 'future-command')
assert(commands.parse('normal prompt') == nil)
assert(commands.prompt({ name = 'model', input = { hint = 'model name' } }) == '/model ')
local command_catalog = {
  {
    name = 'autopilot',
    aliases = { 'auto' },
    description = 'Toggle autopilot',
    input = {
      choices = {
        { name = 'on', description = 'Enable autopilot' },
        { name = 'off', description = 'Disable autopilot' },
      },
    },
  },
}
assert(commands.find(command_catalog, 'AUTO').name == 'autopilot')
local merged_catalog = commands.merge(command_catalog, {
  { name = 'tasks', description = 'Manage tasks', kind = 'client' },
})
assert(#merged_catalog == 2)
assert(commands.find(merged_catalog, 'tasks').kind == 'client')
assert(#commands.merge(merged_catalog, { { name = 'tasks' } }) == 2)
local overridden_catalog = commands.merge({
  { name = 'fleet', description = 'SDK Fleet', kind = 'builtin' },
  { name = 'resume', description = 'SDK Resume', kind = 'builtin' },
}, {
  { name = 'fleet', description = 'Configured Fleet', kind = 'client' },
  { name = 'resume', description = 'Session picker', kind = 'client' },
})
assert(#overridden_catalog == 2)
assert(commands.find(overridden_catalog, 'fleet').kind == 'client')
assert(commands.find(overridden_catalog, 'resume').kind == 'client')
assert(commands.command_matches(command_catalog, 'aut')[1].word == 'autopilot')
assert(commands.command_matches(command_catalog, 'au')[2].word == 'auto')
assert(commands.choice_matches(command_catalog[1], 'o')[1].word == 'on')
assert(#commands.choice_matches(command_catalog[1], 'missing') == 0)
local start_column, completion_matches = commands.complete('/aut', command_catalog)
assert(start_column == 2)
assert(completion_matches[1].word == 'autopilot')
start_column, completion_matches = commands.complete('/autopilot o', command_catalog)
assert(start_column == 12)
assert(completion_matches[1].word == 'on')
command_catalog[1].input = { completion = 'directory' }
start_column, completion_matches = commands.complete('/autopilot src', command_catalog, function()
  return { 'src/', 'scripts/' }
end)
assert(start_column == 12)
assert(completion_matches[1].word == 'src/')
commands.set_catalog('reviewer', command_catalog)
assert(commands.catalog('reviewer') == command_catalog)
local blink_source = require('native_copilot.blink').new()
local blink_buf = vim.api.nvim_create_buf(false, true)
vim.b[blink_buf].native_copilot_prompt = true
vim.b[blink_buf].native_copilot_target = 'reviewer'
local blink_response
blink_source:get_completions({
  bufnr = blink_buf,
  line = '/aut',
  cursor = { 1, 4 },
}, function(response)
  blink_response = response
end)
assert(#blink_response.items == 2)
assert(blink_response.items[1].textEdit.newText == 'autopilot')
assert(blink_response.items[1].textEdit.range.start.character == 1)
assert(blink_response.items[1].textEdit.range['end'].character == 4)
commands.reset_catalogs()
assert(commands.catalog('reviewer') == nil)
local catalog_notified = false
local unsubscribe = commands.on_catalog('reviewer', function(available)
  catalog_notified = available == command_catalog
end)
commands.set_catalog('reviewer', command_catalog)
assert(catalog_notified)
unsubscribe()
buffers.setup()
local member = buffers.ensure_member('reviewer', 'Reviewer')
assert(vim.bo[member.views.conversation.buf].buftype == 'nofile')
assert(vim.bo[member.views.conversation.buf].filetype == 'native-copilot')
assert(vim.b[member.views.conversation.buf].native_copilot == true)

buffers.append_block('reviewer', 'conversation', 'You', 'Please review this.')
buffers.append_activity_delta('reviewer', 'reasoning-1', 'Checking the ')
buffers.append_activity_delta('reviewer', 'reasoning-1', 'implementation.')
buffers.complete_activity('reviewer', 'reasoning-1', 'Checking the implementation.')
buffers.append_conversation_delta('reviewer', 'message-1', 'The implementation ')
local streaming_text = table.concat(
  vim.api.nvim_buf_get_lines(member.views.conversation.buf, 0, -1, false),
  '\n'
)
assert(streaming_text:match('# Copilot · %d%d:%d%d:%d%d · ○ processing…'))
buffers.append_conversation_delta('reviewer', 'message-1', 'looks correct.')
buffers.complete_conversation('reviewer', 'message-1', 'The implementation looks correct.')
buffers.append_activity_delta('reviewer', 'reasoning-late', 'Late but ')
buffers.complete_activity('reviewer', 'reasoning-late', 'Late but ordered summary.')
vim.wait(250)

local text = table.concat(
  vim.api.nvim_buf_get_lines(member.views.conversation.buf, 0, -1, false),
  '\n'
)
assert(text:find('# You', 1, true))
assert(text:match('# You · %d%d:%d%d:%d%d'))
assert(text:find('Please review this.', 1, true))
assert(text:find('> **Reasoning summary**', 1, true))
assert(text:find('> Checking the implementation.', 1, true))
assert(text:find('# Copilot', 1, true))
assert(text:match('# Copilot · %d%d:%d%d:%d%d'))
assert(not text:find('○ processing…', 1, true))
assert(not text:find('# Reviewer', 1, true))
assert(text:find('The implementation looks correct.', 1, true))
local late_reasoning = text:find('Late but ordered summary.', 1, true)
local assistant_heading = text:find('# Copilot', 1, true)
assert(late_reasoning and assistant_heading and late_reasoning < assistant_heading)
local _, count = text:gsub('The implementation looks correct%.', '')
assert(count == 1, 'stream final message was duplicated')
local _, reasoning_count = text:gsub('Checking the implementation%.', '')
assert(reasoning_count == 1, 'stream final reasoning was duplicated')

local namespace = vim.api.nvim_get_namespaces().native_copilot_inline_activity
local activity_marks = vim.api.nvim_buf_get_extmarks(
  member.views.conversation.buf,
  namespace,
  0,
  -1,
  { details = true }
)
assert(#activity_marks == 2, 'reasoning summaries did not produce two inline highlights')
local assistant_row
for row, line in ipairs(vim.api.nvim_buf_get_lines(member.views.conversation.buf, 0, -1, false)) do
  if line:match('^# Copilot · %d%d:%d%d:%d%d$') then assistant_row = row - 1 end
end
assert(assistant_row, 'assistant heading row was not found')
for _, mark in ipairs(activity_marks) do
  assert(mark[4].hl_group == 'Comment')
  assert(mark[4].end_row <= assistant_row, 'inline activity highlight leaked into the assistant response')
end
vim.api.nvim_win_set_buf(0, member.views.conversation.buf)
buffers.on_shown(member.views.conversation.buf)

buffers.append_block('reviewer', 'conversation', 'You', 'Inspect the plain text lifecycle.')
buffers.append_activity_delta('reviewer', 'reasoning-2', 'Still reasoning...')
buffers.complete_activity('reviewer', 'reasoning-2', 'Still reasoning...')

buffers.set_state('reviewer', 'busy')
buffers.upsert_timeline('reviewer', 'environment:MCP myenghub', {
  kind = 'environment',
  label = 'MCP myenghub',
  status = 'running',
  detail = 'pending',
})
buffers.upsert_timeline('reviewer', 'environment:MCP myenghub', {
  kind = 'environment',
  label = 'MCP myenghub',
  status = 'completed',
  detail = 'connected',
})
local mcp_rows = 0
for _, line in ipairs(vim.api.nvim_buf_get_lines(member.views.conversation.buf, 0, -1, false)) do
  if line:find('[environment] MCP myenghub', 1, true) then mcp_rows = mcp_rows + 1 end
end
assert(mcp_rows == 1, 'MCP status transition duplicated the underlying timeline row')
local mcp_text = table.concat(
  vim.api.nvim_buf_get_lines(member.views.conversation.buf, 0, -1, false),
  '\n'
)
assert(mcp_text:match(
  '> ✓ %*%*%[environment%] MCP myenghub%*%* — connected · %d%d:%d%d:%d%d'
))
local mcp_row
for index, line in ipairs(vim.api.nvim_buf_get_lines(member.views.conversation.buf, 0, -1, false)) do
  if line:find('[environment] MCP myenghub', 1, true) then
    mcp_row = index - 1
    break
  end
end
assert(mcp_row ~= nil)
vim.bo[member.views.conversation.buf].modifiable = true
vim.api.nvim_buf_set_lines(
  member.views.conversation.buf,
  mcp_row + 1,
  mcp_row + 1,
  false,
  { '> ○ **[environment] MCP myenghub** — orphaned pending' }
)
vim.bo[member.views.conversation.buf].modifiable = false
buffers.upsert_timeline('reviewer', 'environment:MCP myenghub', {
  kind = 'environment',
  label = 'MCP myenghub',
  status = 'completed',
  detail = 'connected',
})
mcp_rows = 0
for _, line in ipairs(vim.api.nvim_buf_get_lines(member.views.conversation.buf, 0, -1, false)) do
  if line:find('[environment] MCP myenghub', 1, true) then mcp_rows = mcp_rows + 1 end
end
assert(mcp_rows == 1, 'MCP reconciliation did not remove an orphaned source row')
buffers.append_activity_block('reviewer', 'Error', 'Activity-only terminal output.')

require('native_copilot').setup({
  mappings = {
    toggle = '<leader>ait',
    fleet = '<leader>aif',
    select = '<leader>ais',
  },
})
assert(vim.fn.maparg('<leader>ait', 'n') ~= '')
assert(vim.fn.maparg('<leader>aif', 'n') ~= '')
assert(vim.fn.maparg('<leader>ais', 'n') ~= '')
assert(vim.fn.exists(':NativeCopilotTasks') == 2)
assert(vim.fn.exists(':NativeCopilotAbort') == 2)
assert(vim.fn.exists(':NativeCopilotCancelBackground') == 2)
assert(vim.fn.exists(':NativeCopilotReloadMcp') == 2)

buffers.reset()
print('nvim smoke passed')
