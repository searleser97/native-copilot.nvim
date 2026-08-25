local root = vim.env.COPILOT_FLEET_ROOT
assert(root and root ~= '', 'COPILOT_FLEET_ROOT is required')
vim.opt.runtimepath:prepend(root)

local render_calls = {}
package.loaded['render-markdown'] = {
  buf_enable = function() end,
  buf_disable = function() end,
  render = function(context) table.insert(render_calls, context) end,
}

local buffers = require('copilot_fleet.buffers')
local commands = require('copilot_fleet.commands')
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
local blink_source = require('copilot_fleet.blink').new()
local blink_buf = vim.api.nvim_create_buf(false, true)
vim.b[blink_buf].copilot_fleet_prompt = true
vim.b[blink_buf].copilot_fleet_target = 'reviewer'
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
buffers.setup({ render_debounce_ms = 30 })
local member = buffers.ensure_member('reviewer', 'Reviewer')
assert(vim.bo[member.views.conversation.buf].buftype == 'nofile')
assert(vim.bo[member.views.conversation.buf].filetype == 'markdown')
assert(vim.b[member.views.conversation.buf].copilot_fleet == true)

buffers.append_block('reviewer', 'conversation', 'You', 'Please review this.')
buffers.append_activity_delta('reviewer', 'reasoning-1', 'Checking the ')
buffers.append_activity_delta('reviewer', 'reasoning-1', 'implementation.')
buffers.complete_activity('reviewer', 'reasoning-1', 'Checking the implementation.')
buffers.append_conversation_delta('reviewer', 'message-1', 'The implementation ')
buffers.append_conversation_delta('reviewer', 'message-1', 'looks correct.')
buffers.complete_conversation('reviewer', 'message-1', 'The implementation looks correct.')
vim.wait(250)

local text = table.concat(
  vim.api.nvim_buf_get_lines(member.views.conversation.buf, 0, -1, false),
  '\n'
)
assert(text:find('## You', 1, true))
assert(text:find('Please review this.', 1, true))
assert(text:find('> **Reasoning summary**', 1, true))
assert(text:find('> Checking the implementation.', 1, true))
assert(text:find('## Reviewer', 1, true))
assert(text:find('The implementation looks correct.', 1, true))
local _, count = text:gsub('The implementation looks correct%.', '')
assert(count == 1, 'stream final message was duplicated')
local _, reasoning_count = text:gsub('Checking the implementation%.', '')
assert(reasoning_count == 1, 'stream final reasoning was duplicated')

local namespace = vim.api.nvim_get_namespaces().copilot_fleet_inline_activity
local activity_marks = vim.api.nvim_buf_get_extmarks(
  member.views.conversation.buf,
  namespace,
  0,
  -1,
  { details = true }
)
assert(#activity_marks == 1, 'streamed reasoning did not produce one inline highlight')
assert(activity_marks[1][4].hl_group == 'Comment')
local assistant_row
for row, line in ipairs(vim.api.nvim_buf_get_lines(member.views.conversation.buf, 0, -1, false)) do
  if line == '## Reviewer' then assistant_row = row - 1 end
end
assert(assistant_row, 'assistant heading row was not found')
assert(
  activity_marks[1][4].end_row <= assistant_row,
  'inline activity highlight leaked into the assistant response'
)
assert(#render_calls == 0, 'hidden buffer was rendered')
vim.api.nvim_win_set_buf(0, member.views.conversation.buf)
buffers.on_shown(member.views.conversation.buf)
vim.wait(80)
assert(#render_calls == 1, 'visible buffer was not rendered once')
assert(render_calls[1].buf == member.views.conversation.buf)
assert(#render_calls[1].win == 1)

buffers.append_block('reviewer', 'conversation', 'You', 'Inspect the render lifecycle.')
buffers.append_activity_delta('reviewer', 'reasoning-2', 'Still reasoning...')
vim.wait(80)
assert(#render_calls == 1, 'Markdown rendered while reasoning was streaming')
buffers.complete_activity('reviewer', 'reasoning-2', 'Still reasoning...')
vim.wait(80)
assert(#render_calls == 2, 'completed reasoning did not render')

buffers.set_state('reviewer', 'busy')
buffers.append_activity_block('reviewer', 'Error', 'Activity-only terminal output.')
vim.wait(80)
assert(#render_calls == 3, 'activity-only output did not render while member state was busy')

require('copilot_fleet').setup({
  mappings = {
    toggle = '<leader>ait',
    fleet = '<leader>aif',
    select = '<leader>ais',
    tasks = '<leader>aik',
    abort = '<leader>aix',
  },
})
assert(vim.fn.maparg('<leader>ait', 'n') ~= '')
assert(vim.fn.maparg('<leader>aif', 'n') ~= '')
assert(vim.fn.maparg('<leader>ais', 'n') ~= '')
assert(vim.fn.maparg('<leader>aik', 'n') ~= '')
assert(vim.fn.maparg('<leader>aix', 'n') ~= '')
assert(vim.fn.exists(':CopilotFleetTasks') == 2)
assert(vim.fn.exists(':CopilotFleetAbort') == 2)
assert(vim.fn.exists(':CopilotFleetCancelBackground') == 2)

buffers.reset()
print('nvim smoke passed')
