/**
 * Source of `dsh-prompt-trove`'s client bundle.
 *
 * Not loaded directly: `build.mjs` transpiles this file (JSX → `jsx` calls,
 * ESM → the loader's `require`) and wraps the result in the
 * `window.__ModuleLoader__.load({ id, factory })` shell the browser module
 * registry serves.
 *
 * The UI is deliberately three fields — 分组 / 标题 / 正文 — and NOTHING else:
 *
 * - **新增 and 编辑 are the same form.** Editing pre-fills the same three
 *   controls, so there is one shape to learn and no second "raw file" surface
 *   to keep in sync with it.
 * - **分组 is a dropdown** over the groups the host discovered: 全局 (the shared
 *   library under $DSH_HOME/prompts) plus every project that opted in with a
 *   `.dsh-prompts/` directory under the configured `config.root`. An entry is
 *   filed into its own group's library, so background travels with the project
 *   it describes.
 * - Whatever the files hold that the form cannot express (a description line)
 *   is preserved on edit rather than silently dropped — see the host half.
 *
 * Two ways in: the composer tool-row button, and the `@` trigger (type `@` and
 * pick). The button appends to the draft; the `@` path replaces its own token,
 * which is what the trigger pipeline defines for a reference.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
/*
 * The live primitives (0.2.1-rc.2) export each icon twice — `…Medium` for
 * button rows and `…Regular` for inline text — and no bare-name or `…16`
 * spelling at all. An undefined component throws while rendering, and DSH
 * removes a slot entry that crashes, which is exactly the "button never
 * appears" symptom this bundle hit after the upgrade. Bind the two live names
 * explicitly instead of guessing at legacy aliases.
 */
import {
  Button, IconCopyOutlineMedium, IconEditOutlineMedium, IconPlusOutlineMedium,
  IconRefreshOutlineMedium, IconSearchOutlineMedium, IconSkillOutlineMedium,
  IconTrashOutlineMedium, Input, Modal, Toast, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'

const IconCopy = IconCopyOutlineMedium
const IconEdit = IconEditOutlineMedium
const IconPlus = IconPlusOutlineMedium
const IconRefresh = IconRefreshOutlineMedium
const IconSearch = IconSearchOutlineMedium
const IconSkill = IconSkillOutlineMedium
const IconTrash = IconTrashOutlineMedium
import css from './PromptTrove.module.css'

/** Bundle id; must equal the package name the profile row composes. */
export const PLUGIN_ID = 'dsh-prompt-trove'

/** Host route prefix owned by this package's host half. */
const PREFIX = '/dsh-prompt-trove'

/** Group name registered with the `@` trigger pipeline. */
const TRIGGER_NAME = 'prompt'

/** Copy the panel uses. This package registers no locale namespace. */
const TEXT = {
  button: '常用提示词',
  title: '常用提示词',
  subtitle: '点条目即追加到输入框，不会覆盖你已经写的内容',
  searchPlaceholder: '搜索标题或描述…',
  allGroups: '全部分组',
  edit: '编辑',
  remove: '删除',
  create: '新建一条',
  refresh: '重新读取磁盘',
  close: '关闭',
  loading: '正在读取…',
  empty: '这里还没有提示词',
  noMatch: '没有匹配的条目',
  chars: '字',
  save: '保存',
  saving: '保存中…',
  cancel: '取消',
  formHint: '三个字段：分组、标题、正文。正文会原样进入输入框。',
  groupLabel: '分组',
  titleLabel: '标题',
  titlePlaceholder: '例如 工作背景与职责',
  bodyLabel: '正文',
  bodyPlaceholder: '这段背景的完整内容，插入时原样进入输入框',
  confirm: '保存',
  confirmDelete: '确认删除',
  cancelDelete: '算了',
  deleteAsk: '删除这一条？这个动作会直接改磁盘上的文件。',
  deleteLastFile: '这是分组里最后一条，文件本身也会被删除。',
  libraryPath: '项目库位置',
  globalPath: '全局库位置',
  inserted: '已追加到输入框',
  copied: '已复制',
  copyFailed: '复制失败，请手动选中',
  saved: '已保存',
  created: '已新建',
  deleted: '已删除',
  failedLoad: '读取失败',
  needTitle: '标题不能为空',
  needBody: '正文不能为空',
}

/**
 * One HTTP call against the host half.
 * @param path - route path below {@link PREFIX}.
 * @param init - fetch options.
 * @returns the unwrapped `value` of the response envelope.
 */
async function callHost(path, init) {
  const response = await fetch(PREFIX + path, {
    ...init,
    headers: { 'content-type': 'application/json' },
  })
  let body
  try {
    body = await response.json()
  } catch {
    throw new Error(`服务端返回了非 JSON 响应（HTTP ${response.status}）`)
  }
  if (!response.ok || body?.ok !== true) {
    throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`)
  }
  return body.value
}

/** Load the group roster plus every entry. */
async function loadIndex() {
  return callHost('/index', { method: 'GET' })
}

/**
 * Load one entry's editable fields.
 * @param group - the owning group id.
 * @param title - the entry title.
 * @returns the section's title, body, and preserved description/tags.
 */
async function loadSection(group, title) {
  return callHost(
    `/section?group=${encodeURIComponent(group)}&title=${encodeURIComponent(title)}`,
    { method: 'GET' },
  )
}

/**
 * Append one prompt body to the current draft.
 *
 * Appending, never replacing: the user is adding background to a request they
 * may already have started. Blocks are separated by one blank line so a
 * multi-prompt draft still reads as distinct paragraphs.
 * @param draft - the current draft text.
 * @param text - the prompt body to append.
 * @returns the next draft text.
 */
function mergeDraft(draft, text) {
  const addition = text.trim()
  const existing = draft.replace(/\s+$/u, '')
  if (existing === '') return addition
  if (addition === '') return draft
  return existing + '\n\n' + addition
}

/** Stable identity of one entry: group + title. */
function entryKey(entry) {
  return `${entry.group}|${entry.title}`
}

/**
 * Group entries by their group id, in the roster's order.
 * @param entries - the entries to group.
 * @param groups - the group roster (order source).
 * @returns groups of `{ group, entries }`.
 */
function groupEntries(entries, groups) {
  const byGroup = new Map()
  for (const entry of entries) {
    const bucket = byGroup.get(entry.group)
    if (bucket === undefined) byGroup.set(entry.group, [entry])
    else bucket.push(entry)
  }
  const ordered = []
  for (const group of groups) {
    const bucket = byGroup.get(group.id)
    if (bucket !== undefined && bucket.length > 0) ordered.push({ group, entries: bucket })
    byGroup.delete(group.id)
  }
  // An entry whose group vanished from the roster (folder renamed mid-session)
  // still shows instead of disappearing silently.
  for (const [id, bucket] of byGroup) {
    ordered.push({ group: { id, label: id, dir: '' }, entries: bucket })
  }
  return ordered
}

/**
 * Filter entries by a free-text query over title and description.
 * @param entries - candidate entries.
 * @param query - the raw query.
 * @returns the matching entries.
 */
function filterEntries(entries, query) {
  const needle = query.trim().toLowerCase()
  if (needle === '') return entries
  return entries.filter((entry) => {
    const haystack = [entry.title, entry.description, ...entry.tags].join(' ').toLowerCase()
    return haystack.includes(needle)
  })
}

/** One row action button. */
function RowAction({ label, icon, onClick, danger }) {
  return (
    <Tooltip label={label} side="top">
      <button
        type="button"
        className={danger === true ? css.rowAction + ' ' + css.rowActionDanger : css.rowAction}
        aria-label={label}
        onMouseDown={(event) => { event.preventDefault() }}
        onClick={(event) => { event.stopPropagation(); onClick() }}
      >
        {icon}
      </button>
    </Tooltip>
  )
}

/**
 * The one form: used for creating AND for editing.
 *
 * Editing loads the entry's current fields and pre-fills exactly the same three
 * controls, so the two flows cannot drift apart.
 *
 * @param props.mode - `'create'` or `'edit'`.
 * @param props.groups - the group roster for the dropdown.
 * @param props.entry - the entry being edited (edit mode only).
 * @param props.busy - a request is in flight.
 * @param props.error - last failure message from the caller.
 * @param props.onSubmit - receives `{ group, title, body, originalTitle? }`.
 * @param props.onClose - return to the list.
 */
function EntryForm({ mode, groups, entry, busy, error, onSubmit, onClose }) {
  const [group, setGroup] = useState(entry?.group ?? (groups[0]?.id ?? ''))
  const [title, setTitle] = useState(entry?.title ?? '')
  const [body, setBody] = useState('')
  const [loading, setLoading] = useState(mode === 'edit')
  const [loadError, setLoadError] = useState('')
  const [localError, setLocalError] = useState('')
  const entryGroup = entry?.group
  const entryTitle = entry?.title

  useEffect(() => {
    if (mode !== 'edit' || entryGroup === undefined || entryTitle === undefined) return undefined
    let live = true
    setLoading(true)
    void loadSection(entryGroup, entryTitle).then(
      (section) => {
        if (!live) return
        setBody(section.body)
        setLoading(false)
      },
      (failure) => {
        if (!live) return
        setLoadError(failure instanceof Error ? failure.message : String(failure))
        setLoading(false)
      },
    )
    return () => { live = false }
  }, [mode, entryGroup, entryTitle])

  const ready = group !== '' && title.trim() !== '' && body.trim() !== ''

  const submit = () => {
    if (title.trim() === '') { setLocalError(TEXT.needTitle); return }
    if (body.trim() === '') { setLocalError(TEXT.needBody); return }
    setLocalError('')
    void onSubmit({
      group,
      title: title.trim(),
      body,
      ...(mode === 'edit' && entry !== undefined ? { originalTitle: entry.title } : {}),
    })
  }

  if (loadError !== '') {
    return (
      <div className={css.editor}>
        <div className={css.stateError}>{loadError}</div>
        <div className={css.editorActions}>
          <span className={css.editorFile} />
          <Button size="sm" onClick={onClose}>{TEXT.cancel}</Button>
        </div>
      </div>
    )
  }

  // The edited entry's own group always appears, even when the roster no longer
  // lists it (its folder was renamed): an edit must not silently move a prompt.
  const options = mode === 'edit' && entry !== undefined
    && !groups.some(option => option.id === entry.group)
    ? [...groups, { id: entry.group, label: entry.group, dir: '' }]
    : groups

  return (
    <div className={css.editor}>
      <div className={css.editorHint}>{TEXT.formHint}</div>

      <label className={css.field}>
        <span className={css.fieldLabel}>{TEXT.groupLabel}</span>
        <select
          className={css.select}
          value={group}
          onChange={(event) => { setGroup(event.target.value) }}
          aria-label={TEXT.groupLabel}
        >
          {options.map(option => (
            <option key={option.id} value={option.id}>
              {option.id === 'global' ? '全局（不属于任何项目）' : option.label}
            </option>
          ))}
        </select>
      </label>

      <label className={css.field}>
        <span className={css.fieldLabel}>{TEXT.titleLabel}</span>
        <Input
          className={css.fieldInput}
          placeholder={TEXT.titlePlaceholder}
          value={title}
          onChange={(event) => { setTitle(event.target.value) }}
        />
      </label>

      <label className={css.field}>
        <span className={css.fieldLabel}>{TEXT.bodyLabel}</span>
        {loading
          ? <div className={css.state}>{TEXT.loading}</div>
          : (
            <textarea
              className={css.textarea + ' ' + css.textareaBody}
              placeholder={TEXT.bodyPlaceholder}
              value={body}
              onChange={(event) => { setBody(event.target.value) }}
            />
          )}
      </label>

      {(localError !== '' || error !== '') && (
        <div className={css.stateError}>{localError !== '' ? localError : error}</div>
      )}

      <div className={css.editorActions}>
        <span className={css.editorFile}>
          {title.trim() === '' ? '—' : `${group === 'global' ? '全局' : group} · ${title.trim()}`}
        </span>
        <Button size="sm" onClick={onClose} disabled={busy}>{TEXT.cancel}</Button>
        <Button size="sm" variant="primary" disabled={busy || !ready || loading} onClick={submit}>
          {busy ? TEXT.saving : TEXT.confirm}
        </Button>
      </div>
    </div>
  )
}

/**
 * The library panel: list view and the shared entry form.
 *
 * @param props.actions - the public input action face.
 * @param props.onClose - close the panel.
 * @param props.onNotify - surface a one-line result banner.
 */
function QuickPromptPanel({ actions, onClose, onNotify }) {
  const [status, setStatus] = useState('loading')
  const [error, setError] = useState('')
  const [index, setIndex] = useState(null)
  const [query, setQuery] = useState('')
  const [groupFilter, setGroupFilter] = useState('')
  const [view, setView] = useState({ kind: 'list' })
  const [busy, setBusy] = useState(false)
  const [pendingDelete, setPendingDelete] = useState(null)

  const refresh = useCallback(async () => {
    setStatus('loading')
    try {
      const next = await loadIndex()
      setIndex(next)
      setError('')
      setStatus('ready')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      setStatus('error')
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const groups = index?.groups ?? []
  const entries = index?.entries ?? []
  const visible = useMemo(() => {
    const inGroup = groupFilter === '' ? entries : entries.filter(entry => entry.group === groupFilter)
    return filterEntries(inGroup, query)
  }, [entries, groupFilter, query])
  const sections = groupEntries(visible, groups)

  /** Read one entry's body and append it to the draft. */
  const insert = useCallback(async (entry) => {
    setBusy(true)
    try {
      const section = await loadSection(entry.group, entry.title)
      actions.setDraft(mergeDraft(actions.draft, section.body))
      setBusy(false)
      onNotify(TEXT.inserted + ' · ' + entry.title)
      onClose()
    } catch (failure) {
      setBusy(false)
      onNotify(failure instanceof Error ? failure.message : String(failure))
    }
  }, [actions, onClose, onNotify])

  /** Copy one entry's body to the clipboard. */
  const copy = useCallback(async (entry) => {
    setBusy(true)
    try {
      const section = await loadSection(entry.group, entry.title)
      await navigator.clipboard.writeText(section.body)
      onNotify(TEXT.copied)
    } catch (failure) {
      onNotify(TEXT.copyFailed + '：' + (failure instanceof Error ? failure.message : String(failure)))
    } finally {
      setBusy(false)
    }
  }, [onNotify])

  /** Submit the shared form: create or update, then back to the list. */
  const submitForm = useCallback(async (draft) => {
    setBusy(true)
    try {
      if (draft.originalTitle === undefined) {
        await callHost('/create', {
          method: 'POST',
          body: JSON.stringify({ group: draft.group, title: draft.title, body: draft.body }),
        })
        onNotify(TEXT.created + ' · ' + draft.title)
      } else {
        await callHost('/save-section', {
          method: 'POST',
          body: JSON.stringify({
            group: draft.group,
            title: draft.title,
            body: draft.body,
            originalTitle: draft.originalTitle,
          }),
        })
        onNotify(TEXT.saved + ' · ' + draft.title)
      }
      setError('')
      setView({ kind: 'list' })
      await refresh()
      return true
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      return false
    } finally {
      setBusy(false)
    }
  }, [onNotify, refresh])

  /** Delete one entry (and its file when it was the last one). */
  const remove = useCallback(async (entry) => {
    setBusy(true)
    try {
      await callHost('/delete-section', {
        method: 'POST',
        body: JSON.stringify({ group: entry.group, title: entry.title }),
      })
      onNotify(TEXT.deleted + ' · ' + entry.title)
      setPendingDelete(null)
      setError('')
      await refresh()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }, [onNotify, refresh])

  if (view.kind === 'form') {
    return (
      <EntryForm
        mode={view.mode}
        groups={groups}
        entry={view.entry}
        busy={busy}
        error={error}
        onSubmit={submitForm}
        onClose={() => { setView({ kind: 'list' }); setError('') }}
      />
    )
  }

  return (
    <>
      <div className={css.tabs}>
        <select
          className={css.select}
          value={groupFilter}
          onChange={(event) => { setGroupFilter(event.target.value) }}
          aria-label={TEXT.allGroups}
        >
          <option value="">{TEXT.allGroups}（{entries.length}）</option>
          {groups.map(group => (
            <option key={group.id} value={group.id}>
              {group.label}（{entries.filter(entry => entry.group === group.id).length}）
            </option>
          ))}
        </select>
        <div className={css.tabsSpacer} />
        <Tooltip label={TEXT.refresh} side="top">
          <button type="button" className={css.iconButton} aria-label={TEXT.refresh} onClick={() => { void refresh() }}>
            <IconRefresh />
          </button>
        </Tooltip>
      </div>

      <Input
        icon={<IconSearch />}
        className={css.search}
        placeholder={TEXT.searchPlaceholder}
        value={query}
        onChange={event => { setQuery(event.target.value) }}
      />

      <div className={css.list}>
        {status === 'loading' && <div className={css.state}>{TEXT.loading}</div>}
        {status === 'error' && <div className={css.state + ' ' + css.stateError}>{TEXT.failedLoad}：{error}</div>}
        {status === 'ready' && visible.length === 0 && (
          <div className={css.state}>
            {query.trim() !== '' || groupFilter !== '' ? TEXT.noMatch : TEXT.empty}
          </div>
        )}
        {status === 'ready' && sections.map(section => (
          <div key={section.group.id} className={css.group}>
            <div className={css.groupHeader}>
              <span className={css.groupName}>{section.group.label}</span>
              <span className={css.groupPath} title={section.group.dir}>{section.group.dir}</span>
            </div>
            {section.entries.map((entry) => (
              <div
                key={entryKey(entry)}
                className={css.row}
                role="button"
                tabIndex={0}
                onClick={() => { if (!busy) void insert(entry) }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    if (!busy) void insert(entry)
                  }
                }}
              >
                <div className={css.rowMain}>
                  <div className={css.rowTitle}>{entry.title}</div>
                  {entry.description !== '' && <div className={css.rowDescription}>{entry.description}</div>}
                </div>
                <div className={css.rowMeta}>{entry.chars} {TEXT.chars}</div>
                <div className={css.rowActions}>
                  <RowAction label={TEXT.copy} icon={<IconCopy />} onClick={() => { void copy(entry) }} />
                  <RowAction
                    label={TEXT.edit}
                    icon={<IconEdit />}
                    onClick={() => { setError(''); setView({ kind: 'form', mode: 'edit', entry }) }}
                  />
                  <RowAction
                    label={TEXT.remove}
                    icon={<IconTrash />}
                    danger
                    onClick={() => { setPendingDelete(entry) }}
                  />
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      {pendingDelete !== null && (
        <div className={css.confirm}>
          <div className={css.confirmText}>
            {TEXT.deleteAsk}
            <div className={css.confirmTarget}>
              {pendingDelete.group === 'global' ? '全局' : pendingDelete.group} · {pendingDelete.title}
            </div>
            {entries.filter(item => item.group === pendingDelete.group).length === 1
              && <div className={css.confirmHint}>{TEXT.deleteLastFile}</div>}
          </div>
          <div className={css.confirmActions}>
            <Button size="sm" onClick={() => { setPendingDelete(null) }} disabled={busy}>{TEXT.cancelDelete}</Button>
            <Button size="sm" variant="danger" onClick={() => { void remove(pendingDelete) }} disabled={busy}>
              {TEXT.confirmDelete}
            </Button>
          </div>
        </div>
      )}

      {error !== '' && status !== 'error' && pendingDelete === null && <div className={css.stateError}>{error}</div>}

      <div className={css.footer}>
        <Button
          size="sm"
          icon={<IconPlus />}
          onClick={() => { setError(''); setView({ kind: 'form', mode: 'create' }) }}
        >
          {TEXT.create}
        </Button>
        <span className={css.path} title={index?.root ?? index?.globalDir ?? ''}>
          {index?.root !== null && index?.root !== undefined
            ? TEXT.libraryPath + '：' + index.root
            : TEXT.globalPath + '：' + (index?.globalDir ?? '—')}
        </span>
      </div>
    </>
  )
}

/**
 * Composer tool-row entry: the button plus its panel.
 *
 * @param props.useInput - session input state selector (standard session kit).
 * @param props.inputActions - the public input action face (standard session kit).
 */
export function QuickPromptButton({ useInput, inputActions }) {
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState(null)
  const seq = useRef(0)
  const draft = useInput(state => state.draft)

  const notify = useCallback((text) => {
    seq.current += 1
    setNotice({ text, key: seq.current })
  }, [])

  const actions = useMemo(() => ({
    draft,
    setDraft: next => { inputActions.setDraft(next) },
  }), [draft, inputActions])

  return (
    <>
      <Tooltip label={TEXT.button} side="top" delayMs={400}>
        <button
          type="button"
          className={css.trigger}
          aria-label={TEXT.button}
          aria-haspopup="dialog"
          aria-expanded={open}
          onMouseDown={(event) => { event.preventDefault() }}
          onClick={() => { setOpen(true) }}
        >
          <IconSkill />
          <span className={css.triggerLabel}>{TEXT.button}</span>
        </button>
      </Tooltip>
      <Modal
        open={open}
        onClose={() => { setOpen(false) }}
        title={TEXT.title}
        description={TEXT.subtitle}
        closeLabel={TEXT.close}
        className={css.modal}
        contentClassName={css.modalContent}
      >
        {open && (
          <QuickPromptPanel
            actions={actions}
            onClose={() => { setOpen(false) }}
            onNotify={notify}
          />
        )}
      </Modal>
      {notice !== null && <Toast key={notice.key} text={notice.text} onDone={() => { setNotice(null) }} />}
    </>
  )
}

/**
 * Bodies of the entries behind the most recent `@` candidate fetch, keyed by
 * candidate name.
 *
 * Why this cache exists: the pick callback is SYNCHRONOUS and receives only the
 * candidate, while a body lives in a file — so bodies are read while the menu
 * is up, not during the pick.
 */
const mentionBodies = new Map()

/**
 * Read the listed entries' bodies in parallel into {@link mentionBodies}.
 * @param entries - the entries to hydrate.
 */
async function hydrateMentionBodies(entries) {
  await Promise.all(entries.map(async (entry) => {
    if (mentionBodies.has(entry.title)) return
    try {
      const section = await loadSection(entry.group, entry.title)
      mentionBodies.set(entry.title, section.body)
    } catch {
      // Reported at pick time; a menu that cannot read one file still works.
    }
  }))
}

/**
 * Build the candidate list for the `@` menu.
 * @param query - the text typed after the trigger.
 * @returns the candidates, in group then entry order.
 */
async function slashCandidates(query) {
  const index = await loadIndex()
  const listed = filterEntries(index.entries, query)
  const candidates = listed.map(entry => ({
    name: entry.title,
    description: `${entry.group === 'global' ? '全局' : entry.group} · ${entry.chars} ${TEXT.chars}`
      + (entry.description === '' ? '' : ` · ${entry.description}`),
    icon: '◫',
  }))
  void hydrateMentionBodies(listed)
  return candidates
}

/**
 * The plugin body.
 * @param ctx - client root context.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'prompt-trove',
    order: 10,
  }, QuickPromptButton)), 'prompt-trove: composer button')

  // The trigger pipeline's `@` source: the same library, no mouse.
  const triggers = ctx.get('inputTriggers')
  if (triggers !== undefined) {
    ctx.effect(() => triggers.registerSource({
      trigger: '@',
      name: TRIGGER_NAME,
      order: 3,
      async candidates(session, request) {
        void session
        return slashCandidates(request.query)
      },
      warm() {
        // Prewarm so the first `@` keystroke lists entries without waiting for
        // the index round trip (the scope-birth hook the pipeline offers).
        void slashCandidates('').catch(() => {})
      },
      onPick(pick) {
        const body = mentionBodies.get(pick.candidate.name)
        if (body === undefined) return undefined
        // Reference semantics: the picked text replaces the `@…` token span, so
        // the trigger word never reaches the model. The trailing newline leaves
        // the caret on a fresh line, ready for the actual request.
        return { text: body + '\n' }
      },
    }), 'prompt-trove: mention source')
  }
}
