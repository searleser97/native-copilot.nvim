local M = {}

local namespace = vim.api.nvim_create_namespace('native_copilot_clipboard')

local function image_name()
  local suffix = tostring(vim.uv.hrtime()):sub(-6)
  return ('copilot-clipboard-%s-%s.png'):format(os.date('%Y%m%d-%H%M%S'), suffix)
end

local function finish_once(state, callback, result)
  if state.finished then return end
  state.finished = true
  callback(result)
end

function M.capture_image(directory, timeout_ms, callback)
  if vim.fn.has('win32') ~= 1 then
    callback({ kind = 'unsupported' })
    return
  end

  directory = vim.fs.normalize(vim.fn.expand(directory))
  if vim.fn.mkdir(directory, 'p') == 0 and vim.fn.isdirectory(directory) ~= 1 then
    callback({ kind = 'error', message = 'Could not create ' .. directory })
    return
  end

  local path = vim.fs.joinpath(directory, image_name())
  local powershell_path = path:gsub("'", "''")
  local script = table.concat({
    "$ErrorActionPreference = 'Stop'",
    ("$outputPath = '%s'"):format(powershell_path),
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    'if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { exit 3 }',
    '$image = [System.Windows.Forms.Clipboard]::GetImage()',
    'try { $image.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png) }',
    'finally { $image.Dispose() }',
  }, '\n')
  local state = { finished = false }
  local process
  process = vim.system({
    'powershell.exe',
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-STA',
    '-Command',
    script,
  }, { text = true }, function(result)
    vim.schedule(function()
      if result.code == 0 then
        finish_once(state, callback, { kind = 'image', path = path })
      elseif result.code == 3 then
        finish_once(state, callback, { kind = 'no_image' })
      else
        local detail = vim.trim(result.stderr or '')
        finish_once(state, callback, {
          kind = 'error',
          message = detail ~= '' and detail or 'Clipboard image capture failed.',
        })
      end
    end)
  end)
  vim.defer_fn(function()
    if state.finished then return end
    process:kill(9)
    finish_once(state, callback, {
      kind = 'error',
      message = 'Clipboard image capture timed out.',
    })
  end, timeout_ms)
end

function M.mark_position(buf, row, column)
  return vim.api.nvim_buf_set_extmark(buf, namespace, row, column, {
    right_gravity = false,
  })
end

function M.insert_at_mark(buf, mark, text)
  if not vim.api.nvim_buf_is_valid(buf) then return false end
  local position = vim.api.nvim_buf_get_extmark_by_id(buf, namespace, mark, {})
  if #position ~= 2 then return false end
  vim.api.nvim_buf_del_extmark(buf, namespace, mark)
  local row, column = position[1], position[2]
  local lines = vim.split(text:gsub('\r\n', '\n'), '\n', { plain = true })
  vim.api.nvim_buf_set_text(buf, row, column, row, column, lines)
  if vim.api.nvim_get_current_buf() == buf then
    local end_row = row + #lines - 1
    local end_column = #lines == 1 and column + #lines[1] or #lines[#lines]
    vim.api.nvim_win_set_cursor(0, { end_row + 1, end_column })
  end
  return true
end

function M.image_reference(path)
  return ('@image("%s")'):format(path)
end

return M
