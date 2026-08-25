local commands = require('copilot_fleet.commands')

local Source = {}
Source.__index = Source

function Source.new()
  return setmetatable({}, Source)
end

function Source:enabled()
  return vim.b.native_copilot_prompt == true or vim.b.copilot_fleet_prompt == true
end

function Source:get_trigger_characters()
  return { '/', ' ' }
end

local function response(context, catalog)
  local before = context.line:sub(1, context.cursor[2])
  local start_column, matches = commands.complete(before, catalog, function(prefix)
    return vim.fn.getcompletion(prefix, 'dir')
  end)
  local items = {}
  if start_column then
    local range = {
      start = {
        line = context.cursor[1] - 1,
        character = start_column - 1,
      },
      ['end'] = {
        line = context.cursor[1] - 1,
        character = context.cursor[2],
      },
    }
    for _, match in ipairs(matches) do
      table.insert(items, {
        label = match.abbr or match.word,
        filterText = match.word,
        detail = match.menu,
        textEdit = {
          newText = match.word,
          range = range,
        },
        insertTextFormat = vim.lsp.protocol.InsertTextFormat.PlainText,
      })
    end
  end
  return {
    items = items,
    is_incomplete_forward = true,
    is_incomplete_backward = true,
  }
end

function Source:get_completions(context, callback)
  local target = vim.b[context.bufnr].native_copilot_target
    or vim.b[context.bufnr].copilot_fleet_target
  if not target then
    callback({ items = {} })
    return
  end
  local catalog = target and commands.catalog(target) or nil
  if catalog then
    callback(response(context, catalog))
    return
  end

  local cancelled = false
  local unsubscribe = commands.on_catalog(target, function(available)
    if not cancelled then callback(response(context, available)) end
  end)
  local ok, fleet = pcall(require, 'native_copilot')
  if ok then fleet.ensure_commands(target) end
  return function()
    cancelled = true
    unsubscribe()
  end
end

return Source
