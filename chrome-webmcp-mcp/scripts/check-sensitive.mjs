#!/usr/bin/env node
/**
 * Sensitive-information and machine-path scanner for this repository.
 *
 * Fails (exit 1) when a tracked file contains machine-specific absolute paths or
 * credentials, so a public commit cannot leak a personal path or a token.
 *
 *   node scripts/check-sensitive.mjs            # human-readable report
 *   node scripts/check-sensitive.mjs --json     # machine-readable report
 *   node scripts/check-sensitive.mjs --root .   # scan another directory
 *
 * Escape hatches (documented, deliberate):
 *   - documented placeholders are allowed: <REPO>, <WORKSPACE>, <CHROME_EXE>,
 *     <name>, %LOCALAPPDATA%, ${VAR}, ...
 *   - system paths are allowed: C:\Program Files, C:\Program Files (x86), C:\Windows
 *   - a line containing `sanitize-ignore` is skipped (use for an intentional example)
 *
 * Skipped: .git, node_modules, .chrome* profiles, test/ and tmp/ directories,
 * binary files, and files larger than MAX_BYTES.
 *
 * Zero dependencies, Node >= 22.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 2 * 1024 * 1024;
const SKIP_DIR_NAMES = new Set(['.git', 'node_modules', 'test', 'tests', 'tmp', 'temp', 'coverage', 'dist']);
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.gz', '.tgz', '.tar',
  '.7z', '.exe', '.dll', '.node', '.so', '.dylib', '.bin', '.wasm', '.woff', '.woff2', '.ttf', '.otf',
  '.eot', '.mp3', '.mp4', '.wav', '.webm', '.sqlite', '.db', '.blend', '.blend1', '.pyc', '.class', '.jar',
]);
/** Placeholders and expansions that make a path sample safe to document. */
const PLACEHOLDER = /<[A-Za-z0-9 _.<>/-]+>|%[A-Za-z_][A-Za-z0-9_]*%|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\*|…|\.\.\./;
/** Absolute paths under these prefixes are operating-system locations, not personal data. */
const SYSTEM_PATH_PREFIXES = [
  /[A-Za-z]:[\\/]+Program Files(?: \(x86\))?[\\/]/i,
  /[A-Za-z]:[\\/]+Windows[\\/]/i,
  /[A-Za-z]:[\\/]+ProgramData[\\/]/i,
];
/** Account names that are OS-level shares rather than a person. */
const GENERIC_ACCOUNTS = new Set(['public', 'default', 'default user', 'all users', 'shared', 'user', 'username']);

/**
 * Rules. `re` must contain at least one capture group: group 1 is what gets reported
 * for single-match rules; `path` rules are additionally checked against the allowlists.
 * Regexes are written so the scanner's own source never matches them.
 */
const RULES = [
  {
    id: 'windows-user-profile',
    kind: 'path',
    severity: 'error',
    description: 'Windows user profile path (contains a personal account name)',
    re: /[A-Za-z]:[\\/]+Users[\\/]+([^\\/\s"'<>:|]+)/g,
    allowGroup: 1,
  },
  {
    id: 'posix-home',
    kind: 'path',
    severity: 'error',
    description: 'POSIX home directory path (/home/<name> or /Users/<name>)',
    // Not preceded by a word char, so URL paths such as https://host/home/x do not match.
    re: /(?<![\w.-])\/(?:home|Users)\/([^/\s"'<>]+)/g,
    allowGroup: 1,
  },
  {
    id: 'non-system-drive',
    kind: 'path',
    severity: 'error',
    description: 'absolute path on a non-system drive (D:/, E:/, ...)',
    // Requires a real path segment after the separator, so prose such as "D:" is not a hit.
    re: /(?<![\w$-])([D-Zd-z]:[\\/]+[^\s"'<>|,]+)/g,
    allowGroup: 1,
  },
  {
    id: 'private-key',
    kind: 'secret',
    severity: 'critical',
    description: 'private key block',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    id: 'token-openai',
    kind: 'secret',
    severity: 'critical',
    description: 'OpenAI-style API key (sk-...)',
    re: /(?:^|[^\w-])(sk-[A-Za-z0-9_-]{16,})/g,
    allowGroup: 1,
  },
  {
    id: 'token-github',
    kind: 'secret',
    severity: 'critical',
    description: 'GitHub token (ghp_/gho_/ghu_/ghs_/ghr_)',
    re: /(?:^|[^\w-])(gh[pousr]_[A-Za-z0-9]{16,})/g,
    allowGroup: 1,
  },
  {
    id: 'token-aws',
    kind: 'secret',
    severity: 'critical',
    description: 'AWS access key id (AKIA...)',
    re: /(?:^|[^\w-])(AKIA[0-9A-Z]{16})/g,
    allowGroup: 1,
  },
  {
    id: 'token-slack',
    kind: 'secret',
    severity: 'critical',
    description: 'Slack token (xox...)',
    re: /(?:^|[^\w-])(xox[baprs]-[A-Za-z0-9-]{10,})/g,
    allowGroup: 1,
  },
  {
    id: 'authorization-bearer',
    kind: 'secret',
    severity: 'critical',
    description: 'bearer/authorization token literal',
    re: /(?:^|[^\w-])(?:Bearer|Authorization:? Bearer)\s+([A-Za-z0-9._~+/-]{12,})/g,
    allowGroup: 1,
  },
  {
    id: 'cookie-value',
    kind: 'secret',
    severity: 'warning',
    description: 'literal cookie value',
    re: /(?:^|[^\w-])cookie\s*[:=]\s*["']?([^\s"']{8,})/gi,
    allowGroup: 1,
  },
];

/**
 * True when the reported capture is generic (placeholder, system path, generic account).
 * @param {string} value - the captured text.
 * @param {number} index - match start offset in the line.
 * @param {string} line - the whole line.
 * @param {{kind: string, allowGroup?: number}} rule - the rule that matched.
 * @param {RegExpExecArray} match - the match.
 * @returns {boolean} whether the finding must be suppressed.
 */
function isAllowed(value, index, line, rule, match) {
  if (PLACEHOLDER.test(value)) return true;
  for (const prefix of SYSTEM_PATH_PREFIXES) {
    const span = prefix.exec(line);
    if (span === null) continue;
    const start = span.index;
    if (index >= start && index < start + span[0].length) return true;
  }
  if (rule.allowGroup !== undefined) {
    const captured = match[rule.allowGroup] ?? '';
    if (GENERIC_ACCOUNTS.has(captured.toLowerCase())) return true;
  }
  return false;
}

/** Redact a secret in the report; a personal path is the finding and stays readable. */
function present(rule, value) {
  if (rule.kind !== 'secret' || value.length <= 10) return value;
  return `${value.slice(0, 4)}...redacted(${value.length})`;
}

/**
 * Whether a file is binary by extension or by a NUL byte in its head.
 * @param {string} file - absolute path.
 * @returns {boolean}
 */
function isBinary(file) {
  if (BINARY_EXTENSIONS.has(path.extname(file).toLowerCase())) return true;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(4096);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).includes(0);
  } catch {
    return true;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Directories to skip: the explicit list, Chrome profile directories (`.chrome*`), and
 * hidden tool/scratch directories such as `.git`/`.scratch`/`.tmp-*` (`.github` is
 * published content and stays scanned).
 */
function skipDirectory(name) {
  if (name !== '.github' && name.startsWith('.')) return true;
  return SKIP_DIR_NAMES.has(name) || name.startsWith('.chrome');
}

/** Recursively collect candidate files. */
function collectFiles(root) {
  const files = [];
  let skipped = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        skipped += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (skipDirectory(entry.name)) skipped += 1;
        else walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push(full);
    }
  };
  walk(root);
  return { files, skipped };
}

/**
 * Scan one file.
 * @returns {Array<{file: string, line: number, column: number, rule: string, severity: string, description: string, match: string}>}
 */
function scanFile(root, file) {
  const findings = [];
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return findings;
  }
  if (stat.size === 0 || stat.size > MAX_BYTES || isBinary(file)) return findings;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return findings;
  }
  if (text.includes('\u0000')) return findings;
  const lines = text.split(/\r?\n/);
  const relative = path.relative(root, file).split(path.sep).join('/');
  for (let number = 0; number < lines.length; number += 1) {
    const line = lines[number];
    if (line.includes('sanitize-ignore')) continue;
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      for (let match = rule.re.exec(line); match !== null; match = rule.re.exec(line)) {
        const value = rule.allowGroup === undefined ? match[0] : match[rule.allowGroup] ?? match[0];
        if (value === undefined || value === '') continue;
        if (isAllowed(value, match.index, line, rule, match)) continue;
        // Report the whole path for path rules (the account name alone is not the leak);
        // report only the captured secret for credential rules, redacted below.
        const reported = rule.kind === 'path' ? match[0] : value;
        findings.push({
          file: relative,
          line: number + 1,
          column: match.index + 1,
          rule: rule.id,
          severity: rule.severity,
          description: rule.description,
          match: present(rule, reported),
        });
      }
    }
  }
  return findings;
}

/** Resolve the repository root: --root, else the nearest ancestor containing .git. */
function resolveRoot(explicit) {
  if (explicit !== undefined) return path.resolve(explicit);
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

/** CLI entry point. */
function main() {
  const argv = process.argv.slice(2);
  let root;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: node scripts/check-sensitive.mjs [--json] [--root <dir>]\n\n'
        + 'Scans the repository for personal paths, machine-specific drive paths and credentials.\n'
        + 'Exit code 0 = clean, 1 = findings, 2 = usage error.\n',
      );
      return 0;
    }
    if (arg === '--json') json = true;
    else if (arg === '--root') {
      root = argv[index + 1];
      if (root === undefined) {
        process.stderr.write('check-sensitive: --root needs a directory\n');
        return 2;
      }
      index += 1;
    } else {
      process.stderr.write(`check-sensitive: unknown option ${JSON.stringify(arg)} (try --help)\n`);
      return 2;
    }
  }

  const absoluteRoot = resolveRoot(root);
  const { files, skipped } = collectFiles(absoluteRoot);
  const findings = files.flatMap((file) => scanFile(absoluteRoot, file));

  if (json) {
    process.stdout.write(`${JSON.stringify({
      root: absoluteRoot,
      scannedFiles: files.length,
      skippedEntries: skipped,
      findings,
      ok: findings.length === 0,
    }, null, 2)}\n`);
    return findings.length === 0 ? 0 : 1;
  }

  if (findings.length === 0) {
    process.stdout.write(`check-sensitive: clean (${files.length} files scanned in ${absoluteRoot})\n`);
    return 0;
  }
  for (const finding of findings) {
    process.stdout.write(
      `${finding.file}:${finding.line}:${finding.column}: ${finding.severity} [${finding.rule}] `
      + `${finding.match} - ${finding.description}\n`,
    );
  }
  process.stdout.write(
    `\ncheck-sensitive: ${findings.length} finding(s) in ${files.length} files. `
    + 'Replace personal/machine paths with placeholders (<REPO>, %LOCALAPPDATA%) or '
    + 'remove credentials before committing.\n',
  );
  return 1;
}

process.exitCode = main();
