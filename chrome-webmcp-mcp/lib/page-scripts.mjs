/**
 * 通过 Runtime.evaluate 注入页面的脚本（page-side scripts）。
 *
 * 职责：
 * - 用模板字符串生成四段自执行脚本：snapshot（感知）、click（点击）、type（输入/选择）、
 *   ready（导航后就绪轮询）。脚本本身保持 ES5 风格（var/function），以兼容旧引擎。
 * - snapshot 把可见且可交互的元素序列化为 `[12]<button type="submit">Sign in</button>`
 *   这样的紧凑文本，同时把真实元素引用登记到索引表，供后续动作按索引寻址。
 *
 * 关键不变量：
 * - 所有脚本都在 lib/pages.mjs 创建的 isolated world 中执行，因此引用表只存在于
 *   globalThis.__dshBrowserUse，绝不触碰页面的全局变量、DOM 属性或样式。
 * - 每张快照都会重建 refs 表并递增 revision，而 nextIndex 只增不减、跨快照不复用；
 *   因此旧快照的索引在新快照中查不到，会显式返回 REF_NOT_FOUND，而不会静默指向
 *   另一个元素（把"错误点击"变成可发现的失败）。
 * - 导航/重载会销毁 isolated world，随之丢失 refs 与 nextIndex；调用方必须重新拍快照。
 * - 脚本返回的失败结果统一使用 ok:false + reason 字段，由 pages.mjs 的 actionError
 *   映射为 REF_NOT_FOUND / REF_STALE / ELEMENT_NOT_VISIBLE / ELEMENT_COVERED /
 *   NOT_EDITABLE / OPTION_NOT_FOUND 等错误码。
 *
 * 维护约定：
 * - 模板字符串内部不要添加注释：这些字符会被真正发送到页面，既增加注入体积，也可能
 *   进入页面日志。需要解释逻辑时，写在构建函数或常量处（即本文件模板之外）。
 * - MARKERS 注释同时给测试用的 fake CDP fixture 提供稳定识别标记（见 test/fake-cdp.mjs），
 *   不必解析 JavaScript 就能判断收到的是哪段脚本；这些标记不能随意改动。
 */

/**
 * 每段注入脚本开头的标记注释。
 *
 * 用途：让测试里的 fake CDP 在没有真正执行页面的情况下，仅凭字符串前缀就能识别
 * 收到的表达式属于哪种动作。因此这些字面量是测试契约的一部分，不能随意改写。
 */
export const MARKERS = {
  snapshot: '/*__DSH_BROWSER_SNAPSHOT__*/',
  click: '/*__DSH_BROWSER_CLICK__*/',
  type: '/*__DSH_BROWSER_TYPE__*/',
  ready: '/*__DSH_BROWSER_READY__*/',
};

/**
 * 值得展示给 agent 的交互元素选择器（含 ARIA 控件）。
 *
 * 覆盖两类：原生可交互元素（链接、按钮、表单控件、summary、可编辑区域）与通过
 * role 实现的控件（按钮、菜单项、选项卡、combobox 等）。tabindex="-1" 被排除，
 * 因为它只允许程序聚焦，不参与正常的键盘交互顺序，通常也不代表用户操作入口。
 */
const INTERACTIVE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="combobox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * 索引上界（2^31-1）：与构建侧一致地拒绝负数/超范围索引，防止把异常数值直接
 * 拼进注入脚本。
 */
const INT32_MAX = 2147483647;

/**
 * 把元素数量上限收敛到合理区间；broker 侧已做过校验，这里是第二道防线。
 *
 * 非法值（NaN、<=0）回退到默认 200；合法值向下取整并封顶 2000，避免一次快照
 * 生成超长文本撑爆模型上下文。
 *
 * @param {number|string|undefined} value 原始上限。
 * @returns {number} 1~2000 之间的整数，缺省 200。
 */
export function clampMaxElements(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 200;
  return Math.min(Math.floor(n), 2000);
}

/**
 * 构建"感知"脚本：输出带编号、token 友好的文本列表，例如
 * `[12]<button type="submit">Sign in</button>`。
 *
 * 脚本内部要点（为保持注入体积，说明只写在这里，不写进模板字符串）：
 * - 索引表：globalThis.__dshBrowserUse = {refs: Map<index, Element>, nextIndex, revision}。
 *   首次执行时用 defineProperty 定义为不可枚举，避免污染页面的 for...in / 枚举输出；
 *   若定义失败（极端环境）退化为普通属性赋值。
 * - 索引单调递增：nextIndex 跨快照只增不减，每张快照把 refs 换成一个新 Map 并让
 *   revision +1。因此上一张快照的索引在新 Map 中不存在，动作时会得到 REF_NOT_FOUND；
 *   即使 DOM 复用，也不会误点到"恰好排在同一位置"的另一个元素。
 * - 遍历方式：以 document 为根做广度优先，遇到带 shadowRoot 的元素就把该 shadow
 *   root 追加进队列，因此开放 shadow DOM 中的控件也会被收录；iframe 内部文档不在
 *   范围内（见 README 已知限制）。
 * - 可见性过滤：要求已连接、非 hidden input、不在 [inert] 子树内、aria-hidden 不为
 *   true，并优先用 checkVisibility（含 opacity/visibility/content-visibility）判断；
 *   旧引擎回退到 computedStyle 检查；最后要求包围盒至少 1x1 像素。
 * - 名称推断顺序：aria-label -> aria-labelledby 指向元素的文本 -> labels 关联的
 *   <label> -> input 的 value/alt/placeholder -> textarea 的 placeholder ->
 *   title -> 文本内容。取到后截断再转义，避免超长文本和 HTML 注入。
 * - 属性序列化：只输出对决策有帮助的属性（role/type/name/placeholder/value/
 *   options/href/target/tabindex 以及 checked/disabled/readonly/required/
 *   contenteditable 与 aria-expanded/checked/pressed/selected）。单个属性值截断
 *   到 200 字符，select 的候选项最多列 30 个。
 * - 敏感信息：password 类型的 input 绝不输出 value（只标记 type="password"），
 *   防止把凭据送进模型上下文。
 * - 数量控制：达到 LIMIT 后停止收集并置 truncated=true，total 仍是候选元素总数，
 *   elements 是本张快照实际输出的行数，便于调用方判断是否需要缩小范围。
 *
 * @param {{maxElements?: number}} [options] maxElements 为元素行数上限（经 clampMaxElements 收敛）。
 * @returns {string} 一段立即执行的表达式（带 MARKERS.snapshot 前缀）。
 *   求值结果为 {snapshotId, url, title, total, elements, truncated, text}，
 *   其中 text 以 \n 分隔各行。
 */
export function snapshotExpression({ maxElements = 200 } = {}) {
  const limit = clampMaxElements(maxElements);
  return `${MARKERS.snapshot}(() => {
  var KEY = '__dshBrowserUse';
  var LIMIT = ${limit};
  var SEL = ${JSON.stringify(INTERACTIVE_SELECTOR)};
  var state = globalThis[KEY];
  if (!state) {
    state = { refs: new Map(), nextIndex: 0, revision: 0 };
    try {
      Object.defineProperty(globalThis, KEY, { value: state, enumerable: false, configurable: true });
    } catch (error) {
      globalThis[KEY] = state;
    }
  }
  state.revision += 1;
  var refs = new Map();
  state.refs = refs;

  var norm = function (value) {
    return String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
  };
  var esc = function (value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  };
  var trunc = function (value, max) {
    var text = norm(value);
    return text.length > max ? text.slice(0, max) + '...' : text;
  };

  // 广度优先遍历：先遍历 document，再遍历每个开放的 shadow root。
  // 关键点：shadow 宿主**不需要**自身命中 SEL。CSS 没有「带 shadow root」的选择器，
  // 所以每个 root 里对全部元素扫一遍收集 shadowRoot；否则 <my-widget>、普通 <div>
  // 容器、tabindex="-1" 宿主里的控件会对 agent 静默不可见（只有宿主恰好可交互时才
  // 能穿透，是最容易被误当成「页面上没有该按钮」的坑）。
  // closed shadow root 的 shadowRoot 为 null，无法穿透；iframe 文档不在范围内
  // （见 README 的已知限制）。
  var roots = [document];
  var seen = new Set();
  var candidates = [];
  for (var ri = 0; ri < roots.length; ri += 1) {
    var root = roots[ri];
    var nodes = [];
    try {
      nodes = root.querySelectorAll(SEL);
    } catch (error) {
      nodes = [];
    }
    for (var ni = 0; ni < nodes.length; ni += 1) {
      var node = nodes[ni];
      if (!seen.has(node)) {
        seen.add(node);
        candidates.push(node);
      }
    }
    var all = [];
    try {
      all = root.querySelectorAll('*');
    } catch (error) {
      all = [];
    }
    for (var si = 0; si < all.length; si += 1) {
      if (all[si].shadowRoot) roots.push(all[si].shadowRoot);
    }
  }

  var visible = function (el) {
    try {
      if (!el.isConnected) return false;
      if (el.tagName === 'INPUT' && el.type === 'hidden') return false;
      if (el.closest && el.closest('[inert]')) return false;
      if (el.getAttribute('aria-hidden') === 'true') return false;
      if (typeof el.checkVisibility === 'function') {
        var shown = el.checkVisibility({
          checkOpacity: true,
          checkVisibilityCSS: true,
          opacityProperty: true,
          visibilityProperty: true,
          contentVisibilityAuto: true,
        });
        if (!shown) return false;
      } else {
        var style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          return false;
        }
      }
      var rect = el.getBoundingClientRect();
      return rect.width >= 1 && rect.height >= 1;
    } catch (error) {
      return false;
    }
  };

  var labelOf = function (el) {
    var ariaLabel = norm(el.getAttribute('aria-label'));
    if (ariaLabel) return ariaLabel;
    var labelledBy = norm(el.getAttribute('aria-labelledby'));
    if (labelledBy) {
      var labelledText = labelledBy.split(' ').map(function (id) {
        var target = document.getElementById(id);
        return target ? target.textContent : '';
      }).join(' ');
      if (norm(labelledText)) return norm(labelledText);
    }
    if (el.labels && el.labels.length) {
      var labelText = Array.prototype.map.call(el.labels, function (label) {
        return label.textContent;
      }).join(' ');
      if (norm(labelText)) return norm(labelText);
    }
    var tag = el.tagName.toLowerCase();
    var type = norm(el.type).toLowerCase();
    if (tag === 'input') {
      if ((type === 'submit' || type === 'button' || type === 'reset') && norm(el.value)) {
        return norm(el.value);
      }
      if (type === 'image' && norm(el.alt)) return norm(el.alt);
      if (norm(el.placeholder)) return norm(el.placeholder);
    }
    if (tag === 'textarea' && norm(el.placeholder)) return norm(el.placeholder);
    var title = norm(el.getAttribute('title'));
    if (title) return title;
    return norm(el.innerText || el.textContent || '');
  };

  var lines = [];
  var truncated = false;
  for (var ci = 0; ci < candidates.length; ci += 1) {
    if (lines.length >= LIMIT) {
      truncated = true;
      break;
    }
    var el = candidates[ci];
    if (!visible(el)) continue;

    var index = state.nextIndex;
    state.nextIndex += 1;
    refs.set(index, el);

    var tag = el.tagName.toLowerCase();
    var attrs = [];
    var attr = function (name, value) {
      if (value === undefined || value === null || value === '') return;
      attrs.push(name + '="' + esc(trunc(value, 200)) + '"');
    };
    attr('role', norm(el.getAttribute('role')));
    if (tag === 'input') {
      var inputType = norm(el.type).toLowerCase();
      attr('type', inputType);
      attr('name', norm(el.getAttribute('name')));
      attr('placeholder', norm(el.getAttribute('placeholder')));
      if (inputType === 'checkbox' || inputType === 'radio') {
        if (el.checked) attrs.push('checked');
      } else if (inputType !== 'password' && norm(el.value)) {
        attr('value', el.value);
      }
    } else if (tag === 'textarea') {
      attr('name', norm(el.getAttribute('name')));
      attr('placeholder', norm(el.getAttribute('placeholder')));
      if (norm(el.value)) attr('value', el.value);
    } else if (tag === 'select') {
      attr('name', norm(el.getAttribute('name')));
      attr('value', norm(el.value));
      var optionLabels = Array.prototype.map.call(el.options || [], function (option) {
        return norm(option.label || option.textContent);
      });
      if (optionLabels.length) attr('options', optionLabels.slice(0, 30).join(' | '));
    } else if (tag === 'a') {
      attr('href', el.getAttribute('href'));
      attr('target', el.getAttribute('target'));
    } else if (tag === 'button') {
      attr('type', norm(el.type));
    }
    if (el.hasAttribute('tabindex')) attr('tabindex', el.getAttribute('tabindex'));
    if (el.disabled === true) attrs.push('disabled');
    if (el.readOnly === true) attrs.push('readonly');
    if (el.required === true) attrs.push('required');
    if (el.isContentEditable) attrs.push('contenteditable="true"');
    var ariaExpanded = el.getAttribute('aria-expanded');
    if (ariaExpanded !== null) attr('aria-expanded', ariaExpanded);
    var ariaChecked = el.getAttribute('aria-checked');
    if (ariaChecked !== null) attr('aria-checked', ariaChecked);
    var ariaPressed = el.getAttribute('aria-pressed');
    if (ariaPressed !== null) attr('aria-pressed', ariaPressed);
    var ariaSelected = el.getAttribute('aria-selected');
    if (ariaSelected !== null) attr('aria-selected', ariaSelected);

    var opening = '<' + tag + attrs.map(function (part) { return ' ' + part; }).join('');
    var isField = tag === 'input' || tag === 'select' || tag === 'textarea';
    var line = isField
      ? '[' + index + ']' + opening + ' />'
      : '[' + index + ']' + opening + '>' + esc(trunc(labelOf(el), 120)) + '</' + tag + '>';
    lines.push(line);
  }

  return {
    snapshotId: state.revision,
    url: location.href,
    title: document.title,
    total: candidates.length,
    elements: lines.length,
    truncated: truncated,
    text: lines.join('\\n'),
  };
})()`;
}

/**
 * 构建"把索引换算成视口点击坐标"的脚本。
 *
 * 脚本流程与原因（说明放在模板外，避免增加注入体积）：
 * 1. 取引用：state.refs.get(INDEX)。没有状态 -> REF_NOT_FOUND（尚未拍过快照）；
 *    索引不在当前 Map -> REF_NOT_FOUND（来自旧快照）；元素已脱离文档 -> REF_STALE。
 * 2. 滚动到视口中心：先尝试 behavior:'instant' 的中心对齐；旧引擎不认识该参数时
 *    回退为无参 scrollIntoView，保证至少滚动到可见位置。
 * 3. 等待两帧 + 150ms 兜底：滚动引发的滚动监听/懒加载/动画可能在下一帧才完成布局，
 *    只等一帧仍可能拿到旧坐标；setTimeout 兜底防止后台标签页不触发 rAF 时永久挂起。
 * 4. 命中测试：取元素包围盒中心点，若中心点在视口外则判 ELEMENT_NOT_VISIBLE；
 *    否则用 document.elementFromPoint 找出最顶层的接收者。命中点位于 shadow DOM 内时，
 *    需要逐层用 shadowRoot.elementFromPoint 向下穿透（elementFromPoint 不会自动进入
 *    shadow 树），直到不再变化。
 * 5. 遮挡判定：从命中节点沿 parentNode 向上走，穿过 shadow 边界时改走
 *    getRootNode().host，检查能否到达目标元素。能到达说明命中的是目标自身或其子孙
 *    （例如按钮里的 <span>），允许点击；不能到达则说明被别的元素盖住，判
 *    ELEMENT_COVERED 并回报遮挡元素的标签名，便于模型换策略。
 *
 * @param {{index: number}} options index 为快照中的元素索引。
 * @returns {string} 立即执行的 async 表达式（带 MARKERS.click 前缀）。
 *   成功时解析为 {ok:true, x, y, tag, label}；失败时为 {ok:false, reason, detail}。
 * @throws {RangeError} index 不是 0~INT32_MAX 之间的整数时抛出（构建阶段即失败，
 *   不把非法值拼进脚本）。
 */
export function clickExpression({ index }) {
  const ref = Number(index);
  if (!Number.isInteger(ref) || ref < 0 || ref > INT32_MAX) {
    throw new RangeError('index must be a non-negative integer');
  }
  return `${MARKERS.click}(async () => {
  var KEY = '__dshBrowserUse';
  var INDEX = ${ref};
  var state = globalThis[KEY];
  if (!state || !state.refs) {
    return { ok: false, reason: 'REF_NOT_FOUND', detail: 'no snapshot has been taken on this page' };
  }
  var el = state.refs.get(INDEX);
  if (!el) {
    return {
      ok: false,
      reason: 'REF_NOT_FOUND',
      detail: 'index ' + INDEX + ' is not part of the latest snapshot',
    };
  }
  if (!el.isConnected) {
    return { ok: false, reason: 'REF_STALE', detail: 'the element left the DOM' };
  }
  try {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  } catch (error) {
    /* 旧引擎不支持 behavior: 'instant' 时，回退到普通的 scrollIntoView */
    try { el.scrollIntoView(); } catch (ignored) {}
  }
  await new Promise(function (resolve) {
    var done = false;
    var finish = function () {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(function () {
      requestAnimationFrame(finish);
    });
    setTimeout(finish, 150);
  });
  var rect = el.getBoundingClientRect();
  if (!(rect.width > 0 && rect.height > 0)) {
    return { ok: false, reason: 'ELEMENT_NOT_VISIBLE', detail: 'the element has no box' };
  }
  var x = rect.left + rect.width / 2;
  var y = rect.top + rect.height / 2;
  if (!(x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight)) {
    return { ok: false, reason: 'ELEMENT_NOT_VISIBLE', detail: 'the element is outside the viewport' };
  }
  var hit = document.elementFromPoint(x, y);
  while (hit && hit.shadowRoot) {
    var inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  var inside = function (ancestor, node) {
    var current = node;
    while (current) {
      if (current === ancestor) return true;
      if (current.parentNode) {
        current = current.parentNode;
      } else {
        var root = current.getRootNode ? current.getRootNode() : null;
        current = root && root.host ? root.host : null;
      }
    }
    return false;
  };
  if (hit && !inside(el, hit)) {
    var hitTag = hit.tagName ? hit.tagName.toLowerCase() : 'unknown';
    return {
      ok: false,
      reason: 'ELEMENT_COVERED',
      detail: '<' + hitTag + '> is on top of the target element',
    };
  }
  return {
    ok: true,
    x: x,
    y: y,
    tag: el.tagName.toLowerCase(),
    label: String(el.innerText || el.getAttribute('aria-label') || el.value || '')
      .replace(/\\s+/g, ' ')
      .trim()
      .slice(0, 120),
  };
})()`;
}

/**
 * 构建"聚焦文本框或选中下拉选项"的脚本。脚本本身不输入文本：真正的文本由 broker
 * 随后通过 Input.insertText 发送，框架才能看到与真人输入一致的事件序列。
 *
 * 脚本流程与边界条件：
 * 1. 引用校验与 click 一致：无状态/索引不存在 -> REF_NOT_FOUND，已脱离文档 -> REF_STALE。
 * 2. select 分支：按 "value 完全相等 -> label 忽略大小写完全相等 -> label 包含匹配"
 *    的优先级挑选选项；都找不到时返回 OPTION_NOT_FOUND，并附带全部候选 label，让模型
 *    能看到可选项后重试。
 *    选中时优先调用 HTMLSelectElement.prototype 上 value 的原生 setter，而不是直接赋值：
 *    React 等框架会在元素实例上覆写 value 属性，直接赋值可能绕过框架的状态跟踪，
 *    原生 setter + 手写 input/change 事件能让框架正确感知变化。原生 setter 不可用时
 *    回退为普通赋值，并仍在 try/catch 中兜底。
 * 3. 可编辑性校验：只接受 input / textarea / contenteditable；disabled 或 readOnly
 *    一律返回 NOT_EDITABLE（附带具体原因），避免"看似输入成功、实际页面无变化"。
 * 4. 聚焦与光标：滚动到中心后 focus({preventScroll:true}) 防止滚动位置被再次改变；
 *    clear=false 时把光标移到已有内容末尾（input/textarea 用 setSelectionRange，
 *    contenteditable 用 Range 折叠到末尾），使新文本追加而不是覆盖。该定位属于
 *    尽力而为，失败可忽略（后续输入仍会进入当前焦点）。
 *
 * @param {{index: number, text: string, clear?: boolean}} options
 *   text 会经 JSON.stringify 转成字面量，因此引号、换行、反斜杠都能安全注入；
 *   clear 表示是否由上层先全选覆盖。
 * @returns {string} 立即执行的表达式（带 MARKERS.type 前缀）。
 *   select 分支解析为 {ok:true, mode:'selected', value, label}；
 *   文本分支为 {ok:true, mode:'typed', tag, label}；失败为 {ok:false, reason, detail, options?}。
 * @throws {RangeError} index 不是 0~INT32_MAX 之间的整数时抛出。
 */
export function typeExpression({ index, text, clear = true }) {
  const ref = Number(index);
  if (!Number.isInteger(ref) || ref < 0 || ref > INT32_MAX) {
    throw new RangeError('index must be a non-negative integer');
  }
  const literal = JSON.stringify(String(text ?? ''));
  return `${MARKERS.type}(() => {
  var KEY = '__dshBrowserUse';
  var INDEX = ${ref};
  var TEXT = ${literal};
  var CLEAR = ${clear === true ? 'true' : 'false'};
  var state = globalThis[KEY];
  if (!state || !state.refs) {
    return { ok: false, reason: 'REF_NOT_FOUND', detail: 'no snapshot has been taken on this page' };
  }
  var el = state.refs.get(INDEX);
  if (!el) {
    return {
      ok: false,
      reason: 'REF_NOT_FOUND',
      detail: 'index ' + INDEX + ' is not part of the latest snapshot',
    };
  }
  if (!el.isConnected) {
    return { ok: false, reason: 'REF_STALE', detail: 'the element left the DOM' };
  }
  var tag = el.tagName.toLowerCase();
  if (tag === 'select') {
    var options = Array.prototype.slice.call(el.options || []);
    var wanted = String(TEXT).trim();
    var lower = wanted.toLowerCase();
    var optionLabel = function (option) {
      return String(option.label || option.textContent || '').trim();
    };
    var match =
      options.filter(function (option) { return String(option.value) === wanted; })[0] ||
      options.filter(function (option) { return optionLabel(option).toLowerCase() === lower; })[0] ||
      options.filter(function (option) { return optionLabel(option).toLowerCase().indexOf(lower) !== -1; })[0];
    if (!match) {
      return {
        ok: false,
        reason: 'OPTION_NOT_FOUND',
        options: options.map(optionLabel),
        detail: 'no option matches "' + wanted + '"',
      };
    }
    try {
      var descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
      if (descriptor && descriptor.set) descriptor.set.call(el, match.value);
      else el.value = match.value;
    } catch (error) {
      el.value = match.value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, mode: 'selected', value: el.value, label: optionLabel(match) };
  }
  var editable = tag === 'input' || tag === 'textarea' || el.isContentEditable;
  if (!editable) {
    return { ok: false, reason: 'NOT_EDITABLE', detail: '<' + tag + '> is not a text field' };
  }
  if (el.disabled === true) {
    return { ok: false, reason: 'NOT_EDITABLE', detail: 'the field is disabled' };
  }
  if ((tag === 'input' || tag === 'textarea') && el.readOnly === true) {
    return { ok: false, reason: 'NOT_EDITABLE', detail: 'the field is read-only' };
  }
  try {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  } catch (error) {
    try { el.scrollIntoView(); } catch (ignored) {}
  }
  el.focus({ preventScroll: true });
  if (!CLEAR) {
    try {
      if (tag === 'input' || tag === 'textarea') {
        var length = String(el.value == null ? '' : el.value).length;
        el.setSelectionRange(length, length);
      } else {
        var selection = getSelection();
        selection.removeAllRanges();
        var range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        selection.addRange(range);
      }
    } catch (error) {
      /* 光标定位属于尽力而为，失败不影响输入本身 */
    }
  }
  return {
    ok: true,
    mode: 'typed',
    tag: tag,
    label: String(el.getAttribute('aria-label') || el.getAttribute('placeholder') || '')
      .replace(/\\s+/g, ' ')
      .trim()
      .slice(0, 120),
  };
})()`;
}

/**
 * 构建导航后用于判断新文档是否加载完成的脚本。
 *
 * 只读 document.readyState，因此开销极低，可被 navigate 以 120ms 间隔轮询；
 * 由于脚本在新的 isolated world 中求值，其返回值反映的是"当前文档"的状态，
 * 不需要额外记录导航前的状态。
 *
 * @returns {string} 立即执行的表达式（带 MARKERS.ready 前缀），求值为
 *   'loading' | 'interactive' | 'complete'。
 */
export function readyExpression() {
  return `${MARKERS.ready}document.readyState`;
}
