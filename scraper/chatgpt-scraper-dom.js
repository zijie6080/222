/**
 * ChatGPT 对话抓取脚本（DOM 备用版）
 * ------------------------------------------------------------------
 * 仅在 API 版（chatgpt-scraper.js）失效时使用。
 *
 * 用法：
 *   1. 登录 https://chatgpt.com，确保侧边栏展开
 *   2. F12 打开 Console，粘贴整个脚本运行
 *   3. 脚本会自动：滚动侧边栏加载全部对话 → 逐个点开对话 →
 *      向上滚动加载全部历史消息 → 抓取 → 最后下载 conversations.json
 *
 * 局限（相比 API 版）：
 *   - 拿不到每条消息的时间戳（createTime 为 null）
 *   - 拿到的是渲染后的纯文本，markdown 结构（如代码块围栏）会丢失
 *   - 依赖 data-message-author-role 等 DOM 属性，页面改版可能失效
 */
(async () => {
  // ======================= 可调配置 =======================
  const CONFIG = {
    maxConversations: Infinity, // 最多抓取多少个对话
    scrollDelayMs: 700,         // 每次滚动后的等待时间
    afterOpenDelayMs: 1500,     // 点开一个对话后的等待时间
    stableRounds: 3,            // 连续 N 轮内容无变化视为加载完
    outputFilename: 'conversations.json',
  };
  // ========================================================

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log('%c[chatgpt-export:dom]', 'color:#10a37f;font-weight:bold', ...a);
  const warn = (...a) => console.warn('[chatgpt-export:dom]', ...a);

  // 从某元素向上找最近的可滚动容器
  function findScrollable(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      const style = getComputedStyle(cur);
      if (cur.scrollHeight > cur.clientHeight + 10 && /(auto|scroll)/.test(style.overflowY)) return cur;
      cur = cur.parentElement;
    }
    return document.scrollingElement;
  }

  const sidebarLinkSelector = 'nav a[href^="/c/"], aside a[href^="/c/"], #history a[href^="/c/"]';

  // ---- 1. 滚动侧边栏，加载全部对话链接 ----
  async function loadAllSidebarLinks() {
    let first = document.querySelector(sidebarLinkSelector);
    if (!first) throw new Error('侧边栏里找不到对话链接，请确认侧边栏已展开、页面已登录');
    const container = findScrollable(first);
    let stable = 0;
    let lastCount = 0;
    while (stable < CONFIG.stableRounds) {
      container.scrollTop = container.scrollHeight;
      await sleep(CONFIG.scrollDelayMs);
      const count = document.querySelectorAll(sidebarLinkSelector).length;
      if (count === lastCount) stable++;
      else { stable = 0; lastCount = count; }
    }
    // 去重收集（href -> 标题）
    const map = new Map();
    for (const a of document.querySelectorAll(sidebarLinkSelector)) {
      const href = a.getAttribute('href');
      if (!map.has(href)) map.set(href, (a.textContent || '').trim() || '(无标题)');
    }
    return [...map.entries()].map(([href, title]) => ({ href, title }));
  }

  // ---- 2. 打开某个对话（SPA 内点击，不刷新页面）----
  async function openConversation(href) {
    const a = document.querySelector(`a[href="${href}"]`);
    if (a) {
      a.click();
    } else {
      // 链接可能因虚拟列表被卸载，退回 history API
      history.pushState({}, '', href);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
    // 等待消息渲染出来
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (location.pathname === href && document.querySelector('[data-message-author-role]')) return true;
      await sleep(300);
    }
    return false;
  }

  // ---- 3. 向上滚动加载全部历史消息 ----
  async function loadFullHistory() {
    const firstMsg = document.querySelector('[data-message-author-role]');
    if (!firstMsg) return;
    const container = findScrollable(firstMsg);
    let stable = 0;
    let lastHeight = -1;
    let lastCount = -1;
    while (stable < CONFIG.stableRounds) {
      container.scrollTop = 0;
      await sleep(CONFIG.scrollDelayMs);
      const count = document.querySelectorAll('[data-message-author-role]').length;
      if (container.scrollHeight === lastHeight && count === lastCount) stable++;
      else { stable = 0; lastHeight = container.scrollHeight; lastCount = count; }
    }
  }

  // ---- 4. 抓取当前页面的消息 ----
  function scrapeMessages() {
    const nodes = document.querySelectorAll('[data-message-author-role]');
    const messages = [];
    for (const el of nodes) {
      const role = el.getAttribute('data-message-author-role') || 'unknown';
      const imgCount = el.querySelectorAll('img').length;
      let text = (el.innerText || '').trim();
      if (imgCount > 0) text = `${'[图片] '.repeat(imgCount).trim()}\n${text}`.trim();
      if (!text) continue;
      messages.push({ role, kind: 'message', text, createTime: null });
    }
    return messages;
  }

  // ---- 5. 主流程 ----
  let links = await loadAllSidebarLinks();
  if (links.length > CONFIG.maxConversations) links = links.slice(0, CONFIG.maxConversations);
  log(`侧边栏共发现 ${links.length} 个对话，开始逐个抓取…`);

  const conversations = [];
  const failures = [];
  for (let i = 0; i < links.length; i++) {
    const { href, title } = links[i];
    try {
      const ok = await openConversation(href);
      if (!ok) throw new Error('打开对话超时');
      await sleep(CONFIG.afterOpenDelayMs);
      await loadFullHistory();
      conversations.push({
        id: href.replace('/c/', ''),
        title,
        createTime: null,
        updateTime: null,
        messages: scrapeMessages(),
      });
      log(`[${i + 1}/${links.length}] ✓ ${title}`);
    } catch (err) {
      failures.push({ href, title, error: String(err && err.message) });
      warn(`[${i + 1}/${links.length}] ✗ ${title}：${err.message}`);
    }
  }

  // ---- 6. 下载 JSON ----
  const payload = {
    schema: 'chatgpt-export/v1',
    source: 'chatgpt.com (dom)',
    exportedAt: new Date().toISOString(),
    conversationCount: conversations.length,
    failures: failures.length ? failures : undefined,
    conversations,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = CONFIG.outputFilename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);

  log(`完成！成功 ${conversations.length} 个，失败 ${failures.length} 个，已下载 ${CONFIG.outputFilename}`);
  if (failures.length) warn('失败列表：', failures);
})();
