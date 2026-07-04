/**
 * Meta AI 对话抓取脚本（DOM 版）
 * ------------------------------------------------------------------
 * 用法：
 *   1. 登录 https://www.meta.ai，确保左侧对话历史侧边栏展开
 *   2. F12 打开开发者工具 → Console
 *   3. 粘贴整个脚本运行，脚本会自动：加载全部历史对话 → 逐个点开 →
 *      滚动加载完整历史 → 抓取 → 下载 conversations.json
 *
 * 说明：Meta AI Web 端走带反爬令牌的 GraphQL，没有可直接调用的干净接口，
 * 故用 DOM 方式抓取。局限：
 *   - 拿不到时间戳（createTime 为 null，时间筛选对其不生效）
 *   - 拿到的是渲染后的纯文本，markdown 代码块围栏会丢失
 *   - 依赖页面结构（选择器做了多候选兜底），改版可能失效
 */
(async () => {
  // ======================= 可调配置 =======================
  const CONFIG = {
    maxConversations: Infinity,
    scrollDelayMs: 800,
    afterOpenDelayMs: 1800,
    stableRounds: 3,
    outputFilename: 'conversations.json',
  };
  // ========================================================

  try { Object.assign(CONFIG, globalThis.__AI_EXPORT_CONFIG || {}); } catch (_) {}
  if (!CONFIG.maxConversations) CONFIG.maxConversations = Infinity;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const report = (level, text) => {
    try { chrome.runtime.sendMessage({ __aiExport: true, level, text }); } catch (_) {}
  };
  const log = (...a) => { console.log('%c[meta-export]', 'color:#0064e0;font-weight:bold', ...a); report('info', a.map(String).join(' ')); };
  const warn = (...a) => { console.warn('[meta-export]', ...a); report('warn', a.map(String).join(' ')); };

  // ---- 对话内文件下载（CONFIG.downloadAssets 开启时生效）----
  let convAssets = null;
  const assetStats = { ok: 0, fail: 0 };
  const pad3 = (n) => String(n).padStart(3, '0');
  const safeAssetName = (name) => String(name || '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'file';
  const extFromMime = (mime) => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf', 'text/plain': 'txt' })[String(mime || '').split(';')[0]] || 'bin';
  function downloadBlobFile(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }
  async function downloadConvAssets(convIndex, assets) {
    const seen = new Set();
    for (const asset of assets) {
      const key = asset.url || asset.name;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      try {
        let url = asset.url;
        if (url && url.startsWith('/')) url = location.origin + url;
        if (!url) throw new Error('无下载地址');
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        let name = asset.name || `file.${extFromMime(blob.type)}`;
        if (!/\.[A-Za-z0-9]{1,5}$/.test(name)) name += `.${extFromMime(blob.type)}`;
        const filename = `${pad3(convIndex)}-${safeAssetName(name)}`;
        downloadBlobFile(blob, filename);
        assetStats.ok++;
        log(`已下载 ${filename}`);
      } catch (err) {
        assetStats.fail++;
        warn(`文件下载失败（${asset.name || asset.url || '?'}）：${err && err.message}`);
      }
      await sleep(400);
    }
  }

  const convItemSelector = 'a[href*="/prompt/"], a[href*="/c/"], [role="listitem"] a, [class*="conversation"] a';
  const messageSelector = '[data-testid*="message"], [role="row"] [dir="auto"], [class*="message"]';

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
    const seen = new Set();
    const out = [];
    for (const el of document.querySelectorAll(convItemSelector)) {
      const key = el.getAttribute('href') || el.textContent;
      if (key && !seen.has(key)) { seen.add(key); out.push(el); }
    }
    return out;
  }
  function itemTitle(el) {
    if (!el || typeof el.querySelector !== 'function') return '(untitled)';
    return ((el.textContent) || '').trim().slice(0, 120) || '(untitled)';
  }

  async function loadAllSidebarItems() {
    let first = document.querySelector(convItemSelector);
    if (!first) throw new Error('侧边栏里找不到对话，请确认对话历史已展开、已登录 meta.ai');
    const container = findScrollable(first);
    let stable = 0;
    let lastCount = 0;
    while (stable < CONFIG.stableRounds && convItems().length < CONFIG.maxConversations) {
      container.scrollTop = container.scrollHeight;
      await sleep(CONFIG.scrollDelayMs);
      const count = convItems().length;
      if (count === lastCount) stable++;
      else { stable = 0; lastCount = count; }
    }
    return convItems().length;
  }

  async function openConversation(index, expectTitle) {
    const el = convItems()[index];
    if (!el) throw new Error('对话列表项丢失（列表可能被重新渲染）');
    el.click();
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (document.querySelector(messageSelector)) { await sleep(CONFIG.afterOpenDelayMs); return; }
      await sleep(300);
    }
    throw new Error(`打开对话超时：${expectTitle}`);
  }

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

  function isUserMessage(el) {
    const cls = String(el.className || '') + ' ' + (el.getAttribute('data-testid') || '');
    if (/user|send|self|right/i.test(cls) && !/assistant|receive|ai|bot/i.test(cls)) return true;
    // 兜底：靠对齐（用户消息通常右对齐）
    try {
      const ta = getComputedStyle(el).textAlign;
      if (ta === 'right' || ta === 'end') return true;
    } catch (_) {}
    return false;
  }
  function extractText(el) {
    const imgCount = el.querySelectorAll('img').length;
    let text = (el.innerText || '').trim();
    if (imgCount > 0) text = `${'[图片] '.repeat(imgCount).trim()}\n${text}`.trim();
    return text;
  }
  function scrapeMessages() {
    const messages = [];
    const seen = new Set();
    for (const el of document.querySelectorAll(messageSelector)) {
      if (convAssets) {
        for (const img of el.querySelectorAll('img')) {
          const src = img.currentSrc || img.src || '';
          if (/^https?:/i.test(src) && (img.naturalWidth || 999) > 64) {
            convAssets.push({ url: src, name: (src.split('/').pop() || '').split('?')[0] });
          }
        }
      }
      const text = extractText(el);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      messages.push({ role: isUserMessage(el) ? 'user' : 'assistant', kind: 'message', text, createTime: null });
    }
    return messages;
  }

  // ---- 主流程 ----
  const found = await loadAllSidebarItems();
  if (CONFIG.listOnly) {
    try {
      chrome.runtime.sendMessage({
        __aiExport: true, level: 'list',
        items: convItems().map((el, i) => ({ id: `idx:${i}`, title: itemTitle(el), time: null })),
      });
    } catch (_) {}
    log(`已回传对话列表（${found} 个），请在弹窗中勾选…`);
    return;
  }
  const selectedSet = Array.isArray(CONFIG.selectedIds) && CONFIG.selectedIds.length ? new Set(CONFIG.selectedIds) : null;
  const total = selectedSet ? convItems().length : Math.min(found, CONFIG.maxConversations);
  log(`侧边栏共发现 ${convItems().length} 个对话，将抓取 ${selectedSet ? selectedSet.size : total} 个…`);

  const conversations = [];
  const failures = [];
  for (let i = 0; i < total; i++) {
    const title = itemTitle(convItems()[i]);
    if (selectedSet && !selectedSet.has(`idx:${i}`)) continue;
    if (!selectedSet && CONFIG.titleKeyword && !title.toLowerCase().includes(String(CONFIG.titleKeyword).toLowerCase())) {
      log(`[${i + 1}/${total}] 跳过（标题不含关键词）：${title}`);
      continue;
    }
    try {
      await openConversation(i, title);
      await loadFullHistory();
      convAssets = CONFIG.downloadAssets ? [] : null;
      const messages = scrapeMessages();
      conversations.push({
        id: (location.pathname.match(/\/(?:prompt|c)\/([\w-]+)/) || [])[1] || `meta-${i + 1}`,
        title,
        createTime: null,
        updateTime: null,
        messages,
      });
      if (convAssets && convAssets.length) await downloadConvAssets(i + 1, convAssets);
      log(`[${i + 1}/${total}] ✓ ${title}`);
    } catch (err) {
      failures.push({ index: i, title, error: String(err && err.message) });
      warn(`[${i + 1}/${total}] ✗ ${title}：${err.message}`);
    }
  }

  // ---- 下载 JSON ----
  if (CONFIG.downloadAssets) log(`文件下载：成功 ${assetStats.ok} 个，失败 ${assetStats.fail} 个`);
  const payload = {
    schema: 'chatgpt-export/v1',
    source: 'meta.ai (dom)',
    exportedAt: new Date().toISOString(),
    conversationCount: conversations.length,
    failures: failures.length ? failures : undefined,
    conversations,
  };
  if (globalThis.__AI_EXPORT_EMIT) {
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
