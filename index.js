/**
 * Host half of `dsh-prompt-trove`.
 *
 * The library is a set of Markdown files, one PER GROUP. Two kinds of group
 * exist:
 *
 * - 全局 — one shared file in `$DSH_HOME/prompts/`, for prompts that belong to
 *   no particular project (identity, tone, output preferences).
 * - project — one file inside `<project>/.dsh-prompts/`. A project is either
 *   the configured `config.root` itself or one of its first-level folders that
 *   contains a `.dsh-prompts/` directory. Nothing else is scanned: a checkout
 *   stays a checkout, and a folder opts in by having a `.dsh-prompts/`.
 *
 * One prompt is one `## ` section inside its group's file.
 *
 * Why a host half exists at all: a browser module has no filesystem, and the
 * group → directory mapping must be resolved HERE. The client sends a group
 * NAME and nothing else about location, so it cannot write outside the
 * configured root even if it tries.
 *
 * Routes (all under {@link PREFIX}):
 *
 *   GET  /index                                → groups (id, label, dir) + all entries
 *   GET  /group?group=                         → one group: raw file text + parsed entries
 *   GET  /section?group=&title=                → one entry's editable fields
 *   POST /create         { group, title, body }               new entry
 *   POST /save-section   { group, title, body, originalTitle } update entry
 *   POST /delete-section { group, title }                      remove entry
 *
 * Every failure is a JSON body with a human-readable Chinese message: this
 * surface is edited by a person, so a stack trace would be noise.
 */
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

/** Route prefix owned by this package. */
const PREFIX = '/dsh-prompt-trove'

/** Directory name each group's library lives under, inside its folder. */
const GROUP_DIR_NAME = '.dsh-prompts'

/** File extension the library uses; anything else in the directory is ignored. */
const FILE_EXTENSION = '.md'

/** Largest accepted request body (a whole file travels in one request). */
const MAX_BODY_BYTES = 512 * 1024

/** Largest single file this package will read or write. */
const MAX_FILE_BYTES = 256 * 1024

/** Longest entry title accepted. */
const MAX_TITLE_LENGTH = 80

/** The one shape a `## ` section header must have to become an entry title. */
const SECTION_MARKER = '## '

/** Identifier of the shared group (prompts belonging to no project). */
const GLOBAL_GROUP = 'global'

/**
 * Plugin configuration. `root` opts into project libraries: a directory whose
 * first-level folders (or the root itself) contain a `.dsh-prompts/` directory.
 * Every such folder becomes one group. Without it the panel offers the shared
 * library only, which is the zero-configuration case.
 *
 * `$DSH_PROMPT_SNIPPETS_ROOT` overrides it for one process, which is how the
 * verification scripts point a throwaway instance at a scratch tree.
 */
export const Config = Schema.object({
  root: Schema.string(),
})

/** One structured editing failure with the HTTP status it deserves. */
class QuickPromptError extends Error {
  /**
   * @param status - response status code.
   * @param message - user-facing Chinese message.
   */
  constructor(status, message) {
    super(message)
    this.name = 'QuickPromptError'
    this.status = status
  }
}

/** Host home used for the shared library when `$DSH_HOME` is unset. */
function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** The shared library's directory (prompts belonging to no project). */
function globalDir() {
  return join(dshHome(), 'prompts')
}

/**
 * The project-library parent directory, or null when this deployment runs
 * global-only. Order: the per-process override (verification, one-off runs),
 * then the row's `config.root`.
 * @param config - the plugin row's configuration.
 * @returns an absolute path, or null when project libraries are off.
 */
function workspaceRoot(config) {
  const fromEnv = process.env.DSH_PROMPT_SNIPPETS_ROOT?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const fromConfig = typeof config?.root === 'string' ? config.root.trim() : ''
  return fromConfig === '' ? null : fromConfig
}

/**
 * Split one text run into its words and its `#tags`, in whatever order they
 * were written. A tag must start a word, so mid-word `#` and a bare `#` stay
 * text; the tag itself may be CJK or alphanumeric.
 * @param text - the run to split.
 * @returns the remaining text and the tags found in it.
 */
function splitTags(text) {
  const tags = []
  const kept = []
  for (const word of text.split(/\s+/)) {
    if (/^#[^\s#]+$/u.test(word)) tags.push(word.slice(1))
    else if (word !== '') kept.push(word)
  }
  return { text: kept.join(' '), tags }
}

/**
 * Split a file into its header and its `## ` sections.
 *
 * A section is `## <title>` optionally followed by a `> ` description line and
 * `#` tags; everything after that up to the next `## ` is the body. Content
 * before the first `## ` is the file header (kept verbatim on write).
 * @param text - the file's full text.
 * @returns header lines and parsed sections.
 */
function parseFile(text) {
  const lines = text.split(/\r?\n/)
  const sections = []
  const header = []
  let current = null

  for (const line of lines) {
    if (line.startsWith(SECTION_MARKER) && line.slice(SECTION_MARKER.length).trim() !== '') {
      if (current !== null) sections.push(current)
      current = { title: line.slice(SECTION_MARKER.length).trim(), description: '', tags: [], body: [] }
      continue
    }
    if (current === null) {
      header.push(line)
      continue
    }
    const bodyText = current.body.join('\n')
    // Description and tags are the section's leading annotation block only:
    // once real content starts, a later '#…' is content (a markdown heading),
    // never a late tag.
    if (line.startsWith('> ') && current.description === '' && bodyText.trim() === '') {
      const split = splitTags(line.slice(2).trim())
      current.description = split.text
      current.tags.push(...split.tags)
      continue
    }
    if (line.startsWith('#') && bodyText.trim() === '') {
      const split = splitTags(line)
      current.tags.push(...split.tags)
      continue
    }
    current.body.push(line)
  }
  if (current !== null) sections.push(current)

  return {
    header,
    sections: sections.map(section => ({
      title: section.title,
      description: section.description,
      tags: section.tags,
      body: section.body.join('\n').trim(),
    })),
  }
}

/**
 * Render one file back to text: header verbatim, then the sections in order.
 * @param header - header lines (may be empty).
 * @param sections - the sections to write.
 * @returns the file's full text.
 */
function renderFile(header, sections) {
  const parts = []
  const headerText = header.join('\n').trim()
  if (headerText !== '') parts.push(headerText)
  for (const section of sections) {
    const block = [SECTION_MARKER + section.title]
    if (section.description !== '') block.push('> ' + section.description)
    if (section.tags.length > 0) block.push(section.tags.map(tag => '#' + tag).join(' '))
    if (section.body.trim() !== '') {
      block.push('')
      block.push(section.body.trim())
    }
    parts.push(block.join('\n'))
  }
  return parts.join('\n\n') + '\n'
}

/**
 * Whether a path is an existing directory (a missing one is false, not an error).
 * @param path - candidate directory.
 * @returns true when it is a directory.
 */
async function isDirectory(path) {
  const info = await stat(path).catch(() => undefined)
  return info !== undefined && info.isDirectory()
}

/**
 * Resolve one group id to its directory.
 *
 * The shared group is always available. Every other id is one plain segment:
 * either the configured root's own basename (the root itself is a project) or
 * a first-level folder under it. Traversal and separators are refused before
 * any path is built.
 * @param config - the plugin row's configuration.
 * @param group - the requested group id.
 * @returns the group's directory and a display label.
 */
async function resolveGroup(config, group) {
  const id = typeof group === 'string' ? group.trim() : ''
  if (id === GLOBAL_GROUP) {
    const dir = globalDir()
    return { id: GLOBAL_GROUP, dir, label: '全局', exists: await isDirectory(dir) }
  }
  if (id === '') throw new QuickPromptError(400, '缺少分组')
  if (id !== basename(id) || id.includes('/') || id.includes('\\') || id.includes('\0')) {
    throw new QuickPromptError(400, '分组名不能包含路径分隔符')
  }
  if (id === '.' || id === '..') throw new QuickPromptError(400, '分组名非法')

  const root = workspaceRoot(config)
  if (root === null) {
    throw new QuickPromptError(400, '没有启用项目库：在 profile 的 cordis.patch.yml 里给这一行加 config.root，或把提示词放进全局库')
  }

  const rootPath = resolve(root)
  const folder = id === basename(rootPath) ? rootPath : resolve(join(rootPath, id))
  const insideRoot = folder === rootPath || folder.startsWith(rootPath.endsWith(sep) ? rootPath : rootPath + sep)
  if (!insideRoot) {
    throw new QuickPromptError(400, '分组不在项目库根目录内')
  }
  const dir = join(folder, GROUP_DIR_NAME)
  return { id, label: id, dir, exists: await isDirectory(dir) }
}

/**
 * The group roster: 全局 first, then every project library under the root, in
 * name order. A project library is the root itself or one of its first-level
 * folders, recognised by a `.dsh-prompts/` directory; a folder without one is
 * simply not offered.
 * @param config - the plugin row's configuration.
 * @returns the groups the client renders.
 */
async function listGroups(config) {
  const global = await resolveGroup(config, GLOBAL_GROUP)
  const groups = [{ id: global.id, label: global.label, dir: global.dir, exists: global.exists }]

  const root = workspaceRoot(config)
  if (root === null || !(await isDirectory(root))) return groups

  const rootPath = resolve(root)
  const rootName = basename(rootPath)
  if (await isDirectory(join(rootPath, GROUP_DIR_NAME))) {
    groups.push({ id: rootName, label: rootName, dir: join(rootPath, GROUP_DIR_NAME), exists: true })
  }

  const names = (await readdir(rootPath).catch(() => []))
    .filter(name => !name.startsWith('.') && name !== 'node_modules' && name !== rootName)
    .sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'))

  for (const name of names) {
    const folder = join(rootPath, name)
    if (!(await isDirectory(join(folder, GROUP_DIR_NAME)))) continue
    groups.push({ id: name, label: name, dir: join(folder, GROUP_DIR_NAME), exists: true })
  }
  return groups
}

/**
 * The single file one group's entries live in.
 *
 * One group = one file (`<group>.md`), which is what makes the edit form a
 * lossless three-field shape: the file layout is an implementation detail, not
 * a second editing surface the user has to keep in sync.
 * @param group - the resolved group.
 * @returns the absolute file path.
 */
function groupFile(group) {
  return join(group.dir, group.id + FILE_EXTENSION)
}

/**
 * Read one file within the size bound.
 * @param path - absolute file path.
 * @returns the file's text.
 */
async function readBounded(path) {
  const info = await stat(path).catch(() => undefined)
  if (info === undefined) throw new QuickPromptError(404, '找不到该文件，可能已被删除，请刷新')
  if (!info.isFile()) throw new QuickPromptError(400, '目标不是普通文件')
  if (info.size > MAX_FILE_BYTES) throw new QuickPromptError(413, `文件超过 ${Math.round(MAX_FILE_BYTES / 1024)}KB 上限`)
  return readFile(path, 'utf8')
}

/**
 * Write one file atomically: a sibling temp file is renamed over the target, so
 * a failure leaves the previous content rather than a truncated file.
 * @param path - absolute file path.
 * @param text - the full next content.
 */
async function writeAtomic(path, text) {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_FILE_BYTES) {
    throw new QuickPromptError(413, `内容 ${bytes} 字节，超过 ${Math.round(MAX_FILE_BYTES / 1024)}KB 上限`)
  }
  await mkdir(dirname(path), { recursive: true })
  const temp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}`)
  await writeFile(temp, text, 'utf8')
  try {
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

/**
 * Read one group's file.
 * @param group - the resolved group.
 * @returns the parsed file (empty shape when the group has no file yet).
 */
async function readGroupFile(group) {
  const path = groupFile(group)
  const info = await stat(path).catch(() => undefined)
  if (info === undefined) return { header: [], sections: [], text: '', path }
  const text = await readBounded(path)
  const { header, sections } = parseFile(text)
  return { header, sections, text, path }
}

/**
 * Build one index row for a section.
 * @param group - the owning group id.
 * @param section - the parsed section.
 * @param index - its position inside the file.
 * @returns the row the client renders.
 */
function entryRow(group, section, index) {
  return {
    id: `${group}#${index}`,
    group,
    title: section.title,
    description: section.description,
    tags: section.tags,
    chars: [...section.body].length,
    lines: section.body === '' ? 0 : section.body.split('\n').length,
  }
}

/**
 * Validate an entry title.
 * @param title - the raw title.
 * @returns the trimmed title.
 */
function requireTitle(title) {
  const value = typeof title === 'string' ? title.trim() : ''
  if (value === '') throw new QuickPromptError(400, '标题不能为空')
  if (value.length > MAX_TITLE_LENGTH) throw new QuickPromptError(400, `标题超过 ${MAX_TITLE_LENGTH} 字`)
  if (value.includes('\n')) throw new QuickPromptError(400, '标题不能换行')
  return value
}

/**
 * Validate one body.
 * @param body - the raw body.
 * @returns the body text.
 */
function requireBody(body) {
  if (typeof body !== 'string') throw new QuickPromptError(400, '缺少正文')
  if (body.trim() === '') throw new QuickPromptError(400, '正文不能为空')
  return body
}

/**
 * Read one request body within a fixed bound.
 * @param req - incoming request.
 * @returns the parsed JSON body (an empty object for an empty body).
 */
async function readJson(req) {
  const chunks = []
  let size = 0
  let tooLarge = false
  // An oversized body is fully consumed before the refusal: throwing out of
  // the stream mid-flight resets the connection, and the caller would see a
  // network error instead of the 413 this route means to send.
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      tooLarge = true
      chunks.length = 0
      continue
    }
    chunks.push(chunk)
  }
  if (tooLarge) throw new QuickPromptError(413, `请求体超过 ${Math.round(MAX_BODY_BYTES / 1024)}KB 上限`)
  if (size === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new QuickPromptError(400, '请求体必须是 JSON 对象')
    }
    return parsed
  } catch (error) {
    if (error instanceof QuickPromptError) throw error
    throw new QuickPromptError(400, '请求体不是合法 JSON')
  }
}

/**
 * Send one JSON response.
 * @param res - the response.
 * @param status - status code.
 * @param body - JSON-serializable body.
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

/**
 * Consume and discard whatever is left of a request body, so an early refusal
 * does not reset the connection under the client's feet.
 * @param req - incoming request.
 */
async function drain(req) {
  if (req.readableEnded === true || req.destroyed === true) return
  await new Promise((resolveDrain) => {
    const finish = () => {
      req.off('end', finish)
      req.off('close', finish)
      req.off('error', finish)
      resolveDrain()
    }
    req.on('end', finish)
    req.on('close', finish)
    req.on('error', finish)
    req.resume()
  })
}

/**
 * Wrap one handler so every thrown error becomes a readable JSON answer.
 * @param handler - the handler body.
 * @returns a node request handler.
 */
function route(handler) {
  return (req, res) => {
    void (async () => {
      try {
        sendJson(res, 200, { ok: true, value: await handler(req) })
      } catch (error) {
        const status = error instanceof QuickPromptError ? error.status : 500
        const message = error instanceof Error ? error.message : String(error)
        if (status === 500) console.error('[dsh-prompt-trove]', error)
        await drain(req)
        if (!res.headersSent) sendJson(res, status, { ok: false, error: message })
      }
    })()
  }
}

/**
 * Reject a request whose declared content type is not JSON.
 * @param req - incoming request.
 */
function requireJsonBody(req) {
  const type = req.headers['content-type'] ?? ''
  if (!type.includes('application/json')) throw new QuickPromptError(400, '请求必须使用 application/json')
}

/**
 * The group roster plus every entry, in one round trip.
 *
 * The client needs both to render the dropdown and the list. The shared group
 * is always offered first, so a prompt belonging to no project has an obvious
 * home; with `config.root` unset the rest of the roster is empty.
 * @param config - the plugin row's configuration.
 * @returns the handler.
 */
function indexHandler(config) {
  return route(async () => {
    const root = workspaceRoot(config)
    const rootExists = root !== null && await isDirectory(root)
    const groups = await listGroups(config)

    const entries = []
    for (const group of groups) {
      const file = await readGroupFile(group)
      file.sections.forEach((section, index) => {
        entries.push(entryRow(group.id, section, index))
      })
    }

    return { root, rootExists, globalDir: globalDir(), groups, entries }
  })
}

/**
 * Build the route table for one host context.
 *
 * `apply` is a thin wrapper over this so the verification script can mount the
 * same table on a throwaway HTTP server and drive it with real requests.
 * @param ctx - host context (unused; kept so both callers share one signature).
 * @returns the route table.
 */
export function buildRoutes(ctx, config = {}) {
  void ctx

  /** Read the group's file, refusing when the group has none yet. */
  const requireGroupFile = async (group) => {
    const file = await readGroupFile(group)
    if (file.sections.length === 0) {
      throw new QuickPromptError(404, '这个分组还没有提示词文件，新建一条就会创建')
    }
    return file
  }

  return {
    [PREFIX + '/index']: { method: 'GET', handle: indexHandler(config) },

    [PREFIX + '/group']: {
      method: 'GET',
      handle: route(async (req) => {
        const url = new URL(req.url, 'http://localhost')
        const group = await resolveGroup(config, url.searchParams.get('group') ?? '')
        const file = await readGroupFile(group)
        return {
          group: group.id,
          label: group.label,
          dir: group.dir,
          exists: group.exists,
          file: basename(groupFile(group)),
          text: file.text,
          entries: file.sections.map((section, index) => entryRow(group.id, section, index)),
        }
      }),
    },

    [PREFIX + '/section']: {
      method: 'GET',
      handle: route(async (req) => {
        const url = new URL(req.url, 'http://localhost')
        const group = await resolveGroup(config, url.searchParams.get('group') ?? '')
        const title = requireTitle(url.searchParams.get('title') ?? '')
        const file = await readGroupFile(group)
        const section = file.sections.find(item => item.title === title)
        if (section === undefined) throw new QuickPromptError(404, '找不到这个提示词，可能已被删除，请刷新')
        return { group: group.id, ...section }
      }),
    },

    [PREFIX + '/create']: {
      method: 'POST',
      handle: route(async (req) => {
        requireJsonBody(req)
        const body = await readJson(req)
        const group = await resolveGroup(config, body.group)
        const title = requireTitle(body.title)
        const text = requireBody(body.body)

        const file = await readGroupFile(group)
        if (file.sections.some(section => section.title === title)) {
          throw new QuickPromptError(409, `「${title}」已经存在，换个标题或直接编辑那一条`)
        }

        const header = file.header.length > 0
          ? file.header
          : [`# ${group.label}`, '', '<!-- 一条 = 一个 `## ` 段落；正文会原样进入输入框。 -->']
        const sections = [...file.sections, { title, description: '', tags: [], body: text }]
        await writeAtomic(groupFile(group), renderFile(header, sections))
        return { group: group.id, title, file: groupFile(group) }
      }),
    },

    [PREFIX + '/save-section']: {
      method: 'POST',
      handle: route(async (req) => {
        requireJsonBody(req)
        const body = await readJson(req)
        const group = await resolveGroup(config, body.group)
        const title = requireTitle(body.title)
        const text = requireBody(body.body)
        const file = await requireGroupFile(group)

        // The form carries only title and body, so whatever the file holds that
        // the form cannot express (a description line, tags) is carried over
        // untouched: the form narrows the shape, it never silently drops data.
        const original = requireTitle(body.originalTitle ?? body.title)
        const sections = file.sections.slice()
        const index = sections.findIndex(section => section.title === original)
        if (index < 0) throw new QuickPromptError(404, '找不到这个提示词，可能已被删除，请刷新')
        if (title !== original && sections.some(section => section.title === title)) {
          throw new QuickPromptError(409, `「${title}」已经存在`)
        }
        sections[index] = { ...sections[index], title, body: text }

        const header = file.header.length > 0 ? file.header : [`# ${group.label}`]
        await writeAtomic(groupFile(group), renderFile(header, sections))
        return { group: group.id, title, file: groupFile(group) }
      }),
    },

    [PREFIX + '/delete-section']: {
      method: 'POST',
      handle: route(async (req) => {
        requireJsonBody(req)
        const body = await readJson(req)
        const group = await resolveGroup(config, body.group)
        const title = requireTitle(body.title)
        const file = await requireGroupFile(group)

        const sections = file.sections.slice()
        const index = sections.findIndex(section => section.title === title)
        if (index < 0) throw new QuickPromptError(404, '找不到这个提示词，可能已被删除，请刷新')
        sections.splice(index, 1)

        // The last entry takes the file with it: an emptied library file would
        // be an invisible row in the list forever.
        if (sections.length === 0) {
          await unlink(groupFile(group))
          return { group: group.id, removed: 'file' }
        }
        const header = file.header.length > 0 ? file.header : [`# ${group.label}`]
        await writeAtomic(groupFile(group), renderFile(header, sections))
        return { group: group.id, removed: 'section' }
      }),
    },
  }
}

/**
 * Mount the host half: the route table above, all owned by this fiber.
 * @param ctx - host context.
 */
export function apply(ctx, config = {}) {
  ctx.inject(['webServer'], (ready) => {
    const server = ready.webServer
    const handlers = buildRoutes(ready, config)

    const disposers = []
    for (const [path, entry] of Object.entries(handlers)) {
      disposers.push(server.register({
        kind: 'exact',
        path,
        handler: (req, res) => {
          if (req.method !== entry.method) {
            sendJson(res, 405, { ok: false, error: `${path} 只接受 ${entry.method}` })
            return
          }
          entry.handle(req, res)
        },
      }))
    }

    ready.effect(
      () => () => { for (const dispose of disposers) dispose() },
      'prompt-trove: routes',
    )
  })
}

/** Internals exposed for the verification scripts (never used by the plugin). */
export const internals = {
  PREFIX,
  GROUP_DIR_NAME,
  GLOBAL_GROUP,
  Config,
  parseFile,
  renderFile,
  resolveGroup,
  listGroups,
  groupFile,
  workspaceRoot,
  globalDir,
}
