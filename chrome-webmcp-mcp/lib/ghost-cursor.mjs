/**
 * "幽灵光标"（ghost cursor）：在页面里画一个**看得见的模拟鼠标**，让 `click` /
 * `type_text` 的移动与点击有可视反馈。
 *
 * 为什么要它：CDP 的 Input.dispatchMouseEvent 只把事件投递给渲染器，不会移动操作系统的
 * 真实指针，所以屏幕上看不到任何"鼠标正在点这里"的迹象。调试/演示时这很难跟。
 * 这里注入一层覆盖层：一个箭头指针 + 点击涟漪，纯 DOM/CSS 绘制，不参与命中测试。
 *
 * 关键不变量：
 * - 覆盖层 `pointer-events:none !important`、`z-index` 拉满，绝不改变页面行为，也绝不
 *   影响 `elementFromPoint` 的命中判断（否则 click 的 ELEMENT_COVERED 检查会误报）。
 * - 每个表达式都可独立执行（每次 evaluate 是一个新的隔离上下文，不能共享闭包）：
 *   状态只存在 DOM 上（`data-dsh-gc-x/y` 记录当前指针位置），因此跨 evaluate、跨
 *   isolated world、跨页面脚本重载都能接着上一次的位置继续移动。
 * - 移动是"等动画真的走完再返回"（awaitPromise + Promise）：调用方据此才知道什么时候
 *   可以安全地派发真实鼠标事件，视觉与事件顺序严格一致。
 * - 后台标签页 / 隐藏文档不跑动画（rAF 会被节流甚至不触发），直接落位并立即返回，
 *   避免把一次点击卡到超时；动画另有 setTimeout 兜底，保证 evaluate 一定收敛。
 * - 覆盖层是"装饰"：调用方必须把它的失败当噪声（见 lib/pages.mjs 的 #cursor* 包装），
 *   任何异常都不能让真正的点击失败。
 *
 * 使用方：`lib/pages.mjs`（click / type_text）。测试用的 fake CDP 通过 MARKERS 前缀
 * 识别这两段脚本。
 */
import { MARKERS } from './page-scripts.mjs';

/** 覆盖层根节点 id。 */
export const CURSOR_ROOT_ID = '__dsh_ghost_cursor__';

/**
 * 覆盖层的内嵌样式。
 *
 * - 根节点：`position:fixed` + 零尺寸，`transform` 承载指针位置（合成层动画，不触发
 *   页面重排）；`contain:layout style` 防止这层意外影响外部布局。
 * - 箭头：22×22 的 SVG 指针，深灰填充 + 白色描边 + 投影，浅色/深色页面上都看得见；
 *   左上角偏移 1px，让**箭尖正好落在根节点原点**，即真实鼠标事件的坐标点。
 * - 涟漪：点击点上的圆环，`dsh-gc-ping` 从 0.45 放大到 2.6 倍并淡出。
 * - 按下反馈：`dsh-gc-pressed` 让箭头轻微缩小回弹，模拟按下手感。
 */
const CURSOR_CSS = [
  '#__dsh_ghost_cursor__{position:fixed;left:0;top:0;width:0;height:0;margin:0;padding:0;',
  'border:0;background:none;pointer-events:none!important;z-index:2147483647;',
  'transform:translate3d(-9999px,-9999px,0);will-change:transform;contain:layout style;}',
  '#__dsh_ghost_cursor__ .dsh-gc-arrow{position:absolute;left:-1px;top:-1px;width:22px;height:22px;',
  'transform-origin:1px 1px;pointer-events:none!important;',
  'filter:drop-shadow(0 1px 2px rgba(0,0,0,.45));transition:none;}',
  '#__dsh_ghost_cursor__ .dsh-gc-arrow path{fill:#111827;stroke:#fff;stroke-width:1.2;stroke-linejoin:round;}',
  '#__dsh_ghost_cursor__ .dsh-gc-ring{position:absolute;left:0;top:0;width:14px;height:14px;',
  'margin:-7px 0 0 -7px;border-radius:50%;border:2px solid rgba(99,102,241,.95);',
  'box-shadow:inset 0 0 0 1px rgba(255,255,255,.35);opacity:0;pointer-events:none!important;',
  'animation:dsh-gc-ping 520ms cubic-bezier(.16,.84,.44,1) forwards;}',
  '@keyframes dsh-gc-ping{0%{opacity:.95;transform:scale(.45);}70%{opacity:.45;}100%{opacity:0;transform:scale(2.6);}}',
  '#__dsh_ghost_cursor__.dsh-gc-pressed .dsh-gc-arrow{animation:dsh-gc-press 200ms ease-out;}',
  '@keyframes dsh-gc-press{0%{transform:scale(1);}45%{transform:scale(.8);}100%{transform:scale(1);}}',
].join('');

/**
 * 箭头指针的 SVG。箭尖位于 (1,1)，配合 CSS 的 -1px 偏移把"视觉箭尖"对齐到坐标原点；
 * 前半段是箭头轮廓，后半段延伸到尾部，形状与系统指针一致（斜三角 + 尾巴）。
 */
const CURSOR_SVG =
  '<svg class="dsh-gc-arrow" viewBox="0 0 22 22" width="22" height="22" aria-hidden="true" focusable="false">' +
  '<path d="M1 1 L1 16.2 L5.3 12 L8.2 18.2 L11 16.9 L8.1 10.8 L13.7 10.6 Z"></path></svg>';

/**
 * 把坐标收敛成有限数值，避免把 NaN/Infinity 拼进脚本（会变成非法表达式）。
 *
 * @param {number} value 原始坐标（视口 CSS 像素）。
 * @returns {number} 有限数值；非法输入按 0 处理。
 */
function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 把动画时长收敛到 0~2000 毫秒的整数（0 表示瞬间落位）。
 *
 * @param {number} value 期望时长（毫秒）。
 * @returns {number} 合法时长。
 */
function duration(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), 2000);
}

/**
 * 生成"确保覆盖层已挂载"的注入代码片段（两个表达式共用）。
 *
 * 只在 DOM 上留存状态：`data-dsh-gc-x/y` 是当前指针位置，`#__dsh_ghost_cursor__` 是
 * 根节点本身。这样下一次 evaluate（哪怕换了 isolated world）也能接着上次的位置移动。
 *
 * @returns {string} ES5 风格代码（含 ensure / place 两个函数与 CURSOR_CSS/SVG 常量）。
 */
function sharedPrelude() {
  return [
    `var ROOT_ID = ${JSON.stringify(CURSOR_ROOT_ID)};`,
    `var STYLE_ID = '__dsh_ghost_cursor_style__';`,
    `var CSS = ${JSON.stringify(CURSOR_CSS)};`,
    `var SVG = ${JSON.stringify(CURSOR_SVG)};`,
    `var ensure = function () {`,
    `  var style = document.getElementById(STYLE_ID);`,
    `  if (!style) {`,
    `    style = document.createElement('style');`,
    `    style.id = STYLE_ID;`,
    `    style.textContent = CSS;`,
    `    (document.head || document.documentElement).appendChild(style);`,
    `  }`,
    `  var root = document.getElementById(ROOT_ID);`,
    `  if (root) return root;`,
    `  root = document.createElement('div');`,
    `  root.id = ROOT_ID;`,
    `  root.setAttribute('aria-hidden', 'true');`,
    `  root.innerHTML = SVG;`,
    `  (document.body || document.documentElement).appendChild(root);`,
    `  return root;`,
    `};`,
    `var place = function (root, px, py) {`,
    `  root.style.transform = 'translate3d(' + px.toFixed(2) + 'px,' + py.toFixed(2) + 'px,0)';`,
    `  root.setAttribute('data-dsh-gc-x', px.toFixed(2));`,
    `  root.setAttribute('data-dsh-gc-y', py.toFixed(2));`,
    `};`,
    `var read = function (root, name, fallback) {`,
    `  var raw = Number(root.getAttribute(name));`,
    `  return isFinite(raw) ? raw : fallback;`,
    `};`,
    `var ease = function (t) { return 1 - Math.pow(1 - t, 3); };`,
    `var now = function () {`,
    `  return (window.performance && performance.now) ? performance.now() : Date.now();`,
    `};`,
  ].join('\n  ');
}

/**
 * 构建"把模拟鼠标移动到视口坐标"的表达式。
 *
 * 首次出现直接落位（不从屏幕角落飞进来，避免误解）；之后按缓动曲线移动，动画结束
 * 才 resolve，调用方据此再派发真实鼠标事件。`document.hidden` 为真或时长为 0 时立即落位。
 *
 * @param {{x: number, y: number, durationMs?: number}} options
 *   x/y 为视口 CSS 像素（与 CDP 鼠标事件同一坐标系）；durationMs 默认 0 表示瞬间落位。
 * @returns {string} 带 MARKERS.cursorMove 前缀的表达式，求值结果为
 *   `{ok, x, y, moved, animated, durationMs}`。
 */
export function cursorMoveExpression({ x, y, durationMs = 0 } = {}) {
  const X = finite(x);
  const Y = finite(y);
  const DUR = duration(durationMs);
  return `${MARKERS.cursorMove}(async () => {
  var X = ${X};
  var Y = ${Y};
  var DUR = ${DUR};
  ${sharedPrelude()}
  var root = ensure();
  var fresh = root.getAttribute('data-dsh-gc-x') === null;
  if (fresh || DUR <= 0 || document.hidden) {
    place(root, X, Y);
    return { ok: true, x: X, y: Y, moved: !fresh, animated: false, durationMs: fresh ? 0 : DUR };
  }
  var fromX = read(root, 'data-dsh-gc-x', X);
  var fromY = read(root, 'data-dsh-gc-y', Y);
  var startedAt = now();
  await new Promise(function (resolve) {
    var done = false;
    var finish = function () {
      if (done) return;
      done = true;
      place(root, X, Y);
      resolve();
    };
    var step = function () {
      var progress = Math.min(1, (now() - startedAt) / DUR);
      if (progress >= 1) {
        finish();
        return;
      }
      var eased = ease(progress);
      place(root, fromX + (X - fromX) * eased, fromY + (Y - fromY) * eased);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    setTimeout(finish, DUR + 80);
  });
  return { ok: true, x: X, y: Y, moved: true, animated: true, durationMs: DUR };
})()`;
}

/**
 * 构建"在点击点播放涟漪 + 按下反馈"的表达式。
 *
 * 与移动不同，这里**不等动画**（点击已经发生，涟漪只是回放），表达式立即返回，
 * 不会给动作增加延迟。
 *
 * @param {{x: number, y: number, count?: number}} options
 *   count 为点击次数（双击/三击时依次错开播放多个涟漪）。
 * @returns {string} 带 MARKERS.cursorTap 前缀的表达式，求值结果为 `{ok, x, y, rings}`。
 */
export function cursorTapExpression({ x, y, count = 1 } = {}) {
  const X = finite(x);
  const Y = finite(y);
  const rings = Math.max(1, Math.min(3, Math.floor(Number(count) || 1)));
  return `${MARKERS.cursorTap}(() => {
  var X = ${X};
  var Y = ${Y};
  var RINGS = ${rings};
  ${sharedPrelude()}
  var root = ensure();
  place(root, X, Y);
  var index;
  for (index = 0; index < RINGS; index += 1) {
    (function (delay) {
      var ring = document.createElement('div');
      ring.className = 'dsh-gc-ring';
      ring.style.animationDelay = delay + 'ms';
      root.appendChild(ring);
      setTimeout(function () {
        if (ring.parentNode) ring.parentNode.removeChild(ring);
      }, 700 + delay);
    })(index * 90);
  }
  root.classList.add('dsh-gc-pressed');
  setTimeout(function () { root.classList.remove('dsh-gc-pressed'); }, 220);
  return { ok: true, x: X, y: Y, rings: RINGS };
})()`;
}
