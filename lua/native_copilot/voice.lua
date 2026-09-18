local M = {}

local active
local helper
local setup_process

local source = debug.getinfo(1, 'S').source:sub(2)
local plugin_root = vim.fs.dirname(vim.fs.dirname(vim.fs.dirname(source)))
local helper_path = vim.fs.joinpath(plugin_root, 'python', 'native_copilot_voice.py')

local function data_root()
  return vim.fs.joinpath(vim.fn.stdpath('data'), 'native-copilot', 'voice')
end

local function venv_python(options)
  local root = options.venv_path and vim.fn.expand(options.venv_path)
    or vim.fs.joinpath(data_root(), '.venv')
  return vim.fs.joinpath(root, 'Scripts', 'python.exe'), root
end

local function finish_active(result)
  local current = active
  if not current then return end
  active = nil
  current.callback(result)
end

local function decode_event(line)
  if line == '' then return nil end
  local ok, event = pcall(vim.json.decode, line)
  if ok and type(event) == 'table' then return event end
  return nil
end

local function send(command)
  if not helper or helper.job <= 0 then return false end
  vim.fn.chansend(helper.job, vim.json.encode(command) .. '\n')
  return true
end

local function report_active(event)
  if not active or not active.status then return end
  if event.type == 'state' then
    if active.last_state == event.state then return end
    active.last_state = event.state
  end
  active.status(event)
end

local function handle_event(event)
  if event.type == 'state' then
    helper.ready = event.state == 'ready' or helper.ready
    if event.state == 'ready' and helper.pending_start then
      local pending = helper.pending_start
      helper.pending_start = nil
      send(pending)
    end
    if helper.observer then helper.observer(event) end
    report_active(event)
    return
  end
  if event.type == 'partial' then
    report_active(event)
    return
  end
  if event.type == 'transcript' then
    finish_active({ kind = 'transcript', text = event.text or '' })
  elseif event.type == 'no_speech' then
    finish_active({ kind = 'no_speech' })
  elseif event.type == 'canceled' then
    finish_active({ kind = 'canceled' })
  elseif event.type == 'error' then
    local observer = helper and helper.observer or nil
    if helper then helper.observer = nil end
    if active then
      finish_active({ kind = 'error', message = event.message or 'Voice dictation failed.' })
    elseif observer then
      observer(event)
    end
  end
end

local function consume_lines(state, data)
  for index, chunk in ipairs(data or {}) do
    local line = state.partial .. chunk
    if index == #data and chunk ~= '' then
      state.partial = line
    else
      state.partial = ''
      local event = decode_event(line)
      if event then handle_event(event) end
    end
  end
end

local function stop_helper()
  if not helper then return end
  local job = helper.job
  helper = nil
  if job > 0 then
    pcall(vim.fn.chansend, job, vim.json.encode({ command = 'shutdown' }) .. '\n')
    pcall(vim.fn.jobstop, job)
  end
end

local function ensure_helper(options)
  if helper and helper.job > 0 then return true end
  local python = venv_python(options)
  if vim.fn.executable(python) ~= 1 then
    return false,
      'Nemotron voice support is not prepared. Run :NativeCopilotVoiceSetup first.'
  end
  if vim.fn.filereadable(helper_path) ~= 1 then
    return false, 'Native Copilot voice helper is missing: ' .. helper_path
  end

  local state = {
    job = 0,
    ready = false,
    pending_start = nil,
    partial = '',
    observer = nil,
  }
  state.job = vim.fn.jobstart({
    python,
    helper_path,
    '--model',
    options.model,
    '--language',
    options.language,
  }, {
    stdout_buffered = false,
    stderr_buffered = true,
    on_stdout = function(_, data)
      vim.schedule(function()
        if helper == state then consume_lines(state, data) end
      end)
    end,
    on_stderr = function(_, data)
      local detail = vim.trim(table.concat(data or {}, '\n'))
      if detail ~= '' then state.stderr = detail end
    end,
    on_exit = function(_, code)
      vim.schedule(function()
        if helper ~= state then return end
        helper = nil
        if active then
          finish_active({
            kind = 'error',
            message = state.stderr
              or ('Nemotron voice helper exited unexpectedly (code %d).'):format(code),
          })
        elseif state.observer then
          state.observer({
            type = 'error',
            message = state.stderr
              or ('Nemotron voice helper exited unexpectedly (code %d).'):format(code),
          })
        end
      end)
    end,
  })
  if state.job <= 0 then return false, 'Could not start the Nemotron voice helper.' end
  helper = state
  return true
end

function M.is_listening()
  return active ~= nil
end

function M.cancel()
  if not M.is_listening() then return false end
  if active.process then
    active.process:kill(9)
    finish_active({ kind = 'canceled' })
    return true
  end
  if helper and not helper.ready then
    helper.pending_start = nil
    finish_active({ kind = 'canceled' })
    return true
  end
  if not send({ command = 'cancel' }) then
    finish_active({ kind = 'canceled' })
  end
  return true
end

function M.stop()
  if not M.is_listening() then return false end
  if active.process then
    active.process:kill(9)
    finish_active({ kind = 'canceled' })
    return true
  end
  if helper and not helper.ready then
    helper.pending_start = nil
    finish_active({ kind = 'canceled' })
    return true
  end
  if not send({ command = 'stop' }) then
    finish_active({
      kind = 'error',
      message = 'Could not finalize voice dictation because the voice helper is unavailable.',
    })
  end
  return true
end

local function start_system(timeout_ms, callback)
  local script = table.concat({
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    'Add-Type -AssemblyName System.Speech',
    '$recognizer = [System.Speech.Recognition.SpeechRecognitionEngine]::new()',
    '$grammar = [System.Speech.Recognition.DictationGrammar]::new()',
    'try {',
    '  $recognizer.LoadGrammar($grammar)',
    '  $recognizer.SetInputToDefaultAudioDevice()',
    ("  $result = $recognizer.Recognize([TimeSpan]::FromMilliseconds(%d))"):format(timeout_ms),
    '  if ($null -eq $result -or [string]::IsNullOrWhiteSpace($result.Text)) { exit 3 }',
    '  [Console]::Out.Write($result.Text.Trim())',
    '} finally {',
    '  $recognizer.Dispose()',
    '}',
  }, '\n')
  local state = { callback = callback }
  active = state
  state.process = vim.system({
    'powershell.exe',
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  }, { text = true }, function(result)
    vim.schedule(function()
      if active ~= state then return end
      if result.code == 0 and vim.trim(result.stdout or '') ~= '' then
        finish_active({ kind = 'transcript', text = vim.trim(result.stdout) })
      elseif result.code == 3 then
        finish_active({ kind = 'no_speech' })
      else
        finish_active({
          kind = 'error',
          message = vim.trim(result.stderr or '') ~= '' and vim.trim(result.stderr)
            or 'Windows voice dictation failed.',
        })
      end
    end)
  end)
  return true
end

function M.start(options, callback, status)
  if M.is_listening() then return false end
  if vim.fn.has('win32') ~= 1 then
    callback({ kind = 'unsupported' })
    return false
  end
  if options.provider == 'system' then
    if status then status({ type = 'state', state = 'listening' }) end
    return start_system(options.listen_timeout_ms, callback)
  end
  if options.provider ~= 'nemotron' then
    callback({ kind = 'error', message = 'Unknown voice provider: ' .. tostring(options.provider) })
    return false
  end

  active = { callback = callback, status = status }
  local ok, message = ensure_helper(options)
  if not ok then
    finish_active({ kind = 'error', message = message })
    return false
  end
  local command = {
    command = 'start',
    timeout_ms = options.listen_timeout_ms,
  }
  if helper.ready then
    send(command)
  else
    helper.pending_start = command
    report_active({ type = 'state', state = 'loading' })
  end
  return true
end

function M.warmup(options, observer)
  if options.provider ~= 'nemotron' then return true end
  if vim.fn.has('win32') ~= 1 then
    return false, 'Nemotron voice dictation currently requires Windows.'
  end
  local ok, message = ensure_helper(options)
  if not ok then return false, message end
  helper.observer = observer
  if observer then
    observer({
      type = 'state',
      state = helper.ready and 'ready' or 'loading',
    })
  end
  return true
end

local function run_setup_step(command, callback)
  setup_process = vim.system(command, { text = true }, function(result)
    vim.schedule(function()
      setup_process = nil
      callback(result)
    end)
  end)
end

function M.prepare(options, status, callback)
  if setup_process then
    callback(false, 'Nemotron voice setup is already running.')
    return
  end
  if vim.fn.has('win32') ~= 1 then
    callback(false, 'Nemotron voice setup currently requires Windows.')
    return
  end
  stop_helper()
  local python, venv = venv_python(options)
  vim.fn.mkdir(data_root(), 'p')
  status('Creating the isolated voice environment…')
  run_setup_step({ options.python_command, '-m', 'venv', venv }, function(venv_result)
    if venv_result.code ~= 0 then
      callback(false, vim.trim(venv_result.stderr or 'Could not create the voice environment.'))
      return
    end
    status('Installing the Foundry Local voice runtime…')
    run_setup_step({
      python,
      '-m',
      'pip',
      'install',
      '--disable-pip-version-check',
      ('foundry-local-sdk-winml==%s'):format(options.foundry_version),
      'sounddevice',
    }, function(install_result)
      if install_result.code ~= 0 then
        callback(false, vim.trim(install_result.stderr or 'Could not install voice dependencies.'))
        return
      end
      status('Downloading and preparing the Nemotron speech model (~731 MB)…')
      run_setup_step({
        python,
        helper_path,
        '--prepare',
        '--model',
        options.model,
        '--language',
        options.language,
      }, function(prepare_result)
        if prepare_result.code ~= 0 then
          callback(false, vim.trim(prepare_result.stderr or prepare_result.stdout or 'Model setup failed.'))
          return
        end
        callback(true)
      end)
    end)
  end)
end

function M.shutdown()
  if setup_process then
    setup_process:kill(9)
    setup_process = nil
  end
  stop_helper()
end

return M
