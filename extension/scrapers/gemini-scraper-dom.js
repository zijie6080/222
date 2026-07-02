/**
 * Gemini 对话抓取脚本（DOM 版）
 * ------------------------------------------------------------------
 * 用法：
 *   1. 登录 https://gemini.google.com，确保左侧「近期对话」侧边栏展开
 *   2. F12 打开开发者工具 → Console
 *   3. 粘贴整个脚本运行，脚本会自动：加载全部近期对话 → 逐个点开 →
 *      滚动加载完整历史 → 抓取 → 下载 conversations.json
 *
 * 说明：Gemini 网页端没有公开的 REST 接口（内部走 batchexecute 私有协议），
 * 所以这里用 DOM 方式抓取。局限：
 *   - 拿不到时间戳（createTime 为 null，时间筛选对其不生效）
 *   - 拿到的是渲染后的纯文本，markdown 代码块围栏会丢失
 *   - 依赖 Gemini 的组件标签（user-query / model-response 等），改版可能失效
 */
(async () => {
  // ======================= 可调配置 =======================
  const CONFIG = {
    maxConversations: Infinity, // 最多抓取多少个对话
    scrollDelayMs: 800,         // 每次滚动后的等待时间
    afterOpenDelayMs: 2000,     // 点开一个对话后的等待时间
    stableRounds: 3,            // 连续 N 轮内容无变化视为加载完
    outputFilename: 'conversations.json',
  };
  // ========================================================

  // 浏览器插件注入时通过 globalThis.__AI_EXPORT_CONFIG 覆盖配置；控制台直接运行时无影响
  try { Object.assign(CONFIG, globalThis.__AI_EXPORT_CONFIG || {}); } catch (_) {}
  if (!CONFIG.maxConversations) CONFIG.maxConversations = Infinity;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 浏览器插件注入时把进度回传给弹窗；控制台直接运行时静默跳过
  const report = (level, text) => {
    try { chrome.runtime.sendMessage({ __aiExport: true, level, text }); } catch (_) {}
  };
  const log = (...a) => { console.log('%c[gemini-export]', 'color:#4285f4;font-weight:bold', ...a); report('info', a.map(String).join(' ')); };
  const warn = (...a) => { console.warn('[gemini-export]', ...a); report('warn', a.map(String).join(' ')); };

  const convItemSelector = '[data-test-id="conversation"], .conversation-items-container .conversation';
  const messageSelector = 'user-query, model-response';

  function findScrollable(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      const style = getComputedStyle(cur);
      if (cur.scrollHeight > cur.clientHeight + 10 && /(auto|scroll)/.test(style.overflowY)) return cur;
      cur = cur.parentElement;
    }
    return document.scrollingElement;
  }

  function convItems() {
    return [...document.querySelectorAll(convItemSelector)];
  }

  function itemTitle(el) {
    if (!el || typeof el.querySelector !== 'function') return '(无标题)';
    const t = el.querySelector('.conversation-title');
    return ((t ? t.textContent : el.textContent) || '').trim() || '(无标题)';
  }

  // ---- 1. 展开侧边栏全部对话（点「更多」按钮 + 滚动）----
  async function loadAllSidebarItems() {
    let first = document.querySelector(convItemSelector);
    if (!first) throw new Error('侧边栏里找不到对话，请确认侧边栏已展开、已登录');
    const container = findScrollable(first);
    let stable = 0;
    let lastCount = 0;
    while (stable < CONFIG.stableRounds && convItems().length < CONFIG.maxConversations) {
      const more = document.querySelector('[data-test-id="show-more-button"]');
      if (more) more.click();
      container.scrollTop = container.scrollHeight;
      await sleep(CONFIG.scrollDelayMs);
      const count = convItems().length;
      if (count === lastCount) stable++;
      else { stable = 0; lastCount = count; }
    }
    return convItems().length;
  }

  // ---- 2. 打开第 i 个对话并等待加载 ----
  async function openConversation(index, expectTitle) {
    const items = convItems();
    const el = items[index];
    if (!el) throw new Error('对话列表项丢失（列表可能被重新渲染）');
    (el.querySelector('a, button') || el).click();
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (document.querySelector(messageSelector)) {
        await sleep(CONFIG.afterOpenDelayMs);
        return;
      }
      await sleep(300);
    }
    throw new Error(`打开对话超时：${expectTitle}`);
  }

  // ---- 3. 向上滚动加载完整历史 ----
  async function loadFullHistory() {
    const firstMsg = document.querySelector(messageSelector);
    if (!firstMsg) return;
    const container = findScrollable(firstMsg);
    let stable = 0;
    let lastHeight = -1;
    let lastCount = -1;
    while (stable < CONFIG.stableRounds) {
      container.scrollTop = 0;
      await sleep(CONFIG.scrollDelayMs);
      const count = document.querySelectorAll(messageSelector).length;
      if (container.scrollHeight === lastHeight && count === lastCount) stable++;
      else { stable = 0; lastHeight = container.scrollHeight; lastCount = count; }
    }
  }

  // ---- 4. 抓取当前对话的消息 ----
  function extractText(el) {
    const imgCount = el.querySelectorAll('img').length;
    let text = (el.innerText || '').trim();
    if (imgCount > 0) text = `${'[图片] '.repeat(imgCount).trim()}\n${text}`.trim();
    return text;
  }

  function scrapeMessages() {
    const messages = [];
    for (const el of document.querySelectorAll(messageSelector)) {
      const isUser = el.tagName.toLowerCase() === 'user-query';
      if (isUser) {
        const text = extractText(el.querySelector('.query-text') || el);
        if (text) messages.push({ role: 'user', kind: 'message', text, createTime: null });
      } else {
        // 思考过程（若展开了 thinking 面板）单独存为 reasoning
        const thoughts = el.querySelector('model-thoughts');
        if (thoughts) {
          const t = extractText(thoughts);
          if (t) messages.push({ role: 'assistant', kind: 'reasoning', text: t, createTime: null });
        }
        const body = el.querySelector('message-content') || el;
        const text = extractText(body);
        if (text) messages.push({ role: 'assistant', kind: 'message', text, createTime: null });
      }
    }
    return messages;
  }

  // ---- 5. 主流程 ----
  const total = Math.min(await loadAllSidebarItems(), CONFIG.maxConversations);
  log(`侧边栏共发现 ${convItems().length} 个对话，将抓取 ${total} 个…`);

  const conversations = [];
  const failures = [];
  for (let i = 0; i < total; i++) {
    const title = itemTitle(convItems()[i]);
    // 抓取前筛选（插件设置）：标题关键词
    if (CONFIG.titleKeyword && !title.toLowerCase().includes(String(CONFIG.titleKeyword).toLowerCase())) {
      log(`[${i + 1}/${total}] 跳过（标题不含关键词）：${title}`);
      continue;
    }
    try {
      await openConversation(i, title);
      await loadFullHistory();
      conversations.push({
        id: (location.pathname.match(/\/app\/([\w-]+)/) || [])[1] || `gemini-${i + 1}`,
        title,
        createTime: null,
        updateTime: null,
        messages: scrapeMessages(),
      });
      log(`[${i + 1}/${total}] ✓ ${title}`);
    } catch (err) {
      failures.push({ index: i, title, error: String(err && err.message) });
      warn(`[${i + 1}/${total}] ✗ ${title}：${err.message}`);
    }
  }

  // ---- 6. 下载 JSON ----
  const payload = {
    schema: 'chatgpt-export/v1',
    source: 'gemini.google.com (dom)',
    exportedAt: new Date().toISOString(),
    conversationCount: conversations.length,
    failures: failures.length ? failures : undefined,
    conversations,
  };
  if (globalThis.__AI_EXPORT_EMIT) {
    // 浏览器插件注入的多格式导出（JSON/Markdown/TXT/HTML、文件名前缀、时间格式等）
    await globalThis.__AI_EXPORT_EMIT(payload, CONFIG);
  } else {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = CONFIG.outputFilename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  log(`完成！成功 ${conversations.length} 个，失败 ${failures.length} 个`);
  if (failures.length) warn('失败列表：', failures);
  report('done', `成功 ${conversations.length} 个，失败 ${failures.length} 个`);
})().catch((err) => {
  console.error('[ai-export] 抓取中断:', err);
  try { chrome.runtime.sendMessage({ __aiExport: true, level: 'error', text: '抓取中断: ' + (err && err.message) }); } catch (_) {}
});
