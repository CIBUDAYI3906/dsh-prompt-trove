/**
 * Build `client.js` — the browser bundle the client module registry serves.
 *
 * The shipped client packages are plain `window.__ModuleLoader__.load({ id,
 * factory: (require) => … })` scripts, so this build produces exactly that
 * shape from readable sources:
 *
 *   client-source.jsx   JSX + ESM imports (the real source — edit this)
 *     ├─ esbuild transpiles the JSX
 *     ├─ every import statement is rewritten onto the `require(name)` calls
 *     │  the loader's frozen module table resolves
 *     ├─ PromptTrove.module.css is scoped (every local class gets the `qp-`
 *     │  prefix) and inlined
 *     └─ the result is wrapped in the loader shell, with the stylesheet
 *        inserted into `document.head` on load
 *
 * Usage: npm install && node build.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
const id = pkg.name

/** Page-global prefix for this package's local class names. */
const CLASS_PREFIX = 'qp-'

/** The stylesheet's source file. */
const STYLE_FILE = 'PromptTrove.module.css'

/** The readable source esbuild transpiles. */
const SOURCE_FILE = 'client-source.jsx'

/** esbuild is a devDependency of this package; a missing install says so once. */
function loadEsbuild() {
  const require = createRequire(import.meta.url)
  try {
    return require('esbuild')
  } catch {
    throw new Error('build: esbuild is not installed — run `npm install` in this package first')
  }
}

/**
 * The bindings of a named-import line, single-lined.
 * @param line - one (trimmed) import statement.
 * @returns the names between the braces.
 */
function importedNames(line) {
  return line.slice(line.indexOf('{') + 1, line.indexOf('}')).trim().replace(/\s*\n\s*/g, ' ')
}

/**
 * One import statement to rewrite. `import type` never survives esbuild, so
 * only value imports appear here; anything unmatched survives verbatim and
 * fails loudly at bundle-load verification instead of silently at runtime.
 */
const IMPORT_RULES = [
  {
    match: /^import\s+React\s+from\s+['"]react['"];?$/,
    line: () => 'const React = require("react")',
  },
  {
    match: /^import\s+\{[^}]*\}\s+from\s+['"]react\/jsx-runtime['"];?$/,
    line: (line) => 'const { ' + importedNames(line) + ' } = require("react/jsx-runtime")',
  },
  {
    match: /^import\s+\{[^}]*\}\s+from\s+['"]react['"];?$/,
    line: (line) => 'const { ' + importedNames(line) + ' } = require("react")',
  },
  {
    match: /^import\s+\{[^}]*\}\s+from\s+['"]@deepseek-ai\/dsh-client-ui-primitives['"];?$/,
    line: (line) => 'const { ' + importedNames(line) + ' } = require("@deepseek-ai/dsh-client-ui-primitives")',
  },
  {
    match: /^import\s+css\s+from\s+['"]\.\/PromptTrove\.module\.css['"];?$/,
    line: () => '',
  },
]

/**
 * Collapse every import statement onto one line: esbuild wraps a long named
 * binding list across lines, and a line-oriented rewrite cannot see those.
 * @param code - the transpiled module source.
 * @returns the source with all import statements single-lined.
 */
function collapseImports(code) {
  const lines = code.split('\n')
  const out = []
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index]
    if (!line.trimStart().startsWith('import ')) {
      out.push(line)
      continue
    }
    while (!line.trimEnd().endsWith(';') && index + 1 < lines.length) {
      index++
      line = line.trimEnd() + ' ' + lines[index].trim()
    }
    out.push(line)
  }
  return out.join('\n')
}

/**
 * Rewrite one esbuild-emitted import line into the loader's require form.
 * @param line - one output line.
 * @returns the rewritten line.
 */
function rewriteImport(line) {
  const rule = IMPORT_RULES.find((entry) => entry.match.test(line.trim()))
  return rule === undefined ? line : rule.line(line.trim())
}

/**
 * Every local class the bundle needs bound: the ones the stylesheet defines,
 * plus the ones the source reads (a `css.x` with no rule still yields a class
 * name instead of the string "undefined").
 * @param source - the JSX source text.
 * @param styleSheet - the stylesheet text.
 * @returns the sorted local names.
 */
function localClassNames(source, styleSheet) {
  const names = new Set()
  for (const match of styleSheet.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)) names.add(match[1])
  for (const match of source.matchAll(/\bcss\.([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(match[1])
  return [...names].sort()
}

/**
 * Bind `css` the way a CSS-modules import would: local names in, scoped names
 * out. The scope is applied to the stylesheet text too, so the inserted sheet
 * and the rendered class names agree.
 * @param names - the local class names.
 * @returns the `const css = …` declaration line.
 */
function cssDeclaration(names) {
  const map = {}
  for (const name of names) map[name] = CLASS_PREFIX + name
  return 'const css = ' + JSON.stringify(map)
}

/**
 * Rewrite every local class selector in the stylesheet onto its scoped name.
 * @param styleSheet - the stylesheet text.
 * @returns the scoped stylesheet.
 */
function scopeStyleSheet(styleSheet) {
  return styleSheet.replace(/\.([A-Za-z_][A-Za-z0-9_-]*)/g, (_match, name) => '.' + CLASS_PREFIX + name)
}

/**
 * Turn esbuild's trailing `export { … };` and leading `export ` keywords into
 * plain bindings (this code runs inside a factory, not a module).
 * @param code - the transpiled source.
 * @returns the same code without export syntax.
 */
function stripExports(code) {
  return code
    .replace(/^export \{[\s\S]*?\};\s*$/m, '')
    .replace(/^export (function|const|class|let|var) /gm, '$1 ')
    .trimEnd()
}

const esbuild = loadEsbuild()
const source = readFileSync(join(here, SOURCE_FILE), 'utf8')
const styleSheetSource = readFileSync(join(here, STYLE_FILE), 'utf8')

// An explicit loader: the source is JSX that must not be guessed from an
// extension, and the factory form is not a module.
const transformed = esbuild.transformSync(source, {
  loader: 'jsx',
  jsx: 'automatic',
  format: 'esm',
  target: 'es2020',
}).code

const cssNames = localClassNames(source, styleSheetSource)
const body = cssDeclaration(cssNames) + '\n'
  + stripExports(collapseImports(transformed).split('\n').map(rewriteImport).join('\n'))
const indented = body.split('\n').map((line) => (line === '' ? '' : '    ' + line)).join('\n')

/** The stylesheet travels inside the bundle and is inserted with the run. */
const styleSheet = scopeStyleSheet(styleSheetSource)

const bundle = `/**
 * ${id} — browser bundle (generated by build.mjs; edit ${SOURCE_FILE} instead).
 *
 * Composer tool-row button + \`@\` mention source over a two-tier prompt
 * library on disk. See ${SOURCE_FILE} for the behavior.
 */
window.__ModuleLoader__.load({
  id: ${JSON.stringify(id)},
  factory: (require) => {
${indented}

    // The body declares \`apply\`; the shell needs it under a name the
    // wrapper's own apply can delegate to.
    const applyInner = apply

    const STYLE = ${JSON.stringify(styleSheet)}

    /**
     * Insert this package's stylesheet. \`styles\` is the DYNAMIC plugin
     * sandbox's builtin: a client MODULE (this file's actual loading path) has
     * no such global, so the sheet is owned here, keyed by a data attribute so
     * a rebuild replaces the previous load instead of stacking a second copy
     * whose equal-specificity rules would win by order.
     */
    const STYLE_ATTR = 'data-${id}'
    function insertStyle() {
      const existing = document.head.querySelector('style[' + STYLE_ATTR + ']')
      if (existing !== null) {
        existing.textContent = STYLE
        return
      }
      const tag = document.createElement('style')
      tag.setAttribute(STYLE_ATTR, '')
      tag.textContent = STYLE
      document.head.append(tag)
    }

    return {
      name: ${JSON.stringify(id)},
      inject: ['slots'],
      apply(ctx) {
        insertStyle()
        return applyInner(ctx)
      },
    }
  },
})
`

writeFileSync(join(here, 'client.js'), bundle)
console.log('built client.js (' + bundle.length + ' bytes) for ' + id)
