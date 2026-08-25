local M = {}
local catalogs = {}
local catalog_listeners = {}

function M.parse(text)
  local name = text:match('^/([^%s]+)')
  if not name then return nil end
  local input = text:sub(#name + 2):gsub('^%s+', '')
  return {
    name = name,
    input = input ~= '' and input or nil,
  }
end

function M.prompt(command)
  local suffix = command.input and command.input.hint and ' ' or ''
  return '/' .. command.name .. suffix
end

function M.find(available, name)
  local wanted = name:lower()
  for _, command in ipairs(available or {}) do
    if command.name:lower() == wanted then return command end
    for _, alias in ipairs(command.aliases or {}) do
      if alias:lower() == wanted then return command end
    end
  end
end

function M.command_matches(available, prefix)
  local matches = {}
  local wanted = prefix:lower()
  for _, command in ipairs(available or {}) do
    if command.name:lower():find(wanted, 1, true) == 1 then
      table.insert(matches, {
        word = command.name,
        abbr = '/' .. command.name,
        menu = command.description,
      })
    end
    for _, alias in ipairs(command.aliases or {}) do
      if alias:lower():find(wanted, 1, true) == 1 then
        table.insert(matches, {
          word = alias,
          abbr = '/' .. alias,
          menu = ('alias for /%s'):format(command.name),
        })
      end
    end
  end
  return matches
end

function M.choice_matches(command, prefix)
  local matches = {}
  local wanted = prefix:lower()
  for _, choice in ipairs(command.input and command.input.choices or {}) do
    if choice.name:lower():find(wanted, 1, true) == 1 then
      table.insert(matches, {
        word = choice.name,
        menu = choice.description,
      })
    end
  end
  return matches
end

function M.complete(before, available, directories)
  local column = #before
  local command_prefix = before:match('^/([^%s]*)$')
  if command_prefix then
    local matches = M.command_matches(available, command_prefix)
    if #matches == 0 then return nil end
    return column - #command_prefix + 1, matches
  end

  local command_name, input = before:match('^/([^%s]+)%s+(.*)$')
  local command = command_name and M.find(available, command_name) or nil
  if not command or not command.input then return nil end
  local matches = M.choice_matches(command, input)
  if #matches == 0 and command.input.completion == 'directory' and directories then
    for _, path in ipairs(directories(input)) do
      table.insert(matches, { word = path, menu = 'directory' })
    end
  end
  if #matches == 0 then return nil end
  return column - #input + 1, matches
end

function M.set_catalog(target, available)
  catalogs[target] = available
  local listeners = catalog_listeners[target] or {}
  catalog_listeners[target] = nil
  for _, listener in ipairs(listeners) do
    listener(available)
  end
end

function M.catalog(target)
  return catalogs[target]
end

function M.on_catalog(target, listener)
  catalog_listeners[target] = catalog_listeners[target] or {}
  local listeners = catalog_listeners[target]
  table.insert(listeners, listener)
  return function()
    for index, candidate in ipairs(listeners) do
      if candidate == listener then
        table.remove(listeners, index)
        break
      end
    end
  end
end

function M.reset_catalogs()
  catalogs = {}
  catalog_listeners = {}
end

return M
