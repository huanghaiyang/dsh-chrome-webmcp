#!/usr/bin/env node
/**
 * 文件：scripts/check-sensitive.mjs
 *
 * 职责：
 *   本仓库的敏感信息 / 机器相关路径扫描器。只要某个被跟踪文件里出现“只属于某台机器”
 *   的绝对路径或凭据，就让检查失败（退出码 1），从而保证公开提交不会泄漏个人路径或
 *   Token，同时也把“可安全公开”的写法（占位符）显式列出，避免误报干扰。
 *
 * 调用方式：
 *   node scripts/check-sensitive.mjs            # 人类可读报告
 *   node scripts/check-sensitive.mjs --json     # 机器可读报告（CI 用）
 *   node scripts/check-sensitive.mjs --root .   # 扫描另一个目录
 *
 * 退出码约定：
 *   0  干净（无任何发现，或只是打印了 --help）
 *   1  发现问题（此时 stdout 逐条列出 file:line:column severity [rule] match - 说明）
 *   2  用法错误（未知选项、--root 缺少目录）
 *
 * 输出约定：
 *   人类可读模式：干净时输出一行 `check-sensitive: clean (...)`；有问题时逐条输出
 *   发现行，并在末尾汇总总数与修复建议。JSON 模式输出单个对象，包含 root、
 *   scannedFiles、skippedEntries、findings 与 ok 字段。
 *
 * 例外机制（都是有意设计并在此文档化的误报白名单）：
 *   - 允许文档化的占位符：<REPO>、<WORKSPACE>、<CHROME_EXE>、<name>、%LOCALAPPDATA%、
 *     ${VAR} 等；
 *   - 允许操作系统自带路径：C:\Program Files、C:\Program Files (x86)、C:\Windows；
 *   - 含 `sanitize-ignore` 的行整行跳过（用于确有必要展示的真实样例）。
 *
 * 跳过范围：.git、node_modules、.chrome* 之类的浏览器 profile 目录、test/ 与 tmp/
 * 目录、二进制文件，以及超过 MAX_BYTES 的文件。
 *
 * 运行环境：零第三方依赖，需要 Node >= 22。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 单文件大小上限 2 MiB：再大的文件基本是产物或数据，逐行正则扫描代价高且收益低。
const MAX_BYTES = 2 * 1024 * 1024;
// 明确跳过的目录名：版本库元数据、依赖、测试夹具、临时目录与构建产物都不代表发布内容。
const SKIP_DIR_NAMES = new Set(['.git', 'node_modules', 'test', 'tests', 'tmp', 'temp', 'coverage', 'dist']);
// 按扩展名已知的二进制类型（另有 NUL 字节嗅探作为补充），避免在没有文本语义的文件上做正则。
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.gz', '.tgz', '.tar',
  '.7z', '.exe', '.dll', '.node', '.so', '.dylib', '.bin', '.wasm', '.woff', '.woff2', '.ttf', '.otf',
  '.eot', '.mp3', '.mp4', '.wav', '.webm', '.sqlite', '.db', '.blend', '.blend1', '.pyc', '.class', '.jar',
]);
/**
 * 占位符与环境变量展开形式：出现在路径里说明这只是一个示例，而不是某台机器的真实路径。
 * 覆盖四类：<尖括号占位>、%WIN%风格变量%、$VAR / ${VAR} 展开、通配符 * 与省略号。
 */
const PLACEHOLDER = /<[A-Za-z0-9 _.<>/-]+>|%[A-Za-z_][A-Za-z0-9_]*%|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\*|…|\.\.\./;
/** 这些前缀下的绝对路径属于操作系统安装位置，不含个人信息，因此不算泄漏。 */
const SYSTEM_PATH_PREFIXES = [
  /[A-Za-z]:[\\/]+Program Files(?: \(x86\))?[\\/]/i,
  /[A-Za-z]:[\\/]+Windows[\\/]/i,
  /[A-Za-z]:[\\/]+ProgramData[\\/]/i,
];
/** 这些账户名是系统级的“共享/默认”账户，不是某个具体的人。 */
const GENERIC_ACCOUNTS = new Set(['public', 'default', 'default user', 'all users', 'shared', 'user', 'username']);

/**
 * 扫描规则表。字段约定：
 *   - id：稳定的规则名（报告里的 [rule]，CI 可直接匹配）；
 *   - kind：path 表示“机器路径”，secret 表示“凭据”，决定上报整段还是仅上报捕获值；
 *   - severity：critical / error / warning，仅作分级提示，退出码只看是否有发现；
 *   - re：必须至少包含一个捕获组。单匹配规则用第 1 组做上报与白名单判断；
 *     path 规则在此基础上还会对整段做系统路径白名单校验。
 *
 * 正则统一带 g 标志，因为每个文件内需要逐行、逐次匹配所有出现；使用前会重置 lastIndex。
 * 这些正则的写法刻意保证“扫描器自身源码”不会命中它们（例如 Windows 用户目录这一段用
 * 分隔符类而不是字面路径），否则扫描自己就会失败。
 */
const RULES = [
  {
    id: 'windows-user-profile',
    kind: 'path',
    severity: 'error',
    description: 'Windows user profile path (contains a personal account name)',
    // 捕获的是账户名（第 1 组），但上报整段路径：账户名单独出现没有意义，路径才是证据。
    re: /[A-Za-z]:[\\/]+Users[\\/]+([^\\/\s"'<>:|]+)/g,
    allowGroup: 1,
  },
  {
    id: 'posix-home',
    kind: 'path',
    severity: 'error',
    description: 'POSIX home directory path (/home/<name> or /Users/<name>)',
    // 前面不能是单词字符，这条负向后顾专门用来排除 URL 里的同名路径段
    // （形如 https://host/<home 段>/x 的链接不是本地路径）。
    re: /(?<![\w.-])\/(?:home|Users)\/([^/\s"'<>]+)/g,
    allowGroup: 1,
  },
  {
    id: 'non-system-drive',
    kind: 'path',
    severity: 'error',
    description: 'absolute path on a non-system drive (D:/, E:/, ...)',
    // 分隔符后必须跟着至少一个非空白的路径片段，所以正文里单独提到盘符字母不会误报；
    // 前面的负向后顾排除 `${D:...}` 之类的变量插值。只覆盖 D~Z（含小写），C 盘放行。
    re: /(?<![\w$-])([D-Zd-z]:[\\/]+[^\s"'<>|,]+)/g,
    allowGroup: 1,
  },
  {
    id: 'private-key',
    kind: 'secret',
    severity: 'critical',
    description: 'private key block',
    // 只匹配 PEM 头行，不校验正文：一旦出现头行基本可以断定有私钥被提交。
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    id: 'token-openai',
    kind: 'secret',
    severity: 'critical',
    description: 'OpenAI-style API key (sk-...)',
    // 前缀前允许任意非单词字符，使 `KEY=sk-...`、`"sk-...` 这类上下文也能命中；
    // 但排除前一个字符是字母数字或 "-"（避免把形如 task-sk-... 的变量名误判）。
    re: /(?:^|[^\w-])(sk-[A-Za-z0-9_-]{16,})/g,
    allowGroup: 1,
  },
  {
    id: 'token-github',
    kind: 'secret',
    severity: 'critical',
    description: 'GitHub token (ghp_/gho_/ghu_/ghs_/ghr_)',
    // 覆盖 GitHub 五种 token 前缀：personal / oauth / user-to-server / server-to-server / refresh。
    re: /(?:^|[^\w-])(gh[pousr]_[A-Za-z0-9]{16,})/g,
    allowGroup: 1,
  },
  {
    id: 'token-aws',
    kind: 'secret',
    severity: 'critical',
    description: 'AWS access key id (AKIA...)',
    // AKIA 是长期访问密钥的固定前缀；这里只做模式识别，不连接 AWS 校验有效性（零依赖且离线）。
    re: /(?:^|[^\w-])(AKIA[0-9A-Z]{16})/g,
    allowGroup: 1,
  },
  {
    id: 'token-slack',
    kind: 'secret',
    severity: 'critical',
    description: 'Slack token (xox...)',
    // xox[baprs] 覆盖 bot / app / user / refresh / workspace token 等常见变体。
    re: /(?:^|[^\w-])(xox[baprs]-[A-Za-z0-9-]{10,})/g,
    allowGroup: 1,
  },
  {
    id: 'authorization-bearer',
    kind: 'secret',
    severity: 'critical',
    description: 'bearer/authorization token literal',
    // 只上报 token 本体（第 1 组），不把 "Authorization:" 这类字段名算作发现；
    // 长度下限 12 是为了放过 Bearer <placeholder> 之类的文档示例。
    re: /(?:^|[^\w-])(?:Bearer|Authorization:? Bearer)\s+([A-Za-z0-9._~+/-]{12,})/g,
    allowGroup: 1,
  },
  {
    id: 'cookie-value',
    kind: 'secret',
    severity: 'warning',
    description: 'literal cookie value',
    // 抓取 cookie 赋值/头的字面量；分级为 warning，因为真实样例里出现 cookie 也可能是文档说明。
    // 用 i 标志兼容 Cookie / cookie 的大小写写法。
    re: /(?:^|[^\w-])cookie\s*[:=]\s*["']?([^\s"']{8,})/gi,
    allowGroup: 1,
  },
];

/**
 * 判断一次命中是否属于“泛化内容”而应被抑制（误报白名单）。
 *
 * 三层判断，顺序即优先级：
 *   1. 占位符：捕获值里出现 <...>、%VAR%、$VAR、* 或省略号 → 是示例文本。
 *   2. 系统路径：需要在整行上定位系统前缀的出现区间，只有当本次命中落在该区间内才放行；
 *      只判断“行里有 C:\Windows”是不够的 —— 同一行还可能有真实的用户路径，
 *      那样会把真正的泄漏一并放过。
 *   3. 通用账户名：捕获到的账户名属于 PUBLIC / Default 这类系统共享账户时放行（不区分大小写）。
 *
 * @param {string} value - 规则上报用的捕获文本。
 * @param {number} index - 本次命中在该行中的起始偏移。
 * @param {string} line - 整行原文（用于系统前缀区间定位）。
 * @param {{kind: string, allowGroup?: number}} rule - 命中的规则。
 * @param {RegExpExecArray} match - 完整匹配结果。
 * @returns {boolean} true 表示应抑制该发现。
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

/**
 * 生成报告里展示的文本：凭据做脱敏，个人路径保持可读。
 *
 * 为什么区别对待：路径本身就是需要修复的对象，必须让人看清；
 * 而凭据一旦完整打印到 CI 日志，等于二次泄漏，所以只留前 4 个字符 + 长度。
 * 长度不超过 10 的值不再脱敏（脱敏后信息量过低，且这种长度基本不是真密钥）。
 *
 * @param {{kind: string}} rule - 命中的规则。
 * @param {string} value - 待展示的值。
 * @returns {string} 展示文本。
 */
function present(rule, value) {
  if (rule.kind !== 'secret' || value.length <= 10) return value;
  return `${value.slice(0, 4)}...redacted(${value.length})`;
}

/**
 * 判断文件是否为二进制：先看扩展名，再看文件头 4 KiB 里是否有 NUL 字节。
 * 读取失败时返回 true（当作二进制跳过），因为无法读取的文件也解析不出文本内容。
 * @param {string} file - 文件绝对路径。
 * @returns {boolean} true 表示二进制、应跳过。
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
 * 判断某个子目录是否应该跳过。
 *
 * 规则分两类：
 *   - 显式名单（版本库、依赖、测试夹具、构建产物）；
 *   - 以点开头的隐藏目录：Chrome 用户数据目录（`.chrome*`）以及 .git/.scratch/.tmp-* 这类
 *     工具或临时目录。这里对 `.github` 做了单独放行，因为它是需要被审查的发布内容
 *     （CI 工作流里同样可能写出错误路径）。
 *
 * @param {string} name - 目录名（不含父路径）。
 * @returns {boolean} true 表示跳过。
 */
function skipDirectory(name) {
  if (name !== '.github' && name.startsWith('.')) return true;
  return SKIP_DIR_NAMES.has(name) || name.startsWith('.chrome');
}

/**
 * 递归收集候选文件（尚未做大小/二进制过滤，那一步在 scanFile 里做）。
 *
 * 边界处理：
 *   - 目录项按名称排序，保证输出顺序稳定（CI 中两次运行的报告可直接 diff）；
 *   - 符号链接一律跳过并计入 skipped，避免链接成环导致无限递归或越出仓库；
 *   - 读取目录失败（权限等）直接返回，不中断整次扫描。
 *
 * @param {string} root - 扫描根目录的绝对路径。
 * @returns {{files: string[], skipped: number}} 文件绝对路径列表与被跳过的目录项数量。
 */
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
 * 扫描单个文件，返回所有（未被白名单抑制的）发现。
 *
 * 跳过条件依次为：无法 stat、空文件、超过 MAX_BYTES、二进制、读取失败、含 NUL 字节。
 * 这些判断放在逐行扫描之前，避免把大文件或无文本语义的内容塞进正则。
 * 行内含 `sanitize-ignore` 时整行跳过（这是唯一有意提供的行级豁免）。
 * 上报列号统一从 1 开始计数，与常见编辑器/CI 标注一致。
 *
 * @param {string} root - 扫描根目录（用于把绝对路径转成相对路径展示）。
 * @param {string} file - 待扫描文件的绝对路径。
 * @returns {Array<{file: string, line: number, column: number, rule: string, severity: string, description: string, match: string}>} 发现列表。
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
  // 二次确认：扩展名可能看不出来，但 NUL 字节说明这不是普通文本。
  if (text.includes('\u0000')) return findings;
  const lines = text.split(/\r?\n/);
  // 相对路径统一用 "/" 分隔，让 Windows 与 POSIX 的报告格式一致。
  const relative = path.relative(root, file).split(path.sep).join('/');
  for (let number = 0; number < lines.length; number += 1) {
    const line = lines[number];
    if (line.includes('sanitize-ignore')) continue;
    for (const rule of RULES) {
      // 带 g 标志的正则在跨调用时会保留 lastIndex，必须重置，否则会漏掉行首匹配。
      rule.re.lastIndex = 0;
      for (let match = rule.re.exec(line); match !== null; match = rule.re.exec(line)) {
        const value = rule.allowGroup === undefined ? match[0] : match[rule.allowGroup] ?? match[0];
        if (value === undefined || value === '') continue;
        if (isAllowed(value, match.index, line, rule, match)) continue;
        // 路径类上报整段（账户名单独出现看不出问题所在）；凭据类只上报捕获值，下面脱敏。
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

/**
 * 确定扫描根目录：显式 --root 优先；否则从脚本所在目录向上找最近的、包含 .git 的祖先。
 *
 * 为什么不直接假设 cwd：脚本可能从任意目录被调用（例如 CI 的 npm script），
 * 用脚本自身位置向上找更稳。最多上溯 8 层防止极端路径下反复；找不到 .git 时
 * 退回“scripts 目录的上一级”，即仓库根。
 *
 * @param {string} [explicit] - --root 传入的目录。
 * @returns {string} 根目录绝对路径。
 */
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

/**
 * CLI 入口：解析 `[--json] [--root <dir>] [--help|-h]`，扫描并输出报告。
 *
 * 参数解析：只接受长选项，--root 后必须紧跟目录（缺失即退出码 2），其余未知选项
 * 一律视为用法错误而不是静默忽略；--help 立即返回 0（此时不扫描，因此不受发现影响）。
 * 退出码语义：0 干净，1 有发现，2 用法错误。
 *
 * @returns {number} 进程退出码，由文件末尾赋给 process.exitCode（而不是直接 exit，
 *          这样 stdout 缓冲区仍能正常刷出）。
 */
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
      // 跳过已消费的目录参数，避免它被当作未知选项。
      index += 1;
    } else {
      process.stderr.write(`check-sensitive: unknown option ${JSON.stringify(arg)} (try --help)\n`);
      return 2;
    }
  }

  const absoluteRoot = resolveRoot(root);
  const { files, skipped } = collectFiles(absoluteRoot);
  const findings = files.flatMap((file) => scanFile(absoluteRoot, file));

  // JSON 模式供 CI 或上层脚本解析：ok 字段是 findings.length 的派生值，便于直接断言。
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

  // 干净路径只输出一行：保持 CI 日志简洁，同时把扫描规模一并给出，便于判断是否扫错目录。
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
  // 末尾附上修复指引：这是检查的主要出口，失败时应该直接告诉人怎么改，而不只是报错。
  process.stdout.write(
    `\ncheck-sensitive: ${findings.length} finding(s) in ${files.length} files. `
    + 'Replace personal/machine paths with placeholders (<REPO>, %LOCALAPPDATA%) or '
    + 'remove credentials before committing.\n',
  );
  return 1;
}

process.exitCode = main();
