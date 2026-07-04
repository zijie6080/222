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

  // ---- 3. 主流程 ----
  let list = await listConversations();
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
