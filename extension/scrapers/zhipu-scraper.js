/**
 * 智谱清言 对话抓取脚本（API 版）
 * ------------------------------------------------------------------
 * 用法：
 *   1. 登录 https://chatglm.cn
 *   2. F12 打开开发者工具 → Console
 *   3. 粘贴整个脚本运行，等待完成后自动下载 conversations.json
 *
 * 原理：调用 chatglm.cn 后端接口（cookie 登录态；如需 token 则从 localStorage 兜底）：
 *   GET /chatglm/backend-api/assistant/conversation/list   → 会话列表（分页）
 *   GET /chatglm/backend-api/assistant/conversation/detail → 会话详情
 * 输出与 ChatGPT 抓取脚本相同的 JSON 结构，可直接喂给 export.js。
 *
 * 说明：接口未公开，路径/字段做了多候选兜底；若失效请把控制台报错发回修正。
 */
(async () => {
  // ======================= 可调配置 =======================
  const CONFIG = {
    maxConversations: Infinity,
    pageSize: 100,
    requestDelayMs: 350,
    maxRetries: 5,
    assistantId: '65940acff94777010aa6b796', // 默认智能体 id（清言主对话）
    outputFilename: 'conversations.json',
  };
  // ========================================================

  try { Object.assign(CONFIG, globalThis.__AI_EXPORT_CONFIG || {}); } catch (_) {}
  if (!CONFIG.maxConversations) CONFIG.maxConversations = Infinity;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const report = (level, text) => {
    try { chrome.runtime.sendMessage({ __aiExport: true, level, text }); } catch (_) {}
  };
  const log = (...a) => { console.log('%c[zhipu-export]', 'color:#3859ff;font-weight:bold', ...a); report('info', a.map(String).join(' ')); };
  const warn = (...a) => { console.warn('[zhipu-export]', ...a); report('warn', a.map(String).join(' ')); };

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

  // ---- 登录态：cookie 优先，localStorage token 兜底 ----
  function getTokenHeader() {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (/token/i.test(k)) {
        let v = localStorage.getItem(k);
        try { const o = JSON.parse(v); v = o.value || o.token || o.access_token || v; } catch (_) {}
        if (v && String(v).length > 20) return { Authorization: `Bearer ${String(v).replace(/^"|"$/g, '')}` };
      }
    }
    return {};
  }
  const authHeaders = { accept: 'application/json', 'Content-Type': 'application/json', ...getTokenHeader() };

  async function apiGet(path, attempt = 0) {
    let res;
    try {
      res = await fetch(path, { credentials: 'include', headers: authHeaders });
    } catch (err) {
      if (attempt >= CONFIG.maxRetries) throw err;
      const wait = 1000 * 2 ** attempt;
      warn(`网络错误，${wait}ms 后重试：${path}`);
      await sleep(wait);
      return apiGet(path, attempt + 1);
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= CONFIG.maxRetries) throw new Error(`HTTP ${res.status}：${path}（重试已用尽）`);
      const wait = 2000 * 2 ** attempt;
      warn(`HTTP ${res.status}，${wait}ms 后重试`);
      await sleep(wait);
      return apiGet(path, attempt + 1);
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
  const pickArr = (o, ...keys) => {
    for (const k of keys) {
      const v = o && (o[k] || (o.result && o.result[k]) || (o.data && o.data[k]));
      if (Array.isArray(v)) return v;
    }
    if (o && o.result && Array.isArray(o.result.conversation_list)) return o.result.conversation_list;
    return [];
  };

  // ---- 1. 会话列表 ----
  async function listConversations() {
    const items = [];
    let page = 1;
    for (;;) {
      const qs = `assistant_id=${encodeURIComponent(CONFIG.assistantId)}&page=${page}&page_size=${CONFIG.pageSize}`;
      const data = await apiGet(`/chatglm/backend-api/assistant/conversation/list?${qs}`);
      const arr = pickArr(data, 'conversation_list', 'list', 'items', 'conversations');
      if (!arr.length) break;
      items.push(...arr);
      log(`已获取会话列表 ${items.length}`);
      if (arr.length < CONFIG.pageSize) break;
      page++;
      await sleep(CONFIG.requestDelayMs);
    }
    return items;
  }

  // ---- 2. 会话详情 → 消息 ----
  function extractText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : (c && (c.text || c.content)) || '')).filter(Boolean).join('\n');
    if (content && typeof content === 'object') return content.text || content.content || '';
    return '';
  }
  function toMessages(node) {
    // 智谱一条记录常含 query（用户）+ response/answer（助手）
    const out = [];
    const created = toIso(node.create_time || node.created_at || node.update_time);
    const q = extractText(node.query || node.prompt || (node.role && String(node.role).toLowerCase() === 'user' ? node.content : ''));
    if (q && q.trim()) out.push({ role: 'user', kind: 'message', text: q, createTime: created });
    let a = '';
    if (Array.isArray(node.response)) a = node.response.map((r) => extractText(r.content || r.text || r)).filter(Boolean).join('\n');
    else a = extractText(node.answer || node.response || (node.role && String(node.role).toLowerCase() !== 'user' ? node.content : ''));
    for (const f of (node.files || node.attachments || [])) {
      a += `\n[附件: ${(f && (f.file_name || f.name)) || '文件'}]`;
      if (convAssets && f) {
        const u = f.file_url || f.url || f.download_url;
        if (u) convAssets.push({ url: u, name: f.file_name || f.name || '' });
      }
    }
    if (a && a.trim()) out.push({ role: 'assistant', kind: 'message', text: a.trim(), createTime: created });
    return out;
  }

  // ---- 3. 主流程 ----
  let list = await listConversations();
  const idOf = (it) => String(it.conversation_id || it.id);
  const titleOf = (it) => it.title || it.conversation_title || '(无标题)';
  const timeOf = (it) => it.update_time || it.updated_at || it.create_time || null;

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
      const qs = `assistant_id=${encodeURIComponent(CONFIG.assistantId)}&conversation_id=${encodeURIComponent(id)}&page=1&page_size=200`;
      let data;
      try {
        data = await apiGet(`/chatglm/backend-api/assistant/conversation/detail?${qs}`);
      } catch (err) {
        data = await apiGet(`/chatglm/backend-api/assistant/conversation/history?${qs}`);
      }
      const raw = pickArr(data, 'history', 'messages', 'list', 'chat_list', 'conversation_history');
      convAssets = CONFIG.downloadAssets ? [] : null;
      const messages = raw.flatMap(toMessages).filter(Boolean);
      conversations.push({
        id, title,
        createTime: toIso(item.create_time || item.created_at),
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
    source: 'chatglm.cn',
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
