/**
 * Fill the GitHub owner into the places that name the repository.
 *
 * Usage: npm run owner <github-user>
 *
 * The package ships with `OWNER` placeholders so nothing accidentally claims a
 * repository that has not been created yet; this script replaces them, renames
 * the catalog submission file, and prints the two commands that follow.
 */
import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = join(here, '..')
const owner = process.argv[2]

if (owner === undefined || !/^[A-Za-z\d](?:[A-Za-z\d-]{0,38})$/.test(owner)) {
  console.error('usage: npm run owner <github-user>')
  process.exit(1)
}

/** Replace the OWNER token in one file when it is there. */
function rewrite(file) {
  const path = join(pkgDir, file)
  const text = readFileSync(path, 'utf8')
  if (!text.includes('OWNER')) return
  writeFileSync(path, text.split('OWNER').join(owner))
}

for (const file of ['package.json', 'README.md', 'PUBLISH.md', 'submission/OWNER__dsh-prompt-trove.yml']) {
  rewrite(file)
}

const submission = join(pkgDir, 'submission', 'OWNER__dsh-prompt-trove.yml')
if (readdirSync(join(pkgDir, 'submission')).includes('OWNER__dsh-prompt-trove.yml')) {
  renameSync(submission, join(pkgDir, 'submission', owner + '__dsh-prompt-trove.yml'))
}

console.log('owner set to ' + owner + '. next:')
console.log('  git init -b main && git add . && git commit -m "dsh-prompt-trove 0.1.0"')
console.log('  git remote add origin git@github.com:' + owner + '/dsh-prompt-trove.git && git push -u origin main')
