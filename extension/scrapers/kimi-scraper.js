/**
 * Kimi 对话抓取脚本（API 版）
 * ------------------------------------------------------------------
 * 用法：
 *   1. 登录 https://www.kimi.com（或 https://kimi.moonshot.cn）
 *   2. F12 打开开发者工具 → Console
 *   3. 粘贴整个脚本运行，等待完成后自动下载 conversations.json
 *
 * 原理：调用 Kimi 后端接口，登录态取自 localStorage 的 access_token（Bearer）：
 *   POST /api/chat/list                    → 会话列表（分页）
 *   POST /api/chat/{id}/segment/scroll     → 会话消息（分段滚动）
 * 输出与 ChatGPT 抓取脚本相同的 JSON 结构，可直接喂给 export.js。
 *
 * 说明：接口未公开，字段做了多候选兜底；若失效请把控制台报错发回修正。
 */
(async () => {
  // ======================= 可调配置 =======================
  const CONFIG = {
    maxConversations: Infinity,
    pageSize: 50,
    requestDelayMs: 350,
    maxRetries: 5,
    outputFilename: 'conversations.json',
  };
  // ========================================================

  try { Object.assign(CONFIG, globalThis.__AI_EXPORT_CONFIG || {}); } catch (_) {}
  if (!CONFIG.maxConversations) CONFIG.maxConversations = Infinity;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const report = (level, text) => {
    try { chrome.runtime.sendMessage({ __aiExport: true, level, text }); } catch (_) {}
  };
  const log = (...a) => { console.log('%c[kimi-export]', 'color:#1f1f1f;font-weight:bold', ...a); report('info', a.map(String).join(' ')); };
  const warn = (...a) => { console.warn('[kimi-export]', ...a); report('warn', a.map(String).join(' ')); };

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

  // ---- 登录态 ----
  function getToken() {
    for (const k of ['access_token', 'kimi-auth', 'auth_token']) {
      const v = localStorage.getItem(k);
      if (v && v.length > 20) return v.replace(/^"|"$/g, '');
    }
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (/access_token|token/i.test(k)) {
        const v = localStorage.getItem(k);
        if (v && v.length > 20) return v.replace(/^"|"$/g, '');
      }
    }
    return null;
  }
  const token = getToken();
  if (!token) throw new Error('未找到登录态（localStorage access_token），请确认已登录 Kimi');
  const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', accept: 'application/json' };

  async function apiPost(path, body, attempt = 0) {
    let res;
    try {
      res = await fetch(path, { method: 'POST', credentials: 'include', headers: authHeaders, body: JSON.stringify(body || {}) });
    } catch (err) {
      if (attempt >= CONFIG.maxRetries) throw err;
      const wait = 1000 * 2 ** attempt;
      warn(`网络错误，${wait}ms 后重试：${path}`);
      await sleep(wait);
      return apiPost(path, body, attempt + 1);
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= CONFIG.maxRetries) throw new Error(`HTTP ${res.status}：${path}（重试已用尽）`);
      const wait = 2000 * 2 ** attempt;
      warn(`HTTP ${res.status}，${wait}ms 后重试`);
      await sleep(wait);
      return apiPost(path, body, attempt + 1);
    }
    if (res.status === 401 || res.status === 403) throw new Error(`HTTP ${res.status}：登录态失效，请刷新页面重新登录后再运行`);
    if (!res.ok) throw new Error(`HTTP ${res.status}：${path}`);
    return res.json();
  }

  function toIso(v) {
    if (!v) return null;
    const n = Number(v);
    const d = Number.isFinite(n) && String(v).length >= 9 ? new Date(n > 1e12 ? n : n * 1000) : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  // 从任意响应结构里稳健取出数组：先认已知容器/字段，取不到则深度扫描（抵御字段名猜错）
  function deepArrays(o, d, out) {
    if (!o || typeof o !== 'object' || d > 6) return out;
    if (Array.isArray(o)) { out.push(o); for (const x of o) deepArrays(x, d + 1, out); return out; }
    for (const k of Object.keys(o)) deepArrays(o[k], d + 1, out);
    return out;
  }
  function pickArrayBy(data, isMatch) {
    return deepArrays(data, 0, []).reduce((best, a) => {
      const m = a.filter(isMatch).length;
      return (m >= Math.max(1, a.length * 0.5) && a.length > best.length) ? a : best;
    }, []);
  }
  const isConvEl = (el) => el && typeof el === 'object' && (
    ['uuid', 'convId', 'conversation_id', 'conversationId', 'chat_id', 'chatId', 'session_id', 'chat_session_id'].some((k) => k in el) ||
    ('id' in el && ['title', 'name', 'firstQuestion', 'conversation_title', 'updated_at', 'update_time', 'inserted_at', 'created_at'].some((k) => k in el))
  );
  const isMsgEl = (el) => el && typeof el === 'object' &&
    ['role', 'sender', 'speaker', 'query', 'answer', 'response', 'speechText'].some((k) => k in el);
  function pickConvArray(data) {
    for (const c of [data, data && data.data, data && data.result, data && data.biz_data]) {
      if (!c || typeof c !== 'object') continue;
      for (const k of ['chat_sessions', 'conversations', 'conversation_list', 'convs', 'chats', 'sessions', 'conversationList', 'list', 'items']) {
        if (Array.isArray(c[k]) && c[k].length) return c[k];
      }
    }
    return pickArrayBy(data, isConvEl);
  }
  function pickMsgArray(data) {
    for (const c of [data, data && data.data, data && data.result, data && data.biz_data]) {
      if (!c || typeof c !== 'object') continue;
      for (const k of ['chat_messages', 'messages', 'history', 'convs', 'speeches', 'dialog', 'segments', 'chatList', 'chat_list', 'conversation_history', 'list', 'items']) {
        if (Array.isArray(c[k]) && c[k].length) return c[k];
      }
    }
    return pickArrayBy(data, isMsgEl);
  }

  // 稳健分页：按 id 去重，本页新增为 0 / 空 / 超上限即停（抵御游标被忽略、单页数不稳定、提前截断）
  async function collectPaged(fetchPage, idOf, label) {
    const seen = new Map();
    for (let page = 0; page < 300; page++) {
      const collected = [...seen.values()];
      let arr;
      try {
        arr = await fetchPage(page, collected);
      } catch (err) {
        if (seen.size) { warn(`${label}第 ${page + 1} 页失败，已收 ${seen.size} 条：${err && err.message}`); break; }
        throw err;
      }
      arr = arr || [];
      let added = 0;
      for (const it of arr) { const id = idOf(it); if (id != null && id !== '' && !seen.has(id)) { seen.set(id, it); added++; } }
      log(`已获取${label} ${seen.size}（本页 ${arr.length}，新增 ${added}）`);
      if (arr.length === 0 || added === 0) break;
      await sleep(CONFIG.requestDelayMs);
    }
    return [...seen.values()];
  }

  // ---- 1. 会话列表 ----
  async function listConversations() {
    return collectPaged(async (page, collected) => {
      const data = await apiPost('/api/chat/list', { kimiplus_id: '', offset: collected.length, size: CONFIG.pageSize });
      return pickConvArray(data);
    }, (it) => String(it.id || it.chat_id || it.conversation_id), '会话列表');
  }

  // ---- 2. 会话消息（分段滚动）----
  async function fetchMessages(id) {
    const all = [];
    let last = '';
    let guard = 0;
    for (;;) {
      if (guard++ > 200) break;
      const data = await apiPost(`/api/chat/${id}/segment/scroll`, { scroll_id: last || undefined, last: CONFIG.pageSize });
      const page = pickMsgArray(data);
      if (!page.length) break;
      all.unshift(...page); // 分段一般从新到旧，前插保持时间正序
      const next = data.scroll_id || data.last_id || (page[0] && page[0].id);
      if (!next || next === last || page.length < CONFIG.pageSize) break;
      last = next;
      await sleep(CONFIG.requestDelayMs);
    }
    return all;
  }

  function extractText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : (c && (c.text || c.content)) || '')).filter(Boolean).join('\n');
    if (content && typeof content === 'object') return content.text || content.content || '';
    return '';
  }
  function toMessage(m) {
    if (!m) return null;
    const role = String(m.role || m.sender || '').toLowerCase() === 'user' ? 'user' : 'assistant';
    const parts = [];
    const body = extractText(m.content || m.text || m.message);
    if (body) parts.push(body);
    for (const f of (m.refs || m.files || m.attachments || [])) {
      parts.push(`[附件: ${(f && (f.name || f.file_name)) || '文件'}]`);
      if (convAssets && f) {
        const u = f.url || f.file_url || f.download_url;
        if (u) convAssets.push({ url: u, name: f.name || f.file_name || '' });
      }
    }
    const text = parts.join('\n').trim();
    if (!text) return null;
    return { role, kind: 'message', text, createTime: toIso(m.created_at || m.create_time || m.timestamp) };
  }

  // ============ DOM 兜底：接口拿不到清单/消息时，直接从页面侧边栏与正文抓（best-effort）============
  // 这些平台接口未公开、易变；接口失败或返回空时退回此路，保证「至少能识别到侧边栏里的对话」。
  const NAV_BLACKLIST = /^(新建会话|新对话|新建对话|新的对话|开启新对话|插件|定时任务|更多|设置|帮助|反馈|升级|升级套餐|获取应用程序|下载|历史记录|探索|发现|Agent|智能体|新建|New chat|New Chat|Settings|Help|Explore|Discover|Upgrade|探索灵感)$/i;
  const _vtext = (el) => (((el && (el.innerText || el.textContent)) || '')).replace(/\s+/g, ' ').trim();
  function _domScrollable(el) {
    let c = el;
    while (c && c !== document.body) { const s = getComputedStyle(c); if (c.scrollHeight > c.clientHeight + 10 && /(auto|scroll)/.test(s.overflowY)) return c; c = c.parentElement; }
    return document.scrollingElement;
  }
  function _domSidebarItems() {
    const cand = [];
    for (const el of document.querySelectorAll('a, li, [role="button"], [role="listitem"], [role="option"], [class*="item"], [class*="Item"], [class*="conversation"], [class*="history"]')) {
      const r = el.getBoundingClientRect();
      if (r.width < 50 || r.height < 16 || r.height > 110) continue;
      if (r.left > innerWidth * 0.46 || r.right < 4 || r.bottom < 0 || r.top > innerHeight) continue;
      if (el.querySelector('a, li, [role="button"], textarea, input')) continue;
      const t = _vtext(el);
      if (t.length < 2 || t.length > 80 || NAV_BLACKLIST.test(t)) continue;
      cand.push([el, t]);
    }
    // 按父容器聚类；优先「在可滚动容器内」的组（对话列表通常可滚动，导航区不滚动），再按条目数
    const groups = new Map();
    for (const [el, t] of cand) { const p = el.parentElement; if (!p) continue; if (!groups.has(p)) groups.set(p, []); groups.get(p).push([el, t]); }
    let best = [], bestScore = -1;
    for (const [, arr] of groups) {
      const uniq = new Set(arr.map((x) => x[1])); if (uniq.size < 2) continue;
      const scrollable = _domScrollable(arr[0][0]) !== document.scrollingElement;
      const score = arr.length + (scrollable ? 1000 : 0);
      if (score > bestScore) { bestScore = score; best = arr; }
    }
    const seen = new Set(), out = [];
    for (const [el, t] of best) { if (seen.has(t)) continue; seen.add(t); out.push({ el, title: t }); }
    return out;
  }
  async function _domLoadSidebar() {
    let items = _domSidebarItems();
    if (!items.length) return [];
    const container = _domScrollable(items[0].el);
    let stable = 0, last = 0;
    while (stable < 3) {
      container.scrollTop = container.scrollHeight;
      await sleep(700);
      const n = _domSidebarItems().length;
      if (n === last) stable++; else { stable = 0; last = n; }
    }
    return _domSidebarItems();
  }
  function _domMessageHost() {
    let host = null, area = 0;
    for (const el of document.querySelectorAll('div, main, section')) {
      const r = el.getBoundingClientRect();
      if (r.left < innerWidth * 0.28 || r.width < 200) continue;
      if (el.scrollHeight > el.clientHeight && r.width * r.height > area) { area = r.width * r.height; host = el; }
    }
    return host || document.querySelector('main') || document.body;
  }
  async function _domLoadMessages(host) {
    let stable = 0, lastH = -1;
    while (stable < 3) { host.scrollTop = 0; await sleep(600); if (host.scrollHeight === lastH) stable++; else { stable = 0; lastH = host.scrollHeight; } }
    host.scrollTop = host.scrollHeight;
  }
  function _domScrapeMessages(host) {
    const midX = (() => { const r = host.getBoundingClientRect(); return r.left + r.width / 2; })();
    const nodes = host.querySelectorAll('[class*="message"], [class*="Message"], [data-testid*="message"], [class*="bubble"], [class*="chat-item"], [class*="markdown"]');
    const pool = nodes.length ? nodes : host.querySelectorAll('p, li');
    const seen = new Set(), out = [];
    for (const el of pool) {
      if (el.querySelector('[class*="message"], [class*="bubble"], [class*="markdown"]')) continue;
      const t = _vtext(el); if (t.length < 1 || seen.has(t)) continue; seen.add(t);
      if (convAssets) for (const img of el.querySelectorAll('img')) { const s = img.currentSrc || img.src || ''; if (/^https?:/i.test(s) && (img.naturalWidth || 999) > 64) convAssets.push({ url: s, name: (s.split('/').pop() || '').split('?')[0] }); }
      const r = el.getBoundingClientRect();
      const role = (r.left + r.width / 2) > midX + 40 ? 'user' : 'assistant';
      out.push({ role, kind: 'message', text: t, createTime: null });
    }
    return out;
  }
  async function domFallbackFlow(source) {
    warn('未能通过接口获取会话列表，改用页面抓取（DOM 兜底，可能不含时间戳/代码围栏）');
    const items = await _domLoadSidebar();
    if (!items.length) {
      report('error', '接口和页面都没识别到对话列表：请确认左侧对话列表已展开并已登录；若仍不行，把该平台一条 conversation/list 接口的响应发给作者以精确修复。');
      return;
    }
    if (CONFIG.listOnly) {
      try { chrome.runtime.sendMessage({ __aiExport: true, level: 'list', items: items.map((it, i) => ({ id: `idx:${i}`, title: it.title, time: null })) }); } catch (_) {}
      log(`已回传对话列表（${items.length} 个，页面抓取）`);
      return;
    }
    const selectedSet = Array.isArray(CONFIG.selectedIds) && CONFIG.selectedIds.length ? new Set(CONFIG.selectedIds) : null;
    const total = selectedSet ? items.length : Math.min(items.length, CONFIG.maxConversations);
    log(`页面共识别到 ${items.length} 个对话，将抓取 ${selectedSet ? selectedSet.size : total} 个…`);
    const conversations = [], failures = [];
    for (let i = 0; i < total; i++) {
      const cur = _domSidebarItems()[i] || items[i];
      const title = (cur && cur.title) || `对话 ${i + 1}`;
      if (selectedSet && !selectedSet.has(`idx:${i}`)) continue;
      if (!selectedSet && CONFIG.titleKeyword && !title.toLowerCase().includes(String(CONFIG.titleKeyword).toLowerCase())) continue;
      try {
        (cur.el.querySelector('a, button') || cur.el).click();
        await sleep(1600);
        const host = _domMessageHost();
        await _domLoadMessages(host);
        convAssets = CONFIG.downloadAssets ? [] : null;
        const messages = _domScrapeMessages(host);
        conversations.push({ id: `dom-${i + 1}`, title, createTime: null, updateTime: null, messages });
        if (convAssets && convAssets.length) await downloadConvAssets(i + 1, convAssets);
        log(`[${i + 1}/${total}] ✓ ${title}`);
      } catch (err) { failures.push({ index: i, title, error: String(err && err.message) }); warn(`[${i + 1}/${total}] ✗ ${title}：${err && err.message}`); }
    }
    if (CONFIG.downloadAssets) log(`文件下载：成功 ${assetStats.ok} 个，失败 ${assetStats.fail} 个`);
    const payload = { schema: 'chatgpt-export/v1', source, exportedAt: new Date().toISOString(), conversationCount: conversations.length, failures: failures.length ? failures : undefined, conversations };
    if (globalThis.__AI_EXPORT_EMIT) await globalThis.__AI_EXPORT_EMIT(payload, CONFIG);
    else { const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = CONFIG.outputFilename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000); }
    log(`完成！成功 ${conversations.length} 个，失败 ${failures.length} 个`);
    report('done', `成功 ${conversations.length} 个，失败 ${failures.length} 个`);
  }

  // ---- 3. 主流程 ----
  let list = [];
  try { list = await listConversations(); } catch (e) { warn('接口获取会话列表失败：' + (e && e.message)); }
  if (!list.length) { await domFallbackFlow('kimi.com (dom)'); return; }
  const idOf = (it) => String(it.id || it.chat_id || it.conversation_id);
  const titleOf = (it) => it.name || it.title || '(无标题)';
  const timeOf = (it) => it.updated_at || it.created_at || it.update_time || null;

  const selectedSet = Array.isArray(CONFIG.selectedIds) && CONFIG.selectedIds.length ? new Set(CONFIG.selectedIds) : null;
  if (selectedSet) {
    list = list.filter((it) => selectedSet.has(idOf(it)));
  } else {
    if (CONFIG.titleKeyword) {
      const kw = String(CONFIG.titleKeyword).toLowerCase();
      list = list.filter((it) => titleOf(it).toLowerCase().includes(kw));
    }
    if (CONFIG.fromDate || CONFIG.toDate) {
      const from = CONFIG.fromDate ? new Date(CONFIG.fromDate) : null;
      const to = CONFIG.toDate ? new Date(CONFIG.toDate + 'T23:59:59.999') : null;
      list = list.filter((it) => {
        const t = new Date(toIso(timeOf(it)) || 0);
        return (!from || t >= from) && (!to || t <= to);
      });
    }
  }
  if (CONFIG.listOnly) {
    try {
      chrome.runtime.sendMessage({
        __aiExport: true, level: 'list',
        items: list.map((it) => ({ id: idOf(it), title: titleOf(it), time: toIso(timeOf(it)) })),
      });
    } catch (_) {}
    log(`已回传对话列表（${list.length} 个），请在弹窗中勾选…`);
    return;
  }
  if (!selectedSet && list.length > CONFIG.maxConversations) list = list.slice(0, CONFIG.maxConversations);
  log(`共 ${list.length} 个对话，开始逐个抓取消息…`);

  const conversations = [];
  const failures = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const id = idOf(item);
    const title = titleOf(item);
    try {
      const raw = await fetchMessages(id);
      convAssets = CONFIG.downloadAssets ? [] : null;
      const messages = raw.map(toMessage).filter(Boolean);
      conversations.push({
        id, title,
        createTime: toIso(item.created_at || item.create_time),
        updateTime: toIso(timeOf(item)),
        messages,
      });
      if (convAssets && convAssets.length) await downloadConvAssets(i + 1, convAssets);
      log(`[${i + 1}/${list.length}] ✓ ${title}`);
    } catch (err) {
      failures.push({ id, title, error: String(err && err.message) });
      warn(`[${i + 1}/${list.length}] ✗ ${title}：${err.message}`);
    }
    await sleep(CONFIG.requestDelayMs);
  }

  // ---- 4. 下载 JSON ----
  if (CONFIG.downloadAssets) log(`文件下载：成功 ${assetStats.ok} 个，失败 ${assetStats.fail} 个`);
  const payload = {
    schema: 'chatgpt-export/v1',
    source: 'kimi.com',
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
