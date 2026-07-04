/**
 * DeepSeek 对话抓取脚本（API 版）
 * ------------------------------------------------------------------
 * 用法：
 *   1. 登录 https://chat.deepseek.com
 *   2. F12 打开开发者工具 → Console
 *   3. 粘贴整个脚本运行，等待完成后自动下载 conversations.json
 *
 * 原理：在页面内调用 chat.deepseek.com 的后端接口，登录态取自 localStorage 的
 *   userToken（Bearer）：
 *   POST /api/v0/chat_session/fetch_page                 → 会话列表（分页）
 *   GET  /api/v0/chat/history_messages?chat_session_id=  → 会话消息
 * 输出与 ChatGPT 抓取脚本相同的 JSON 结构，可直接喂给 export.js。
 *
 * 说明：DeepSeek 接口未公开，字段做了多候选兜底；若失效请把控制台报错发回修正。
 */
(async () => {
  // ======================= 可调配置 =======================
  const CONFIG = {
    maxConversations: Infinity, // 最多抓取多少个对话
    pageSize: 100,              // 列表分页大小
    requestDelayMs: 350,        // 请求间隔（毫秒）
    maxRetries: 5,              // 限流/网络错误重试次数
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
  const log = (...a) => { console.log('%c[deepseek-export]', 'color:#4d6bfe;font-weight:bold', ...a); report('info', a.map(String).join(' ')); };
  const warn = (...a) => { console.warn('[deepseek-export]', ...a); report('warn', a.map(String).join(' ')); };

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

  // ---- 登录态：从 localStorage 找 userToken ----
  function getToken() {
    const tryParse = (raw) => {
      if (!raw) return null;
      try {
        const o = JSON.parse(raw);
        return o && (o.value || o.token || (o.data && o.data.token)) || (typeof o === 'string' ? o : null);
      } catch (_) { return raw; }
    };
    let token = tryParse(localStorage.getItem('userToken'));
    if (token) return token;
    // 兜底：扫描所有 localStorage 键找形似 token 的
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (/token/i.test(k)) {
        const v = tryParse(localStorage.getItem(k));
        if (v && String(v).length > 20) return v;
      }
    }
    return null;
  }

  const token = getToken();
  if (!token) throw new Error('未找到登录态（localStorage userToken），请确认已登录 chat.deepseek.com');
  const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', accept: '*/*' };

  async function apiFetch(path, options, attempt = 0) {
    let res;
    try {
      res = await fetch(path, { credentials: 'include', headers: authHeaders, ...options });
    } catch (err) {
      if (attempt >= CONFIG.maxRetries) throw err;
      const wait = 1000 * 2 ** attempt;
      warn(`网络错误，${wait}ms 后重试：${path}`);
      await sleep(wait);
      return apiFetch(path, options, attempt + 1);
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= CONFIG.maxRetries) throw new Error(`HTTP ${res.status}：${path}（重试已用尽）`);
      const wait = 2000 * 2 ** attempt;
      warn(`HTTP ${res.status}，${wait}ms 后重试`);
      await sleep(wait);
      return apiFetch(path, options, attempt + 1);
    }
    if (res.status === 401 || res.status === 403) throw new Error(`HTTP ${res.status}：登录态失效，请刷新页面重新登录后再运行`);
    if (!res.ok) throw new Error(`HTTP ${res.status}：${path}`);
    return res.json();
  }
  const apiGet = (path) => apiFetch(path, { method: 'GET' });
  const apiPost = (path, body) => apiFetch(path, { method: 'POST', body: JSON.stringify(body || {}) });

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

  // ---- 1. 分页拉取会话列表 ----
  async function listConversations() {
    return collectPaged(async (page, collected) => {
      const last = collected[collected.length - 1];
      const before = last && (last.updated_at || last.inserted_at || last.seq_id || last.id);
      const body = { count: CONFIG.pageSize };
      if (before) body.before = before;
      let data;
      try {
        data = await apiPost('/api/v0/chat_session/fetch_page', body);
      } catch (err) {
        if (collected.length) throw err;
        data = await apiGet(`/api/v0/chat_session/fetch_page?count=${CONFIG.pageSize}`);
      }
      return pickConvArray(data);
    }, (it) => String(it.id || it.chat_session_id || it.session_id), '会话列表');
  }

  // ---- 2. 消息抽取 ----
  function extractText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((c) => (typeof c === 'string' ? c : (c && (c.text || c.content)) || '')).filter(Boolean).join('\n');
    }
    if (content && typeof content === 'object') return content.text || content.content || '';
    return '';
  }
  function toMessage(m) {
    if (!m) return null;
    const role = String(m.role || '').toLowerCase() === 'user' ? 'user' : 'assistant';
    const parts = [];
    const think = extractText(m.thinking_content || m.reasoning_content);
    const body = extractText(m.content || m.message || m.text);
    for (const f of (m.files || m.attachments || [])) {
      parts.push(`[附件: ${(f && (f.file_name || f.name)) || '文件'}]`);
      if (convAssets && f) {
        const u = f.url || f.file_url || f.download_url;
        if (u) convAssets.push({ url: u, name: f.file_name || f.name || '' });
      }
    }
    const out = [];
    const created = toIso(m.inserted_at || m.created_at || m.create_time);
    if (think && think.trim()) out.push({ role: 'assistant', kind: 'reasoning', text: think, createTime: created });
    const text = [body, parts.join('\n')].filter((x) => x && x.trim()).join('\n');
    if (text.trim()) out.push({ role, kind: 'message', text, createTime: created });
    return out;
  }

  // ---- 3. 主流程 ----
  let list = await listConversations();
  const idOf = (it) => String(it.id || it.chat_session_id || it.session_id);
  const titleOf = (it) => it.title || it.name || '(无标题)';
  const timeOf = (it) => it.updated_at || it.inserted_at || it.created_at || null;

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
      let data;
      try {
        data = await apiGet(`/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(id)}`);
      } catch (err) {
        data = await apiPost('/api/v0/chat/history_messages', { chat_session_id: id });
      }
      const raw = pickMsgArray(data);
      convAssets = CONFIG.downloadAssets ? [] : null;
      const messages = raw.flatMap(toMessage).filter(Boolean);
      conversations.push({
        id, title,
        createTime: toIso(item.inserted_at || item.created_at),
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
    source: 'chat.deepseek.com',
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
