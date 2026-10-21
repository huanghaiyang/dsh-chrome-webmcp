#!/usr/bin/env node
/**
 * One-click installer for the `dsh-chrome-webmcp` profile bundle.
 *
 * Registers this directory as a bundle in a DeepSeek Harness profile by delegating to
 * the profile-owning CLI, never by editing profile files:
 *
 *   dsh plugin --profile <profile> add link:<this directory>      (install)
 *   dsh plugin --profile <profile> remove dsh-chrome-webmcp      (uninstall)
 *
 * Zero dependencies, Node >= 22 (the harness runtime). Exit codes: 0 success,
 * 1 failure, 2 usage error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 3;
const MIN_NODE_LABEL = '22.3';
const BUNDLE_NAME = 'dsh-chrome-webmcp';
const BUNDLE_DIR = path.dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === 'win32';
const DEFAULT_PROFILE = 'web';
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const HELP = `Usage: node install.mjs [options]

Register this directory as the \`${BUNDLE_NAME}\` bundle in a DSH profile.

Requires Node >= ${MIN_NODE_LABEL}.

Options:
  --profile <name>   DSH profile to install into (default: $DSH_PROFILE, else "${DEFAULT_PROFILE}")
  --uninstall        Remove the bundle from the profile instead of installing it
  --dry-run, -n      Print the exact command without running it
  --help, -h         Show this help

How it works:
  Runs \`dsh plugin --profile <profile> add link:${BUNDLE_DIR}\` (or
  \`... remove ${BUNDLE_NAME}\`). Profile files are never edited by hand.

Finding dsh:
  Run this from a shell where \`dsh\` is on PATH, or point DSH_BIN at the executable
  (a full path or a command name; on Windows the .cmd shim is found automatically).

Environment:
  DSH_BIN       dsh executable or command name (overrides the PATH search)
  DSH_PROFILE   default profile name when --profile is omitted

Examples:
  node install.mjs
  node install.mjs --profile myprof --dry-run
  node install.mjs --uninstall --profile web
`;

/** Print a line to stdout. */
const say = (message = '') => process.stdout.write(`${message}\n`);
/** Print a line to stderr. */
const warn = (message) => process.stderr.write(`${message}\n`);

/** Fail with an actionable message and exit. */
function fail(message, code = 1) {
  warn(`[install] error: ${message}`);
  process.exit(code);
}

/**
 * Parse the CLI. Only long options are accepted; `--profile=NAME` is equivalent to
 * `--profile NAME`. Any unknown token is a usage error, not a silently ignored flag.
 * @param {string[]} argv - arguments after the script name.
 * @returns {{profile: string, dryRun: boolean, uninstall: boolean, help: boolean}}
 */
function parseArgs(argv) {
  const options = { profile: '', dryRun: false, uninstall: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--dry-run' || arg === '-n') options.dryRun = true;
    else if (arg === '--uninstall') options.uninstall = true;
    else if (arg === '--profile') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) fail('--profile needs a profile name', 2);
      options.profile = value;
      index += 1;
    } else if (arg.startsWith('--profile=')) {
      options.profile = arg.slice('--profile='.length);
      if (options.profile === '') fail('--profile needs a profile name', 2);
    } else fail(`unknown option ${JSON.stringify(arg)} (try --help)`, 2);
  }
  return options;
}

/**
 * Pick the profile: explicit flag, then $DSH_PROFILE, then `web`. Rejects names that
 * could escape the profiles directory or be mistaken for an option.
 * @param {string} requested - value from --profile (may be empty).
 * @returns {string}
 */
function resolveProfile(requested) {
  const profile = requested || (process.env.DSH_PROFILE ?? '').trim() || DEFAULT_PROFILE;
  if (!PROFILE_PATTERN.test(profile)) {
    fail(`invalid profile name ${JSON.stringify(profile)}; expected letters, digits, ".", "_" or "-"`, 2);
  }
  return profile;
}

/** Whether a path is an existing regular file. */
function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Whether a path is an existing executable file (POSIX X_OK; existence on Windows). */
function isExecutableFile(candidate) {
  if (!isFile(candidate)) return false;
  if (IS_WIN) return true;
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the `dsh` CLI: $DSH_BIN first, then a PATH search. Candidates include the
 * Windows shims (`dsh.cmd`, `dsh.bat`, `dsh.exe`), because npm installs a `.cmd` shim.
 * @returns {{command: string, source: string} | undefined}
 */
function findDsh() {
  const explicit = (process.env.DSH_BIN ?? '').trim();
  if (explicit !== '') {
    // An explicit setting may be a bare command name or a path (absolute or relative).
    if (explicit.includes('/') || explicit.includes('\\')) {
      const resolved = path.resolve(explicit);
      if (isExecutableFile(resolved)) return { command: resolved, source: 'DSH_BIN' };
      // On Windows a .cmd shim may be named without its extension.
      for (const suffix of ['.cmd', '.exe', '.bat']) {
        if (isExecutableFile(resolved + suffix)) return { command: resolved + suffix, source: 'DSH_BIN' };
      }
      return undefined;
    }
    for (const candidate of pathCandidates(explicit)) {
      const found = searchPath(candidate);
      if (found !== undefined) return { command: found, source: 'DSH_BIN' };
    }
    return undefined;
  }
  for (const candidate of pathCandidates('dsh')) {
    const found = searchPath(candidate);
    if (found !== undefined) return { command: found, source: 'PATH' };
  }
  return undefined;
}

/**
 * The executable names to try for one command name, in priority order.
 * @param {string} name - command name such as `dsh`.
 * @returns {string[]}
 */
function pathCandidates(name) {
  return IS_WIN ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name] : [name];
}

/**
 * Look one file name up in PATH.
 * @param {string} name - file name to look for.
 * @returns {string | undefined} absolute path of the first match.
 */
function searchPath(name) {
  const entries = (process.env.PATH ?? '').split(path.delimiter).filter((entry) => entry !== '');
  const seen = new Set();
  for (const entry of entries) {
    let dir;
    try {
      dir = path.resolve(entry.replace(/^"(.*)"$/, '$1'));
    } catch {
      continue;
    }
    if (seen.has(dir)) continue;
    seen.add(dir);
    const candidate = path.join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

/** Quote one argument for display and for a cmd.exe command line. */
function quoteArg(arg) {
  return /[\s"]/.test(arg) ? `"${arg.replaceAll('"', '""')}"` : arg;
}

/**
 * Run the child with inherited stdio so its interactive output and prompts reach the
 * terminal. Node >= 22 refuses to spawn a `.cmd`/`.bat` without a shell (EINVAL), so a
 * Windows shim is run through `cmd.exe /d /s /c` with a pre-quoted command line; a real
 * executable is spawned directly with an argument vector (no shell quoting involved).
 * @param {{command: string}} dsh - resolved CLI.
 * @param {string[]} args - CLI arguments.
 * @returns {number} child exit code.
 */
function runDsh(dsh, args) {
  const isShim = IS_WIN && /\.(cmd|bat)$/i.test(dsh.command);
  if (isShim) {
    const commandLine = [quoteArg(dsh.command), ...args.map(quoteArg)].join(' ');
    const result = spawnSync(commandLine, { stdio: 'inherit', shell: true });
    return finish(result, commandLine);
  }
  const result = spawnSync(dsh.command, args, { stdio: 'inherit' });
  return finish(result, [dsh.command, ...args].map(quoteArg).join(' '));
}

/**
 * Convert a spawnSync result into an exit code, reporting spawn failures explicitly.
 * @param {import('node:child_process').SpawnSyncReturns<null>} result - spawn result.
 * @param {string} shown - command line for diagnostics.
 * @returns {number} exit code.
 */
function finish(result, shown) {
  if (result.error !== undefined) {
    const detail = result.error.code === 'ENOENT'
      ? 'the command disappeared while starting'
      : String(result.error.message);
    fail(`could not run ${shown}: ${detail}`);
  }
  return result.status ?? 1;
}

/** Command line preview for --dry-run and for the success summary. */
function preview(dsh, args) {
  const command = dsh?.command ?? 'dsh';
  return [command, ...args].map(quoteArg).join(' ');
}

/** Main. */
function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  if (
    !Number.isInteger(nodeMajor) ||
    !Number.isInteger(nodeMinor) ||
    nodeMajor < MIN_NODE_MAJOR ||
    (nodeMajor === MIN_NODE_MAJOR && nodeMinor < MIN_NODE_MINOR)
  ) {
    fail(`Node >= ${MIN_NODE_LABEL} is required, this is ${process.version} (${process.execPath})`);
  }
  if (!isFile(path.join(BUNDLE_DIR, 'bridge.mjs')) || !isFile(path.join(BUNDLE_DIR, 'cordis.patch.yml'))) {
    fail(`${BUNDLE_DIR} is not a complete bundle: bridge.mjs and cordis.patch.yml must both exist`);
  }

  const profile = resolveProfile(options.profile);
  const action = options.uninstall ? 'remove' : 'add';
  const args = options.uninstall
    ? ['plugin', '--profile', profile, 'remove', BUNDLE_NAME]
    : ['plugin', '--profile', profile, 'add', `link:${BUNDLE_DIR}`];

  say(`[install] mode      : ${options.uninstall ? 'uninstall' : 'install'}${options.dryRun ? ' (dry run)' : ''}`);
  say(`[install] bundle    : ${BUNDLE_NAME} -> ${BUNDLE_DIR}`);
  say(`[install] profile   : ${profile}`);
  say(`[install] node      : ${process.version} (${process.execPath})`);

  const dsh = findDsh();
  if (dsh !== undefined) say(`[install] dsh       : ${dsh.command} (from ${dsh.source})`);
  else say('[install] dsh       : not found (checked $DSH_BIN and PATH)');

  if (options.dryRun) {
    say(`[install] would run : ${preview(dsh, args)}`);
    if (dsh === undefined) {
      say('[install] note      : a real run would stop here; install dsh or set DSH_BIN');
    }
    say('[install] dry run: nothing was changed');
    return;
  }

  if (dsh === undefined) {
    warn('[install] error: the `dsh` CLI was not found.');
    warn('[install]   - run this from a shell where `dsh` is on PATH (the one you start the harness with), or');
    warn('[install]   - set DSH_BIN to its full path, e.g. DSH_BIN="C:\\path\\to\\dsh.cmd" (Windows cmd:' +
      ' set "DSH_BIN=C:\\path\\to\\dsh.cmd")');
    warn(`[install]   - or run it yourself: dsh plugin --profile ${profile} ${action} ` +
      `${options.uninstall ? BUNDLE_NAME : `link:${BUNDLE_DIR}`}`);
    process.exit(1);
  }

  say(`[install] running   : ${preview(dsh, args)}`);
  const status = runDsh(dsh, args);
  if (status !== 0) {
    fail(`\`dsh plugin\` exited with code ${status}; nothing else was changed (see its output above)`);
  }

  if (options.uninstall) {
    say('');
    say(`[install] removed ${BUNDLE_NAME} from profile "${profile}".`);
    say('[install] restart the harness (or reload the profile) to drop the `chrome` MCP tools.');
    return;
  }

  say('');
  say(`[install] installed ${BUNDLE_NAME} into profile "${profile}".`);
  say('[install] next steps:');
  say('  1. Restart the harness (or let the plugin row hot-reload) so the new MCP server starts.');
  say('  2. Call mcp__chrome__status - reachable=true means the bridge talks to Chrome.');
  say('  3. If Chrome is not reachable, call mcp__chrome__launch (the harness host must start');
  say('     Chrome; an agent-sandboxed shell cannot).');
  say(`[install] to undo: node install.mjs --uninstall --profile ${profile}`);
}

main();
