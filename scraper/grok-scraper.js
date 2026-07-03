/**
 * Grok 对话抓取脚本（API 版，适用于 grok.com 独立站）
 * ------------------------------------------------------------------
 * 用法：
 *   1. 登录 https://grok.com
 *   2. F12 打开开发者工具 → Console
 *   3. 粘贴整个脚本运行，等待完成后自动下载 conversations.json
 *
 * 原理：在页面内调用 grok.com 自己的 REST 接口（cookie 登录态）：
 *   /rest/app-chat/conversations                       → 对话列表（分页）
 *   /rest/app-chat/conversations/{id}/load-responses   → 对话消息
 * 输出与 ChatGPT 抓取脚本相同的 JSON 结构，可直接喂给 export.js。
 *
 * 注意：X（推特）内嵌的 Grok 走的是另一套接口，本脚本不适用。
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
  const log = (...a) => { console.log('%c[grok-export]', 'color:#1d9bf0;font-weight:bold', ...a); report('info', a.map(String).join(' ')); };
  const warn = (...a) => { console.warn('[grok-export]', ...a); report('warn', a.map(String).join(' ')); };

  // ---- 对话内文件下载（CONFIG.downloadAssets 开启时生效）----
  let convAssets = null; // 当前对话待下载的资产
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
      const key = asset.fileId || asset.url || asset.name;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      try {
        let blob;
        let name = asset.name || '';
        if (asset.text != null) {
          blob = new Blob([asset.text], { type: 'text/plain;charset=utf-8' });
        } else {
          let url = asset.url;
          // 直接使用收集到的 URL（相对路径补当前站点 origin）
          if (url && url.startsWith('/')) url = location.origin + url;
          if (!url) throw new Error('无下载地址');
          const res = await fetch(url, { credentials: 'include' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          blob = await res.blob();
          if (!name) name = `${asset.fileId || 'file'}.${extFromMime(blob.type)}`;
        }
        if (!/\.[A-Za-z0-9]{1,5}$/.test(name)) name += `.${extFromMime(blob.type)}`;
        const filename = `${pad3(convIndex)}-${safeAssetName(name)}`;
        downloadBlobFile(blob, filename);
        assetStats.ok++;
        log(`已下载 ${filename}`);
      } catch (err) {
        assetStats.fail++;
        warn(`文件下载失败（${asset.name || asset.fileId || asset.url || '?'}）：${err && err.message}`);
      }
      await sleep(400);
    }
  }


  async function apiGet(path, attempt = 0) {
    let res;
    try {
      res = await fetch(path, { credentials: 'include', headers: { accept: 'application/json' } });
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
    if (res.status === 401 || res.status === 403) {
      throw new Error(`HTTP ${res.status}：登录态失效，请刷新页面重新运行`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}：${path}`);
    return res.json();
  }

  function toIso(v) {
    if (!v) return null;
    // 兼容 ISO 字符串和毫秒/秒时间戳
    const n = Number(v);
    const d = Number.isFinite(n) && String(v).length >= 10
      ? new Date(n > 1e12 ? n : n * 1000)
      : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  // ---- 1. 分页拉取对话列表 ----
  async function listConversations() {
    const items = [];
    let pageToken = '';
    for (;;) {
      const qs = `pageSize=${CONFIG.pageSize}` + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
      const data = await apiGet(`/rest/app-chat/conversations?${qs}`);
      const page = data.conversations || data.items || [];
      items.push(...page);
      log(`已获取对话列表 ${items.length}`);
      pageToken = data.nextPageToken || data.next_page_token || '';
      if (!pageToken || page.length === 0) break;
      await sleep(CONFIG.requestDelayMs);
    }
    return items;
  }

  // ---- 2. 消息抽取 ----
  function toMessage(r) {
    if (!r) return null;
    const sender = String(r.sender || r.role || '').toLowerCase();
    const role = sender.includes('human') || sender.includes('user') ? 'user' : 'assistant';
    const parts = [];
    if (typeof r.message === 'string' && r.message.trim()) parts.push(r.message);
    if (Array.isArray(r.generatedImageUrls) && r.generatedImageUrls.length) {
      parts.push(Array(r.generatedImageUrls.length).fill('[图片]').join(' '));
      if (convAssets) {
        for (const u of r.generatedImageUrls) {
          // 相对路径按 assets.grok.com 拼接尝试（best-effort）
          const url = /^https?:/i.test(u) ? u : 'https://assets.grok.com/' + String(u).replace(/^\//, '');
          convAssets.push({ url, name: (String(u).split('/').pop() || '').split('?')[0] });
        }
      }
    }
    for (const f of r.fileAttachments || []) {
      parts.push(`[附件: ${(f && (f.fileName || f.name)) || '文件'}]`);
      if (convAssets && f) {
        const u = f.url || f.downloadUrl || f.fileUri;
        if (u) convAssets.push({ url: u, name: f.fileName || f.name || '' });
        else warn(`附件暂无可用下载地址，已跳过：${f.fileName || f.name || '?'}`);
      }
    }
    if (Array.isArray(r.mediaTypes) && r.mediaTypes.some((t) => String(t).toLowerCase().includes('image'))) {
      if (!parts.some((p) => p.includes('[图片]'))) parts.push('[图片]');
    }
    const text = parts.join('\n').trim();
    if (!text) return null;
    return { role, kind: 'message', text, createTime: toIso(r.createTime || r.create_time) };
  }

  // ---- 3. 主流程 ----
  let list = await listConversations();
  // 插件「选择对话」：勾选了具体对话时只抓这些，忽略其它筛选
  const selectedSet = Array.isArray(CONFIG.selectedIds) && CONFIG.selectedIds.length
    ? new Set(CONFIG.selectedIds) : null;
  if (selectedSet) {
    list = list.filter((it) => selectedSet.has(String(it.conversationId || it.conversation_id || it.id)));
  } else {
    // 抓取前筛选（插件设置）：标题关键词 / 时间范围，减少不必要的请求
    if (CONFIG.titleKeyword) {
      const kw = String(CONFIG.titleKeyword).toLowerCase();
      list = list.filter((it) => String(it.title || '').toLowerCase().includes(kw));
    }
    if (CONFIG.fromDate || CONFIG.toDate) {
      const from = CONFIG.fromDate ? new Date(CONFIG.fromDate) : null;
      const to = CONFIG.toDate ? new Date(CONFIG.toDate + 'T23:59:59.999') : null;
      list = list.filter((it) => {
        const t = new Date(it.modifyTime || it.createTime || 0);
        return (!from || t >= from) && (!to || t <= to);
      });
    }
  }
  // 插件「选择对话」列表模式：只回传对话清单（不抓详情），供弹窗勾选
  if (CONFIG.listOnly) {
    try {
      chrome.runtime.sendMessage({
        __aiExport: true,
        level: 'list',
        items: list.map((it) => ({ id: String(it.conversationId || it.conversation_id || it.id), title: it.title || '(无标题)', time: it.modifyTime || it.createTime || null })),
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
    const id = item.conversationId || item.conversation_id || item.id;
    const title = item.title || '(无标题)';
    try {
      const data = await apiGet(`/rest/app-chat/conversations/${id}/load-responses`);
      const responses = data.responses || data.responseNodes || [];
      convAssets = CONFIG.downloadAssets ? [] : null;
      const messages = responses
        .slice()
        .sort((a, b) => new Date(a.createTime || a.create_time || 0) - new Date(b.createTime || b.create_time || 0))
        .map(toMessage)
        .filter(Boolean);
      conversations.push({
        id,
        title,
        createTime: toIso(item.createTime || item.create_time),
        updateTime: toIso(item.modifyTime || item.modify_time || item.updateTime),
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
    source: 'grok.com',
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
