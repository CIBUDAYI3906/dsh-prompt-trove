/**
 * Host-half route verification over a REAL HTTP transport.
 *
 * The routes are mounted on a throwaway server and driven with real requests,
 * against a throwaway workspace root — so what is checked is the wire behavior
 * (status codes, JSON envelopes, URL parsing, body limits) plus the things this
 * half exists to guarantee:
 *
 *   1. the group roster is the FIRST-LEVEL folders under the configured root
 *      (plus 全局), and each entry is filed into its own group's library;
 *   2. no request can name a path: every group id is re-verified as one plain
 *      segment inside the root, so traversal and absolute paths are refused;
 *   3. the three-field form round-trips without dropping what it cannot show
 *      (a hand-written description line survives an edit through the form);
 *   4. oversized bodies, wrong methods and malformed JSON answer with their own
 *      status and a readable message.
 *
 * Usage: node verify/host-routes.mjs
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRoutes, internals } from '../index.js'

/** Every failure found; the script exits non-zero when this is non-empty. */
const failures = []
/** Progress notes. */
const notes = []

/**
 * Record one assertion.
 * @param condition - the condition.
 * @param message - text describing what was asserted.
 */
function check(condition, message) {
  if (condition) notes.push('ok: ' + message)
  else failures.push(message)
}

const root = await mkdtemp(join(tmpdir(), 'dsh-prompt-trove-routes-'))
const workspaceRoot = join(root, 'work')
// A project opts in with a `.dsh-prompts/` directory; a plain folder is not a group.
await mkdir(join(workspaceRoot, 'ths', internals.GROUP_DIR_NAME), { recursive: true })
await mkdir(join(workspaceRoot, 'mkt', internals.GROUP_DIR_NAME), { recursive: true })
// A folder that never opted in (no `.dsh-prompts/`) must NOT be offered.
await mkdir(join(workspaceRoot, 'plain-project'), { recursive: true })
await mkdir(join(workspaceRoot, '.hidden', internals.GROUP_DIR_NAME), { recursive: true })
// A nested project library must NOT become a group: first level only.
await mkdir(join(workspaceRoot, 'ths', 'Reports', internals.GROUP_DIR_NAME), { recursive: true })

/** Redirect both roots at the scratch tree for the duration of the run. */
const previousHome = process.env.DSH_HOME
const previousRoot = process.env.DSH_PROMPT_SNIPPETS_ROOT
process.env.DSH_HOME = join(root, 'home')
process.env.DSH_PROMPT_SNIPPETS_ROOT = workspaceRoot

const routes = buildRoutes({}, {})
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  const entry = routes[path]
  if (entry === undefined) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'no route' }))
    return
  }
  if (req.method !== entry.method) {
    res.writeHead(405, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'method' }))
    return
  }
  entry.handle(req, res)
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}${internals.PREFIX}`

/**
 * One request against the mounted routes.
 * @param path - route path (query included).
 * @param init - fetch options.
 * @returns the status and parsed body.
 */
async function call(path, init) {
  const response = await fetch(base + path, init)
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = { raw: text }
  }
  return { status: response.status, body }
}

/**
 * JSON POST helper.
 * @param path - route path.
 * @param payload - JSON body.
 * @returns the status and parsed body.
 */
function post(path, payload) {
  return call(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

try {
  // --- 1. groups are first-level folders ----------------------------------

  const empty = await call('/index')
  check(empty.status === 200 && empty.body.ok === true, '/index answers 200 with ok=true')
  const groupIds = empty.body.value.groups.map(group => group.id)
  check(groupIds.includes('global'), 'the shared group is always offered')
  check(groupIds.includes('ths') && groupIds.includes('mkt'), 'folders with .dsh-prompts/ become groups')
  check(!groupIds.includes('plain-project'), 'a folder without .dsh-prompts/ is not a group')
  check(!groupIds.includes('Reports'), 'a nested folder is NOT a group (first level only)')
  check(!groupIds.includes('.hidden'), 'a hidden folder is skipped')
  check(empty.body.value.entries.length === 0, 'an empty library lists no entries')
  check(empty.body.value.root === workspaceRoot, 'the index reports the configured root')

  // --- 2. entries file into the chosen group's own library -----------------

  const created = await post('/create', {
    group: 'ths',
    title: '投顾业务背景',
    body: '第一段正文。\n\n第二段正文。',
  })
  check(created.status === 200 && created.body.ok === true, '/create answers 200')
  const thsFile = join(workspaceRoot, 'ths', internals.GROUP_DIR_NAME, 'ths.md')
  const onDisk = await readFile(thsFile, 'utf8')
  check(onDisk.includes('## 投顾业务背景'), 'the entry landed in its own group folder\'s library')
  check(onDisk.includes('第一段正文。\n\n第二段正文。'), 'the body is written verbatim')
  check(onDisk.startsWith('# ths'), 'a new file gets a group heading')

  const second = await post('/create', { group: 'ths', title: '第二条', body: '另一段正文。' })
  check(second.status === 200, 'a second entry appends to the same group file')
  const afterSecond = await readFile(thsFile, 'utf8')
  check((afterSecond.match(/^## /gm) ?? []).length === 2, 'both entries live in one file')

  const duplicate = await post('/create', { group: 'ths', title: '第二条', body: 'x' })
  check(duplicate.status === 409, 'a duplicate title inside one group is refused')

  const other = await post('/create', { group: 'global', title: '全局背景', body: '全局正文。' })
  check(other.status === 200, 'the shared group accepts entries too')
  const globalFile = await readFile(join(internals.globalDir(), 'global.md'), 'utf8')
  check(globalFile.includes('## 全局背景'), 'the shared entry landed in the home library')

  const listed = await call('/index')
  check(listed.body.value.entries.length === 3, '/index lists every group\'s entries')
  const entry = listed.body.value.entries.find(item => item.title === '投顾业务背景')
  check(entry !== undefined && entry.group === 'ths', 'the entry reports its group')
  check(entry.chars === [...'第一段正文。\n\n第二段正文。'].length, 'the index reports the body length')

  // --- 3. the three-field form round-trips ---------------------------------

  const section = await call(`/section?group=ths&title=${encodeURIComponent('投顾业务背景')}`)
  check(section.status === 200, '/section answers 200')
  check(section.body.value.body === '第一段正文。\n\n第二段正文。', '/section returns the exact body')

  // A hand-written description must survive an edit that cannot show it.
  await writeFile(thsFile, [
    '# ths', '',
    '## 投顾业务背景', '> 手写的说明文字 #标签', '',
    '第一段正文。', '',
    '## 第二条', '', '另一段正文。', '',
  ].join('\n'), 'utf8')

  const edited = await post('/save-section', {
    group: 'ths',
    title: '投顾业务背景（改）',
    originalTitle: '投顾业务背景',
    body: '改过的正文。',
  })
  check(edited.status === 200, '/save-section answers 200')
  const afterEdit = await readFile(thsFile, 'utf8')
  check(afterEdit.includes('## 投顾业务背景（改）'), 'the title was updated')
  check(afterEdit.includes('改过的正文。'), 'the body was updated')
  // The renderer writes tags on their own line (its canonical layout), so the
  // assertion is on the TEXT surviving, not on the original line shape.
  check(afterEdit.includes('> 手写的说明文字'), 'the description line the form cannot show survived')
  check(afterEdit.includes('#标签'), 'the tag the form cannot show survived')
  check(afterEdit.includes('## 第二条'), 'the sibling entry is untouched')

  const renameClash = await post('/save-section', {
    group: 'ths', title: '第二条', originalTitle: '投顾业务背景（改）', body: 'x',
  })
  check(renameClash.status === 409, 'renaming onto an existing title is refused')

  const missingEdit = await post('/save-section', {
    group: 'ths', title: '不存在', originalTitle: '不存在', body: 'x',
  })
  check(missingEdit.status === 404, 'editing a missing entry answers 404')

  // --- 4. no request can name a path ---------------------------------------

  for (const bad of ['../etc', '..%2Fetc', '/etc', 'a/b', '..', 'ths/Reports']) {
    const answer = await call(`/section?group=${encodeURIComponent(bad)}&title=x`)
    // 400 is the guard's own refusal; 404 is a well-formed id with no file.
    // What matters is that no answer is 200 — a path must never resolve.
    check(answer.status === 400 || answer.status === 404,
      `a group id "${bad}" never resolves (status ${answer.status})`)
  }

  const noGroup = await post('/create', { group: '', title: 'x', body: 'y' })
  check(noGroup.status === 400, 'an empty group is refused')

  const noBody = await post('/create', { group: 'ths', title: 'x', body: '   ' })
  check(noBody.status === 400, 'an empty body is refused')

  const longTitle = await post('/create', { group: 'ths', title: '长'.repeat(81), body: 'y' })
  check(longTitle.status === 400, 'an over-long title is refused')

  const wrongMethod = await call('/index', { method: 'POST' })
  check(wrongMethod.status === 405, 'a wrong method answers 405')

  const badJson = await call('/create', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
  })
  check(badJson.status === 400, 'a malformed JSON body answers 400')

  const huge = await call('/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ group: 'ths', title: 'x', body: 'x'.repeat(600 * 1024) }),
  })
  check(huge.status === 413, `an oversized body answers 413 (got ${huge.status})`)

  // --- 5. delete -----------------------------------------------------------

  const removedSection = await post('/delete-section', { group: 'ths', title: '第二条' })
  check(removedSection.status === 200 && removedSection.body.value.removed === 'section',
    'one entry is removed and the file survives')
  const afterDelete = await readFile(thsFile, 'utf8')
  check(!afterDelete.includes('另一段正文。'), 'the deleted section is gone from disk')
  check(afterDelete.includes('改过的正文。'), 'its sibling entry is untouched')

  const removedFile = await post('/delete-section', { group: 'ths', title: '投顾业务背景（改）' })
  check(removedFile.body.value.removed === 'file', 'the last entry takes the file with it')

  const missing = await post('/delete-section', { group: 'ths', title: '不存在' })
  check(missing.status === 404, 'deleting a missing entry answers 404')

  const emptyGroup = await call('/group?group=ths')
  check(emptyGroup.status === 200 && emptyGroup.body.value.text === '',
    '/group reports an empty group without failing')

  // --- 6. global-only mode ------------------------------------------------
  // Without a root the roster is the shared library alone: a fresh install
  // must not advertise project groups it cannot resolve.
  {
    const routes = buildRoutes({}, {})
    const bare = createServer((req, res) => {
      const path = new URL(req.url, 'http://localhost').pathname
      const entry = routes[path]
      if (entry === undefined) { res.writeHead(404); res.end('{}'); return }
      entry.handle(req, res)
    })
    await new Promise(resolve => bare.listen(0, '127.0.0.1', resolve))
    const bareBase = 'http://127.0.0.1:' + bare.address().port + internals.PREFIX
    delete process.env.DSH_PROMPT_SNIPPETS_ROOT
    const answer = await fetch(bareBase + '/index')
    const body = await answer.json()
    check(body.value.groups.length === 1 && body.value.groups[0].id === 'global',
      'without config.root the roster is the shared library only')
    check(body.value.root === null, 'without config.root the index reports no project root')
    bare.close()
  }

} finally {
  server.close()
  process.env.DSH_HOME = previousHome
  if (previousRoot === undefined) delete process.env.DSH_PROMPT_SNIPPETS_ROOT
  else process.env.DSH_PROMPT_SNIPPETS_ROOT = previousRoot
  await rm(root, { recursive: true, force: true })
}

// --- report -----------------------------------------------------------------

for (const note of notes) console.log(note)
if (failures.length === 0) {
  console.log('\nhost-routes: OK (' + notes.length + ' checks passed)')
  process.exit(0)
}
console.error('\nhost-routes: ' + failures.length + ' failure(s)')
for (const failure of failures) console.error('  ✗ ' + failure)
process.exit(1)
