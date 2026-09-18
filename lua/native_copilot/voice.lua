local M = {}

local active

local function finish_once(state, callback, result)
  if state.finished then return end
  state.finished = true
  if active == state then active = nil end
  callback(result)
end

function M.is_listening()
  return active ~= nil and not active.finished
end

function M.cancel()
  if not M.is_listening() then return false end
  local state = active
  state.process:kill(9)
  finish_once(state, state.callback, { kind = 'canceled' })
  return true
end

function M.start(timeout_ms, callback)
  if M.is_listening() then return false end
  if vim.fn.has('win32') ~= 1 then
    callback({ kind = 'unsupported' })
    return false
  end

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
  local state = {
    callback = callback,
    finished = false,
  }
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
      if result.code == 0 then
        local transcript = vim.trim(result.stdout or '')
        if transcript == '' then
          finish_once(state, callback, { kind = 'no_speech' })
        else
          finish_once(state, callback, { kind = 'transcript', text = transcript })
        end
      elseif result.code == 3 then
        finish_once(state, callback, { kind = 'no_speech' })
      else
        local detail = vim.trim(result.stderr or '')
        finish_once(state, callback, {
          kind = 'error',
          message = detail ~= '' and detail or 'Voice dictation failed.',
        })
      end
    end)
  end)
  vim.defer_fn(function()
    if state.finished then return end
    state.process:kill(9)
    finish_once(state, callback, { kind = 'no_speech' })
  end, timeout_ms + 2000)
  return true
end

return M
