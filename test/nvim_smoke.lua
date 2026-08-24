local root = vim.env.COPILOT_FLEET_ROOT
assert(root and root ~= '', 'COPILOT_FLEET_ROOT is required')
vim.opt.runtimepath:prepend(root)

local buffers = require('copilot_fleet.buffers')
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

buffers.reset()
print('nvim smoke passed')
