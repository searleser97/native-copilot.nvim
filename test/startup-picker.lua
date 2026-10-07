vim.opt.runtimepath:prepend(vim.fn.getcwd())
local sent = {}
local running = false
package.loaded['native_copilot.protocol'] = {
  is_running = function() return running end,
  start = function() running = true return true end,
  send = function(kind, payload)
    local id = 'request-' .. (#sent + 1)
    table.insert(sent, { id = id, type = kind, payload = payload })
    return id
  end,
  stop_sync = function() running = false end,
}
local native = require('native_copilot')
native.setup({ voice = { preload = false } })
local choices = {}
vim.ui.select = function(items, opts, callback)
  table.insert(choices, { items = items, opts = opts, choose = callback })
end
vim.notify = function() end
local function last_request()
  return sent[#sent].id
end
local function list(id, sessions)
  native._on_event({ type = 'sessions.list', requestId = id, payload = { sessions = sessions } })
end
local function created()
  return vim.tbl_count(vim.tbl_filter(function(request)
    return request.type == 'mode.primary'
  end, sent))
end
local sessions = {
  { sessionId = 'recent', summary = 'Latest session', modifiedAgoSeconds = 60 },
  { sessionId = 'locked', summary = 'Older session', modifiedAgoSeconds = 7200, inUse = true },
}

native.open({ reuse_current_tab = true })
assert(sent[1].type == 'hello' and sent[2].type == 'sessions.list')
local stale = last_request()
native.open()
assert(#sent == 2, 'repeated open must not duplicate startup')
native.close()
native.open()
local current = last_request()
list(stale, sessions)
assert(#choices == 0, 'late list must not take over reopened UI')
list(current, sessions)
assert(#choices == 1 and created() == 0)
local selected = choices[1]
assert(selected.opts.prompt == 'Resume Copilot session')
assert(selected.items[1].display == '[New Session]')
assert(selected.opts.format_item(selected.items[2]) == 'Latest session — 1 minute ago')
assert(selected.items[3].display == '[active elsewhere] Older session — 2 hours ago')
selected.choose(nil)
assert(created() == 0, 'cancel must create no session')
selected.choose(selected.items[1])
assert(created() == 0, 'late selection after cancel must be ignored')

native.open()
list(last_request(), {})
assert(#choices[2].items == 1, 'empty workspace still offers new session')
choices[2].choose(choices[2].items[1])
assert(created() == 1, 'new selection creates exactly one primary')
choices[2].choose(choices[2].items[1])
native.open()
assert(created() == 1 and #choices == 2, 'selection and open are idempotent during startup')
native.close()

native.open()
list(last_request(), sessions)
choices[3].choose(choices[3].items[3])
assert(created() == 1 and sent[#sent].type == 'sessions.list', 'locked session is not resumed')
native.open()
list(last_request(), sessions)
choices[4].choose(choices[4].items[2])
assert(sent[#sent].type == 'session.resume' and sent[#sent].payload.sessionId == 'recent')
assert(created() == 1, 'existing selection must not create a primary first')
native._on_event({
  type = 'request.error',
  requestId = last_request(),
  payload = { message = 'Resume failed' },
})
native.open()
local retry = last_request()
assert(sent[#sent].type == 'sessions.list', 'failed resume can retry startup')
native.close()
list(retry, sessions)
assert(#choices == 4, 'late response after close must not open picker')

native.open()
list(last_request(), sessions)
choices[5].choose(choices[5].items[1])
native._on_event({
  type = 'primary.ready',
  payload = { target = 'agent:test', agentId = 'test', sessionId = 'new' },
})
local count = #sent
native.open()
assert(#sent == count, 'opening active UI must not start or list again')
native.close()
native.open()
assert(#sent == count, 'reopening active session must not create another')
list('normal-resume', sessions)
assert(#choices[6].items == 2 and choices[6].items[1].session.sessionId == 'recent',
  '/resume must retain its original entries')
native.close()
native._on_event({
  type = 'agent.error',
  payload = { primary = true, target = 'agent:test', message = 'Startup failed' },
})
native.open()
list(last_request(), {})
assert(#choices == 7, 'failed primary must not prevent retrying startup')
choices[7].choose(choices[7].items[1])
native._on_event({
  type = 'request.error',
  requestId = last_request(),
  payload = { message = 'Primary initialization failed before lifecycle events' },
})
native.open()
assert(sent[#sent].type == 'sessions.list', 'early primary failure must allow another open')
local tabclosed_request = last_request()
vim.cmd('tabclose')
native.open()
local reopened_request = last_request()
assert(reopened_request ~= tabclosed_request, 'external tab close must clear pending startup')
list(tabclosed_request, sessions)
assert(#choices == 7, 'external tab close must invalidate the old response')
list(reopened_request, {})
assert(#choices == 8)
choices[8].choose(nil)
print('PASS startup selection, cancellation, races, native rows, active reopen, and unchanged /resume')
vim.cmd('qa!')
