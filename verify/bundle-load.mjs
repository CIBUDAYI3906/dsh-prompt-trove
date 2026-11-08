/**
 * Headless load check for the built `client.js`.
 *
 * The browser module registry evaluates the bundle inside
 * `window.__ModuleLoader__.load` with a `require` that resolves the REAL
 * installed client packages. This script reproduces that seam in Node against
 * the same installed artifacts, so a broken generated bundle or a name that no
 * longer exists in a peer package fails here instead of in the page:
 *
 * 1. the bundle parses and registers exactly one module under the package name;
 * 2. every `require(name)` it issues resolves to a real module, and every name
 *    it destructures is actually exported by that module;
 * 3. `apply(ctx)` runs against a stub context and registers the composer entry
 *    into `conversation.input.left`;
 * 4. the registered component RENDERS: it is invoked with stub session-kit
 *    props and a stubbed host behind `fetch`, and the produced markup is
 *    checked for the trigger.
 *
 * Usage: node verify/bundle-load.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { registerHooks } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const PKG = join(here, '..')
const PKG_NAME = 'dsh-prompt-trove'

/**
 * The installed dsh package directory. Derived from `which dsh` so the check
 * follows the installation instead of naming one machine's paths; override
 * with DSH_PACKAGE_DIR on a setup where the launcher is not on PATH.
 * @returns the @deepseek-ai/dsh package root.
 */
function findDshDir() {
  if (process.env.DSH_PACKAGE_DIR) return process.env.DSH_PACKAGE_DIR
  let bin
  try {
    bin = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim()
  } catch {
    bin = ''
  }
  if (bin === '') throw new Error('dsh is not on PATH — set DSH_PACKAGE_DIR to the installed @deepseek-ai/dsh directory')
  return dirname(dirname(realpathSync(bin)))
}

const DSH_DIR = findDshDir()
const RESOLVE_FROM = join(DSH_DIR, 'package.json')

/** The shell's own copies (the module-table seeds). */
const shellRequire = createRequire(RESOLVE_FROM)
/** This package's dev dependencies: the platform modules a browser shell seeds. */
const pkgRequire = createRequire(join(PKG, 'package.json'))
/** The profile's hoisted tree: where the web shell keeps client-side deps (clsx, katex, …). */
const profileRequire = createRequire(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'node_modules', 'noop.js'))

/**
 * Resolve one module-table specifier the way the shell seeds it: the installed
 * client packages first, then this package's dev copies for the platform
 * modules (React) the app shell provides in the browser.
 * @param spec - the specifier.
 * @returns the resolved file path.
 */
function resolveSpec(spec) {
  for (const resolver of [shellRequire, pkgRequire, profileRequire]) {
    try { return resolver.resolve(spec) } catch { /* try the next root */ }
  }
  return undefined
}

// A client package may import its stylesheet (katex.css reaches the tree
// through ui-primitives) and Node has no loader for `.css` — neither through
// `require` nor through ESM. This hook answers both with an empty default
// export, which is exactly what the browser-side css-modules shim provides.
// It also maps the platform modules (React) to this package's dev copies so a
// client package resolved from the dsh install still finds them.
let insideHook = false
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.css')) return { url: 'data:text/javascript,export default {}', shortCircuit: true }
    // `require.resolve` also passes through this hook, so a lookup from
    // inside it must fall through instead of recursing.
    if (insideHook) return nextResolve(specifier, context)
    insideHook = true
    try {
      try {
        return nextResolve(specifier, context)
      } catch (error) {
        const path = resolveSpec(specifier)
        if (path !== undefined) return { url: pathToFileURL(path).href, shortCircuit: true }
        throw error
      }
    } finally {
      insideHook = false
    }
  },
})
shellRequire.extensions['.css'] = (module) => { module.exports = {} }

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

/**
 * Read a module's exported names from its installed artifact.
 *
 * Loader bundles build an object and hand it to `__ModuleLoader__.load`; plain
 * ESM artifacts use `export` lists. Both forms are read statically, because
 * the check must work without evaluating a module that expects a browser.
 * @param path - absolute artifact path.
 * @returns the exported binding names.
 */
function exportNamesOf(path) {
  const text = readFileSync(path, 'utf8')
  const names = new Set()
  for (const match of text.matchAll(/exports\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g)) names.add(match[1])
  for (const match of text.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g)) names.add(match[1])
  for (const match of text.matchAll(/export \{([^}]*)\};?/g)) {
    for (const entry of match[1].split(',')) {
      const name = entry.includes(' as ') ? entry.split(' as ')[1] : entry
      if (name.trim() !== '') names.add(name.trim())
    }
  }
  return names
}

/** The specifiers this bundle may require, and where each resolves. */
const TABLE = new Map()
for (const spec of [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/server',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-slots',
]) {
  const path = resolveSpec(spec)
  if (path === undefined) failures.push('module table: cannot resolve ' + spec)
  else TABLE.set(spec, path)
}

/** Evaluated module exports, so the component can be rendered later. */
const evaluated = new Map()

/**
 * Evaluate one installed artifact the way the shell does.
 *
 * A loader bundle needs a `window.__ModuleLoader__.load` sink to hand its
 * exports to, and its own `require` resolves through this same function —
 * which is exactly the recursion the browser performs.
 * @param spec - the specifier being required.
 * @returns the module's exports object.
 */
function evaluate(spec) {
  if (evaluated.has(spec)) return evaluated.get(spec)
  const path = TABLE.get(spec)
  if (path === undefined) {
    failures.push(`require("${spec}") missed the module table — the browser would throw`)
    return {}
  }
  const text = readFileSync(path, 'utf8')
  let exports
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
    // The primitives artifact imports optional icon/katex deps that only the
    // browser build resolves. Static export checks above already cover the
    // names this bundle destructures; the render check below only needs stand-in
    // components, so a partial environment degrades instead of failing.
  }
  if (text.includes('__ModuleLoader__.load')) {
    let captured
    runInNewContext(text, {
      window: { __ModuleLoader__: { load: (entry) => { captured = entry } } },
      document: { head: { append() {}, querySelector: () => null }, createElement: () => ({ setAttribute() {} }) },
      console,
      setTimeout,
      clearTimeout,
      navigator: {},
    }, { filename: path })
    if (captured === undefined) {
      failures.push(`${spec}: loader bundle registered no module`)
      return {}
    }
    exports = captured.factory((name) => evaluate(name))
  } else {
    try {
      exports = shellRequire(path)
    } catch (error) {
      if (spec !== '@deepseek-ai/dsh-client-ui-primitives') throw error
      notes.push('skip: primitives did not load in Node (' + error.message.split('\n')[0] + ')')
      const React = evaluated.get('react')
      const Stub = (props) => React.createElement('div', null, props?.children)
      exports = new Proxy({}, {
        get: (_target, name) => (name === 'then' ? undefined : Stub),
        has: () => true,
      })
    }
  }
  evaluated.set(spec, exports)
  return exports
}

/**
 * Every name a module actually provides: the union of a static scan of its
 * artifact and — once it has been loaded — its real export keys. The static
 * scan covers loader bundles that were never evaluated; the runtime keys cover
 * plain ESM packages (React and friends), whose `export` statements a regex
 * cannot be trusted to enumerate.
 * @param spec - the specifier.
 * @returns the available names.
 */
function availableNames(spec) {
  const names = new Set()
  const path = TABLE.get(spec)
  if (path !== undefined) for (const name of exportNamesOf(path)) names.add(name)
  if (evaluated.has(spec)) for (const key of Object.keys(evaluated.get(spec) ?? {})) names.add(key)
  return names
}

// --- 1. the bundle registers itself ----------------------------------------

const bundlePath = join(PKG, 'client.js')
const bundle = readFileSync(bundlePath, 'utf8')
let registered = null

const windowStub = {
  __ModuleLoader__: {
    load(entry) {
      if (registered !== null) failures.push('bundle registered more than one module')
      registered = entry
    },
  },
  location: { origin: 'http://127.0.0.1:3080' },
  addEventListener() {},
  removeEventListener() {},
}

const documentStub = {
  head: { querySelector: () => null, append() {} },
  createElement: () => ({ setAttribute() {}, textContent: '' }),
  addEventListener() {},
  removeEventListener() {},
}

try {
  runInNewContext(bundle, { window: windowStub, document: documentStub, console }, { filename: bundlePath })
} catch (error) {
  failures.push('bundle threw while evaluating: ' + error.message)
}

check(registered !== null, 'bundle registered a module')
check(registered?.id === PKG_NAME, `registered id is "${registered?.id}" (expected "${PKG_NAME}")`)
check(typeof registered?.factory === 'function', 'registered factory is a function')

// --- 2. every require resolves, every destructured name exists -------------

// Load the peers first so the ESM ones expose their real export keys, then
// check the destructuring lines the build emitted against the whole table.
// A peer that cannot load in Node (one expecting the real browser shell) is
// noted and skipped rather than failing the run — the browser-side render
// check covers what this cannot.
for (const spec of TABLE.keys()) {
  try {
    evaluate(spec)
  } catch (error) {
    notes.push('skip: ' + spec + ' did not load in Node (' + error.message + ')')
  }
}

// The icon exports are bound as `const X = A ?? B` because the two supported
// DSH lines disagree on the spelling (0.1.0-rc.5 names the size in the export,
// 0.2.0-rc.2 only has the bare name). A pair needs ONE live side, so those
// names are checked as pairs below instead of one by one.
const paired = new Map()
for (const line of bundle.split('\n')) {
  const match = /^\s*const \w+ = (\w+) \?\? (\w+);?\s*$/.exec(line)
  if (match !== null) paired.set(match[1], match[2])
}
// Both sides of every pair are conditional: the running DSH has exactly one.
const conditional = new Set([...paired.keys(), ...paired.values()])

for (const line of bundle.split('\n')) {
  const match = /^\s*const \{ ([^}]*) \} = require\("([^"]+)"\)/.exec(line)
  if (match === null) continue
  const [, names, spec] = match
  if (!TABLE.has(spec)) {
    failures.push(`destructuring line requires "${spec}", which is not in the module table`)
    continue
  }
  const available = availableNames(spec)
  for (const raw of names.split(',')) {
    const name = raw.trim()
    if (name === '') continue
    if (conditional.has(name)) continue
    check(available.has(name), `${spec} exports ${name}`)
  }
}

// Whatever this DSH provides, every `??` pair must have at least one live side;
// a pair with neither is an undefined component, which throws at render time.
const anyExports = new Set()
for (const spec of TABLE.keys()) for (const name of availableNames(spec)) anyExports.add(name)
for (const [first, second] of paired) {
  check(anyExports.has(first) || anyExports.has(second), `either ${first} or ${second} exists`)
}

// --- 3. apply() registers into the composer's tool row ---------------------

/** Registrations captured from the stub slot registry. */
const registrations = []
/** Effects registered by apply, disposed in reverse on teardown. */
const effects = []

const triggers = { registerSource: (src) => { registrations.push({ kind: 'trigger', src }); return () => {} } }

const stubContext = {
  effect: (fn, label) => { const dispose = fn(); effects.push({ dispose, label }); return dispose },
  get: (name) => (name === 'inputTriggers' ? triggers : undefined),
  slots: {
    inject: (name, register) => { register() },
    register: (options, component) => {
      registrations.push({ kind: 'slot', options, component })
      return () => {}
    },
  },
}

let factoryExports = null
if (registered !== null) {
  try {
    factoryExports = registered.factory((spec) => evaluate(spec))
    notes.push('ok: factory ran')
  } catch (error) {
    failures.push('factory threw: ' + error.message)
  }
}

check(typeof factoryExports?.apply === 'function', 'factory exports an apply function')
check(factoryExports?.name === PKG_NAME, 'factory exports the plugin name')

if (typeof factoryExports?.apply === 'function') {
  try {
    factoryExports.apply(stubContext)
  } catch (error) {
    failures.push('apply threw: ' + error.message)
  }
  const slotEntry = registrations.find(r => r.kind === 'slot' && r.options.name === 'conversation.input.left')
  check(slotEntry !== undefined, 'apply registered an entry into conversation.input.left')
  check(typeof slotEntry?.component === 'function', 'the composer entry is a React component')
  const trigger = registrations.find(r => r.kind === 'trigger')
  check(trigger !== undefined, 'apply registered an input trigger source')
  check(trigger?.src.trigger === '@', 'the trigger source binds to "@"')
  check(typeof trigger?.src.onPick === 'function', 'the trigger source implements onPick')
}

// --- 4. the component renders ---------------------------------------------

/**
 * Render the registered component with stub session-kit props against a
 * stubbed host. This is the check that catches a wrong prop name, a missing
 * peer export used inside the tree, or a crash in the first paint — all of
 * which a registration-only check would pass.
 */
function renderComponent() {
  const slotEntry = registrations.find(r => r.kind === 'slot' && r.options.name === 'conversation.input.left')
  if (slotEntry === undefined) return

  const React = evaluate('react')
  const { renderToStaticMarkup } = evaluate('react-dom/server')

  const payload = {
    root: null,
    rootExists: false,
    globalDir: '/tmp/dsh-home/prompts',
    groups: [{ id: 'global', label: '全局', dir: '/tmp/dsh-home/prompts', exists: true }],
    entries: [{
      id: 'global#0', group: 'global',
      title: '工作背景与职责', description: '列表里显示的说明', tags: ['工作'], chars: 128, lines: 3,
    }],
  }

  const fetchStub = async (url) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).includes('/file?')
      ? { ok: true, value: { text: '## 投顾业务背景\n> 说明\n\n正文内容在这里。\n' } }
      : { ok: true, value: payload }),
  })
  globalThis.fetch = fetchStub

  const useInput = (selector) => selector({ draft: '已经写好的一半需求' })
  const inputActions = { setDraft: () => {} }

  let markup
  try {
    markup = renderToStaticMarkup(
      React.createElement(slotEntry.component, { sessionId: 'session-1', useInput, inputActions }),
    )
  } catch (error) {
    failures.push('component render threw: ' + (error.stack ?? error.message))
    return
  }
  notes.push('ok: component rendered (' + markup.length + ' chars)')
  check(markup.includes('常用提示词'), 'the trigger renders its label')
  check(markup.includes('qp-trigger'), 'the trigger carries its scoped class')
  check(markup.includes('aria-haspopup="dialog"'), 'the trigger announces a dialog')
}

renderComponent()

// --- 5. teardown ------------------------------------------------------------

try {
  for (const { dispose } of effects) if (typeof dispose === 'function') dispose()
  notes.push('ok: effects disposed cleanly')
} catch (error) {
  failures.push('disposing effects threw: ' + error.message)
}

// --- report -----------------------------------------------------------------

for (const note of notes) console.log(note)
if (failures.length === 0) {
  console.log('\nbundle-load: OK (' + notes.length + ' checks passed)')
  process.exit(0)
}
console.error('\nbundle-load: ' + failures.length + ' failure(s)')
for (const failure of failures) console.error('  ✗ ' + failure)
process.exit(1)
