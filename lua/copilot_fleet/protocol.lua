local M = {}

local state = {
  job = nil,
  partial = '',
  on_event = nil,
  stopping = false,
}

local function plugin_root()
  local source = debug.getinfo(1, 'S').source:sub(2)
  return vim.fs.dirname(vim.fs.dirname(vim.fs.dirname(source)))
end

local function request_id()
  return ('nvim-%x-%x'):format(vim.uv.hrtime(), math.random(0, 0x7fffffff))
end

local function log_stderr(data)
  local lines = {}
  for _, line in ipairs(data or {}) do
    if line ~= '' then table.insert(lines, line) end
  end
  if #lines == 0 then return end
  local directory = vim.fn.stdpath('state')
  vim.fn.mkdir(directory, 'p')
  vim.fn.writefile(lines, directory .. '/copilot-fleet.log', 'a')
end

local function process_line(line)
  if line == '' then return end
  local ok, message = pcall(vim.json.decode, line)
  if not ok or type(message) ~= 'table' then
    vim.schedule(function()
      vim.notify('Copilot Fleet received invalid host output. See copilot-fleet.log.', vim.log.levels.ERROR)
    end)
    log_stderr({ 'Invalid host NDJSON: ' .. line })
    return
  end
  if message.v ~= 1 then
    log_stderr({ ('Unsupported protocol version: %s'):format(vim.inspect(message.v)) })
    return
  end
  if state.on_event then
    vim.schedule(function()
      if state.on_event then state.on_event(message) end
    end)
  end
end

local function on_stdout(_, data)
  if not data or #data == 0 then return end
  data[1] = state.partial .. data[1]
  state.partial = data[#data]
  for index = 1, #data - 1 do
    process_line(data[index])
  end
end

function M.is_running()
  return state.job ~= nil and vim.fn.jobwait({ state.job }, 0)[1] == -1
end

function M.start(opts, on_event)
  if M.is_running() then
    state.on_event = on_event
    return true
  end

  local host = plugin_root() .. '/dist/main.js'
  if vim.fn.filereadable(host) ~= 1 then
    vim.notify(
      'Copilot Fleet host is not built. Run npm install && npm run build in ' .. plugin_root(),
      vim.log.levels.ERROR
    )
    return false
  end

  state.on_event = on_event
  state.partial = ''
  state.stopping = false
  local command = {
    opts.node_command or 'node',
    host,
    '--workspace', opts.workspace or vim.uv.cwd(),
    '--config', opts.config_path,
    '--db', opts.database_path,
  }
  state.job = vim.fn.jobstart(command, {
    cwd = opts.workspace or vim.uv.cwd(),
    stdout_buffered = false,
    stderr_buffered = false,
    on_stdout = on_stdout,
    on_stderr = function(_, data) log_stderr(data) end,
    on_exit = function(_, code)
      local expected = state.stopping
      state.job = nil
      state.partial = ''
      if not expected then
        vim.schedule(function()
          vim.notify(('Copilot Fleet host exited with code %d.'):format(code), vim.log.levels.ERROR)
        end)
      end
    end,
  })
  if state.job <= 0 then
    state.job = nil
    vim.notify('Could not start the Copilot Fleet host.', vim.log.levels.ERROR)
    return false
  end
  return true
end

function M.send(message_type, payload)
  if not M.is_running() then
    return nil, 'Copilot Fleet host is not running'
  end
  local id = request_id()
  local encoded = vim.json.encode({
    v = 1,
    id = id,
    type = message_type,
    payload = payload or vim.empty_dict(),
  })
  local written = vim.fn.chansend(state.job, encoded .. '\n')
  if written == 0 then
    return nil, 'Could not write to the Copilot Fleet host'
  end
  return id
end

function M.stop_sync(timeout_ms)
  if not M.is_running() then return end
  state.stopping = true
  M.send('shutdown')
  local result = vim.fn.jobwait({ state.job }, timeout_ms or 1500)[1]
  if result == -1 and state.job then
    vim.fn.jobstop(state.job)
    vim.fn.jobwait({ state.job }, 500)
  end
  state.job = nil
end
return M
return M
