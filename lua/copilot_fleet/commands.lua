local M = {}

function M.parse(text)
  local name, input = text:match('^/([^%s]+)%s*(.*)$')
  if not name then return nil end
  return {
    name = name,
    input = input ~= '' and input or nil,
  }
end

function M.prompt(command)
  local suffix = command.input and command.input.hint and ' ' or ''
  return '/' .. command.name .. suffix
end

return M
