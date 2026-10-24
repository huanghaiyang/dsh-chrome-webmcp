#!/usr/bin/env node
/**
 * 文件：install.mjs
 *
 * 职责：
 *   `dsh-chrome-webmcp` profile bundle 的一键安装 / 卸载器。它把本脚本所在目录作为
 *   一个 bundle 注册到 DeepSeek Harness 的某个 profile 中，实现方式是委托给真正拥有
 *   profile 的 CLI（dsh），而不是手工去改 profile 文件：
 *
 *     dsh plugin --profile <profile> add link:<本目录>        （安装）
 *     dsh plugin --profile <profile> remove dsh-chrome-webmcp （卸载）
 *
 * 调用方式：
 *     node install.mjs [--profile <名字>] [--uninstall] [--dry-run|-n] [--help|-h]
 *
 * 运行环境：
 *   零第三方依赖；需要 Node >= 22.3（与 harness 运行时保持一致）。
 *
 * 退出码约定：
 *   0  成功（包括 --help 和 --dry-run 的情况，后者不产生任何变更）
 *   1  失败（找不到 dsh、bundle 不完整、Node 版本过低、子进程非零退出等）
 *   2  用法错误（未知参数、--profile 缺少取值、profile 名不合法）
 *
 * 输出约定：
 *   普通信息写 stdout，统一前缀 `[install] `；错误写 stderr，前缀 `[install] error: `。
 *   调用 dsh 时子进程使用继承的 stdio，因此 dsh 自己的交互提示会直接出现在终端上。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Node 版本下限拆成主/次两个数字，便于分别比较；LABEL 只用于拼错误信息和帮助文本。
const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 3;
const MIN_NODE_LABEL = '22.3';
// bundle 在 profile 里的注册名，卸载时也用它定位目标。
const BUNDLE_NAME = 'dsh-chrome-webmcp';
// 本脚本所在目录即 bundle 目录：ESM 下没有 __dirname，只能从 import.meta.url 反推，
// 这样无论从哪个工作目录调用，最终写进 profile 的 link: 路径都是稳定的绝对路径。
const BUNDLE_DIR = path.dirname(fileURLToPath(import.meta.url));
// 平台差异集中在 IS_WIN 上：Windows 需要特别处理 npm 生成的 .cmd shim。
const IS_WIN = process.platform === 'win32';
// 未指定 profile 时的兜底值（DSH 的默认 web profile）。
const DEFAULT_PROFILE = 'web';
// profile 名白名单式正则：首个字符必须是字母或数字，避免出现以 "-" 开头（会被 dsh 当作
// 选项）或包含路径分隔符（可能跳出 profiles 目录）的名字。
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// 帮助文本是纯输出文案，保持原样不动；实际用法以其为准。
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

/** 向 stdout 输出一行。 */
const say = (message = '') => process.stdout.write(`${message}\n`);
/** 向 stderr 输出一行。 */
const warn = (message) => process.stderr.write(`${message}\n`);

/**
 * 输出一条可操作（带下一步建议）的错误信息并以指定退出码结束进程。
 * 注意这里是真正的 process.exit，调用后不会再返回。
 * @param {string} message - 面向用户的错误描述。
 * @param {number} [code=1] - 退出码；用法类错误传 2。
 */
function fail(message, code = 1) {
  warn(`[install] error: ${message}`);
  process.exit(code);
}

/**
 * 解析命令行。
 *
 * 解析顺序与规则（按参数在 argv 中出现的先后逐个处理，因此后面的参数会覆盖前面同名的）：
 *   1. `--help` / `-h` → 帮助（最高优先级，main 里最先判断，命中即返回）。
 *   2. `--dry-run` / `-n` → 只打印将执行的命令，不真正调用 dsh。
 *   3. `--uninstall` → 从安装切换为卸载。
 *   4. `--profile VALUE` → 取下一个 argv 作为值；若缺失或下一个 token 以 "-" 开头，
 *      视为用法错误（不把疑似选项吞成 profile 名）。
 *   5. `--profile=NAME` → 与上一条等价，空值同样是用法错误。
 *   6. 其他任何 token → 用法错误。这里刻意不忽略未知参数，避免拼写错误被静默放过
 *      （例如把 --dry-run 写成 --dryrun 后误执行真实安装）。
 *
 * @param {string[]} argv - 去掉 node 与脚本路径后的参数数组（即 process.argv.slice(2)）。
 * @returns {{profile: string, dryRun: boolean, uninstall: boolean, help: boolean}} 解析结果，profile 可能为空串表示未指定。
 */
function parseArgs(argv) {
  const options = { profile: '', dryRun: false, uninstall: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--dry-run' || arg === '-n') options.dryRun = true;
    else if (arg === '--uninstall') options.uninstall = true;
    else if (arg === '--profile') {
      // 消费掉值所在的位置，避免它在下一次循环里被当成未知选项。
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
 * 确定最终使用的 profile 名，优先级：命令行 --profile > 环境变量 DSH_PROFILE > 默认值 web。
 *
 * 为什么要校验：profile 名会进入 dsh 的参数列表，非法字符可能造成参数注入，或让
 * dsh 在 profiles 目录之外去找文件；因此这里用白名单正则直接拒绝，而不是只做 trim。
 *
 * @param {string} requested - 来自 --profile 的值，可能为空串。
 * @returns {string} 合法的 profile 名。
 * @throws 不抛异常，而是走 fail() 以退出码 2 直接终止进程（名字非法时）。
 */
function resolveProfile(requested) {
  const profile = requested || (process.env.DSH_PROFILE ?? '').trim() || DEFAULT_PROFILE;
  if (!PROFILE_PATTERN.test(profile)) {
    fail(`invalid profile name ${JSON.stringify(profile)}; expected letters, digits, ".", "_" or "-"`, 2);
  }
  return profile;
}

/** 判断路径是否指向一个已存在的普通文件（任何异常都视为“不存在”）。 */
function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * 判断路径是否是可执行文件。
 *
 * 平台差异：POSIX 上额外检查 X_OK（有执行位）；Windows 没有执行位概念，扩展名即可
 * 决定可执行性，所以只要求它是一个存在的文件。
 *
 * @param {string} candidate - 待检查的路径。
 * @returns {boolean}
 */
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
 * 定位 dsh CLI，查找顺序：先 $DSH_BIN，再在 PATH 中搜索。
 *
 * 为什么候选名要包含 Windows shim：npm 在 Windows 上安装的可执行命令生成的是
 * `dsh.cmd`（有时还有 `.bat`/`.exe`），直接找 `dsh` 会找不到，因此按
 * .cmd → .exe → .bat → 无扩展名的顺序依次尝试。
 *
 * @returns {{command: string, source: string} | undefined} 命中时返回可执行文件绝对路径及来源（DSH_BIN 或 PATH）；未找到返回 undefined。
 */
function findDsh() {
  const explicit = (process.env.DSH_BIN ?? '').trim();
  if (explicit !== '') {
    // DSH_BIN 既可以是裸命令名，也可以是路径（绝对或相对）：带分隔符就按路径处理。
    if (explicit.includes('/') || explicit.includes('\\')) {
      const resolved = path.resolve(explicit);
      if (isExecutableFile(resolved)) return { command: resolved, source: 'DSH_BIN' };
      // 在 Windows 上用户可能只写了不带扩展名的 shim 名字，这里补扩展名再试一次。
      for (const suffix of ['.cmd', '.exe', '.bat']) {
        if (isExecutableFile(resolved + suffix)) return { command: resolved + suffix, source: 'DSH_BIN' };
      }
      // 指定了路径却不存在：直接判定失败，不再回退到 PATH（避免装到错误的 dsh 上）。
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
 * 为一个命令名生成需要尝试的可执行文件名列表，按优先级排序。
 * @param {string} name - 命令名，如 `dsh`。
 * @returns {string[]} Windows 上给出多个 shim 扩展名，其他平台只给原样名字。
 */
function pathCandidates(name) {
  return IS_WIN ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name] : [name];
}

/**
 * 在一个文件名维度上遍历 PATH 查找可执行文件。
 *
 * 细节：PATH 项可能带双引号（Windows 上很常见），先去引号再 resolve；同时用 seen 去重，
 * 避免同一目录被重复检查；resolve 抛异常（例如非法字符）的项直接跳过。
 *
 * @param {string} name - 要查找的文件名（已含扩展名候选）。
 * @returns {string | undefined} 第一个命中的绝对路径；没有则 undefined。
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

/**
 * 为单个参数加引号，既用于展示，也用于 cmd.exe 命令行。
 * 含空白或双引号时用双引号包裹，内部的双引号按 cmd 规则写成两个。
 * @param {string} arg - 原始参数。
 * @returns {string} 可安全拼进命令行的形式。
 */
function quoteArg(arg) {
  return /[\s"]/.test(arg) ? `"${arg.replaceAll('"', '""')}"` : arg;
}

/**
 * 执行 dsh 子进程。
 *
 * 用继承的 stdio，让 dsh 的交互输出与提示直接落到终端。
 * 平台差异（关键）：Node >= 22 在没有 shell 的情况下拒绝 spawn `.cmd`/`.bat`
 * （会直接报 EINVAL），因此 Windows shim 走 `cmd.exe /d /s /c` 并把整条命令行
 * *提前* 引号化；真正的可执行文件则用参数数组直接 spawn，不经过任何 shell，
 * 从而避免二次转义问题。
 *
 * @param {{command: string}} dsh - 已定位的 CLI。
 * @param {string[]} args - 传给 dsh 的参数。
 * @returns {number} 子进程退出码（spawn 失败时由 finish 以退出码 1 结束进程）。
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
 * 把 spawnSync 的结果转成退出码，并显式报告启动阶段的失败。
 *
 * 说明：result.error 只在“根本没启动起来”时出现（例如 ENOENT）；此时没有 status，
 * 必须自己诊断并给出提示，而不是把 code 0 当成成功。
 *
 * @param {import('node:child_process').SpawnSyncReturns<null>} result - spawn 结果。
 * @param {string} shown - 用于诊断展示的命令行。
 * @returns {number} 退出码。
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

/**
 * 生成命令行的展示形式，供 --dry-run 与成功摘要使用。
 * dsh 未找到时退回字面量 `dsh`，这样用户仍能复制出可用的手动命令。
 * @param {{command: string} | undefined} dsh - 已定位的 CLI。
 * @param {string[]} args - 参数列表。
 * @returns {string} 引号化后的命令行。
 */
function preview(dsh, args) {
  const command = dsh?.command ?? 'dsh';
  return [command, ...args].map(quoteArg).join(' ');
}

/**
 * 主流程，固定按以下顺序执行：
 *   1. 解析参数；--help 直接输出并返回（不校验 Node 版本）。
 *   2. 校验 Node 版本（主版本与次版本分别比较）。
 *   3. 校验 bundle 完整性：bridge.mjs 与 cordis.patch.yml 必须同时存在，否则
 *      profile 里会挂上一个跑不起来的插件，不如提前失败。
 *   4. 解析 profile、拼出 add/remove 参数。
 *   5. 打印环境摘要并定位 dsh（仅用于展示，找到与否都不影响 dry-run）。
 *   6. dry-run 分支：只展示将执行的命令后返回，绝不调用 dsh、不做任何修改。
 *   7. 真实执行：找不到 dsh 时打印三种可行解法并以 1 退出；否则运行并透传退出码语义。
 *   8. 按安装/卸载分别输出后续步骤提示。
 */
function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  // 逐段比较版本：不能简单比较字符串（"22.10" < "22.3" 这类字典序问题），
  // 也先排除无法解析成整数的异常情况。
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  if (
    !Number.isInteger(nodeMajor) ||
    !Number.isInteger(nodeMinor) ||
    nodeMajor < MIN_NODE_MAJOR ||
    (nodeMajor === MIN_NODE_MAJOR && nodeMinor < MIN_NODE_MINOR)
  ) {
    fail(`Node >= ${MIN_NODE_LABEL} is required, this is ${process.version} (${process.execPath})`);
  }
  // 完整性检查：这两个文件是 bundle 能被 harness 加载的最小集合。
  if (!isFile(path.join(BUNDLE_DIR, 'bridge.mjs')) || !isFile(path.join(BUNDLE_DIR, 'cordis.patch.yml'))) {
    fail(`${BUNDLE_DIR} is not a complete bundle: bridge.mjs and cordis.patch.yml must both exist`);
  }

  const profile = resolveProfile(options.profile);
  // 安装用 `add link:<目录>`（不复制文件，profile 直接引用本目录）；卸载只需 bundle 名。
  const action = options.uninstall ? 'remove' : 'add';
  const args = options.uninstall
    ? ['plugin', '--profile', profile, 'remove', BUNDLE_NAME]
    : ['plugin', '--profile', profile, 'add', `link:${BUNDLE_DIR}`];

  // 先把上下文打印出来：dsh 报错时用户能立刻看到这次用的是哪个 profile 和哪个目录。
  say(`[install] mode      : ${options.uninstall ? 'uninstall' : 'install'}${options.dryRun ? ' (dry run)' : ''}`);
  say(`[install] bundle    : ${BUNDLE_NAME} -> ${BUNDLE_DIR}`);
  say(`[install] profile   : ${profile}`);
  say(`[install] node      : ${process.version} (${process.execPath})`);

  // 定位 dsh 只是为了让预览更真实；找不到也不在这里失败，留给后面分支分别处理。
  const dsh = findDsh();
  if (dsh !== undefined) say(`[install] dsh       : ${dsh.command} (from ${dsh.source})`);
  else say('[install] dsh       : not found (checked $DSH_BIN and PATH)');

  // dry-run 分支：必须在“找不到 dsh”的失败分支之前返回，这样无 dsh 的环境也能预览命令。
  if (options.dryRun) {
    say(`[install] would run : ${preview(dsh, args)}`);
    if (dsh === undefined) {
      say('[install] note      : a real run would stop here; install dsh or set DSH_BIN');
    }
    say('[install] dry run: nothing was changed');
    return;
  }

  // 真实执行但找不到 dsh：这里用 warn 给出三条可操作路径（PATH、DSH_BIN、手动命令），
  // 然后以 1 退出；不用 fail() 是为了让三条提示共享同一前缀格式。
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
  // 非零退出说明 dsh 自己拒绝了这次变更；原样透传错误提示，不尝试回滚或重试。
  if (status !== 0) {
    fail(`\`dsh plugin\` exited with code ${status}; nothing else was changed (see its output above)`);
  }

  // 卸载成功后提示重启 harness（或重新加载 profile），否则 chrome 相关 MCP 工具仍会残留。
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
