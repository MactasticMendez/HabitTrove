import { execFileSync } from 'node:child_process'
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const credentialPattern = /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{20,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36,}|AIza[A-Za-z0-9_-]{35})\b/

/** Return fixed issue labels only; never include matching content in diagnostics. */
export function inspectRepositoryFile(filePath, contents) {
  const issues = new Set()
  const normalized = filePath.replaceAll('\\', '/')
  const name = path.posix.basename(normalized)

  if (/^(?:data(?:[._-][^/]*)?|backups?|uploads?|certificates|logs?)(?:\/|$)/i.test(normalized)) {
    issues.add('runtime data or backup file')
  }
  if (/^\.env(?:\.|$)/i.test(name) && !/^\.env\.(?:example|sample|template)$/i.test(name)) {
    issues.add('environment configuration')
  }
  if (/\.(?:pem|key|crt|cer|der|p12|pfx)$/i.test(name)) {
    issues.add('private key or certificate file')
  }
  if (/\.(?:db|sqlite3?|dump|bak|backup|tar|tgz|zip|7z|rar|gz|bz2|xz|zst)$|(?:^|[-_.])(?:backup|dump|export|snapshot)(?:[-_.].*)?\.sql$|\.before-[^/]+$/i.test(name)) {
    issues.add('database dump or backup file')
  }
  if (/^(?:\.next|out|build|dist|coverage|node_modules)(?:\/|$)/i.test(normalized) || /\.(?:log(?:\.\d+)?|tsbuildinfo)$/i.test(name)) {
    issues.add('generated build or log file')
  }

  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents)
  if (bytes.includes(0)) return [...issues]
  const text = bytes.toString('utf8')

  const emails = text.matchAll(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@([A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+)/gi)
  for (const [, domain] of emails) {
    // Database URL userinfo can precede an IP address; the network check handles it.
    if (/^[\d.]+$/.test(domain)) continue
    if (!/^(?:example\.(?:com|net|org)|.+\.(?:test|invalid))$/i.test(domain)) {
      issues.add('non-reserved email address')
      break
    }
  }
  for (const [address] of text.matchAll(/(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g)) {
    const octets = address.split('.').map(Number)
    if (octets.some(octet => octet > 255)) continue
    const [first, second, third] = octets
    const allowed = address === '0.0.0.0' || first === 127
      || (first === 192 && second === 0 && third === 2)
      || (first === 198 && second === 51 && third === 100)
      || (first === 203 && second === 0 && third === 113)
    if (!allowed) {
      issues.add('non-reserved IPv4 address')
      break
    }
  }
  if (/-----BEGIN (?:(?:RSA|DSA|EC|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----/.test(text)) {
    issues.add('private key material')
  }
  if (credentialPattern.test(text)) issues.add('credential token')
  if (/-- (?:PostgreSQL database|MySQL)[ \t]+dump|^COPY .+ FROM stdin;$/m.test(text)) {
    issues.add('database dump contents')
  }
  return [...issues]
}

function run() {
  if (process.argv.length > 2) {
    console.error('Usage: node scripts/check-repository-privacy.mjs')
    return 2
  }

  let root
  let files
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean)
  } catch {
    console.error('Repository privacy check could not list tracked files.')
    return 1
  }

  let failures = 0
  for (const file of files) {
    let descriptor
    let issues
    try {
      const filePath = path.join(root, file)
      const stat = lstatSync(filePath)
      if (stat.isSymbolicLink()) {
        issues = ['tracked symbolic link']
      } else if (!stat.isFile()) {
        issues = ['unsupported tracked file type']
      } else {
        // Do not follow a symlink swapped in after lstat, or read special files.
        descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        issues = fstatSync(descriptor).isFile()
          ? inspectRepositoryFile(file, readFileSync(descriptor))
          : ['unsupported tracked file type']
      }
    } catch (error) {
      // Deleted working-tree files are not part of the current tree being checked.
      if (error.code === 'ENOENT') continue
      issues = ['tracked file could not be inspected']
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
    }
    for (const issue of issues) {
      console.error(`${JSON.stringify(file)}: ${issue}`)
      failures++
    }
  }
  if (failures) {
    console.error(`Repository privacy check failed (${failures} issue${failures === 1 ? '' : 's'}).`)
    return 1
  }
  console.log(`Repository privacy check passed (${files.length} tracked files).`)
  return 0
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = run()
}
