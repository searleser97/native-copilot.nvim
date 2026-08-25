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
buffers.setup({ render_debounce_ms = 30 })
local member = buffers.ensure_member('reviewer', 'Reviewer')
assert(vim.bo[member.views.conversation.buf].buftype == 'nofile')
assert(vim.bo[member.views.conversation.buf].filetype == 'markdown')
assert(vim.b[member.views.conversation.buf].copilot_fleet == true)

buffers.append_block('reviewer', 'conversation', 'You', 'Please review this.')
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
assert(text:find('## Reviewer', 1, true))
assert(text:find('The implementation looks correct.', 1, true))
local _, count = text:gsub('The implementation looks correct%.', '')
assert(count == 1, 'stream final message was duplicated')
assert(#render_calls == 0, 'hidden buffer was rendered')
vim.api.nvim_win_set_buf(0, member.views.conversation.buf)
buffers.on_shown(member.views.conversation.buf)
vim.wait(80)
assert(#render_calls == 1, 'visible buffer was not rendered once')
assert(render_calls[1].buf == member.views.conversation.buf)
assert(#render_calls[1].win == 1)

require('copilot_fleet').setup({
  mappings = {
    toggle = '<leader>ait',
    fleet = '<leader>aif',
    select = '<leader>ais',
  },
})
assert(vim.fn.maparg('<leader>ait', 'n') ~= '')
assert(vim.fn.maparg('<leader>aif', 'n') ~= '')
assert(vim.fn.maparg('<leader>ais', 'n') ~= '')
assert(vim.fn.maparg('<leader>air', 'n') ~= '')

buffers.reset()
print('nvim smoke passed')
