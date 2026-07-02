/**
 * Claude 对话抓取脚本（API 版）
 * ------------------------------------------------------------------
 * 用法：
 *   1. 登录 https://claude.ai
 *   2. F12 打开开发者工具 → Console
 *   3. 粘贴整个脚本运行，等待完成后自动下载 conversations.json
 *
 * 原理：在页面内调用 claude.ai 自己的接口（cookie 登录态，无需 token）：
 *   /api/organizations                                    → 组织 id
 *   /api/organizations/{org}/chat_conversations           → 对话列表
 *   /api/organizations/{org}/chat_conversations/{uuid}    → 对话详情
 * 输出与 ChatGPT 抓取脚本相同的 JSON 结构，可直接喂给 export.js。
 */
(async () => {
  // ======================= 可调配置 =======================
  const CONFIG = {
    maxConversations: Infinity, // 最多抓取多少个对话
    requestDelayMs: 350,        // 请求间隔（毫秒）
    maxRetries: 5,              // 限流/网络错误重试次数
    toolTextLimit: 2000,        // 工具调用/结果最多保留多少字符
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
  const log = (...a) => { console.log('%c[claude-export]', 'color:#d97757;font-weight:bold', ...a); report('info', a.map(String).join(' ')); };
  const warn = (...a) => { console.warn('[claude-export]', ...a); report('warn', a.map(String).join(' ')); };

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

  // ---- 1. 确定组织 id（优先 lastActiveOrg cookie，退回组织列表第一个）----
  async function getOrgId() {
    const m = document.cookie.match(/(?:^|;\s*)lastActiveOrg=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
    const orgs = await apiGet('/api/organizations');
    if (!Array.isArray(orgs) || !orgs.length) throw new Error('拿不到组织信息，请确认已登录 claude.ai');
    const chatOrg = orgs.find((o) => (o.capabilities || []).includes('chat')) || orgs[0];
    return chatOrg.uuid;
  }

  const orgId = await getOrgId();
  log('组织 id:', orgId);

  // ---- 2. 对话列表（带分页尝试；接口若不认分页参数则靠去重兜底）----
  async function listConversations() {
    const seen = new Map();
    const limit = 200;
    for (let offset = 0; ; offset += limit) {
      const page = await apiGet(
        `/api/organizations/${orgId}/chat_conversations?limit=${limit}&offset=${offset}`
      );
      const items = Array.isArray(page) ? page : page.chat_conversations || page.items || [];
      let added = 0;
      for (const it of items) {
        if (it && it.uuid && !seen.has(it.uuid)) { seen.set(it.uuid, it); added++; }
      }
      log(`已获取对话列表 ${seen.size}`);
      if (added === 0 || items.length < limit) break;
      await sleep(CONFIG.requestDelayMs);
    }
    return [...seen.values()];
  }

  // ---- 3. 消息抽取 ----
  function toIso(v) {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  function blockContentText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((c) => (typeof c === 'string' ? c : (c && c.type === 'text' && c.text) || ''))
        .filter(Boolean)
        .join('\n');
    }
    return '';
  }

  // 一条 chat_message 可能拆成多条导出消息：思考(reasoning) + 工具(tool) + 正文(message)
  function extractFromChatMessage(m) {
    const role = m.sender === 'human' ? 'user' : 'assistant';
    const created = toIso(m.created_at);
    const texts = [];
    const thinkings = [];
    const tools = [];

    const blocks = Array.isArray(m.content) ? m.content : [];
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && b.text) texts.push(b.text);
      else if (b.type === 'thinking' && (b.thinking || b.text)) thinkings.push(b.thinking || b.text);
      else if (b.type === 'image') texts.push('[图片]');
      else if (b.type === 'tool_use') {
        const input = b.input ? JSON.stringify(b.input, null, 2).slice(0, CONFIG.toolTextLimit) : '';
        tools.push(`[工具调用] ${b.name || ''}${input ? '\n```json\n' + input + '\n```' : ''}`);
      } else if (b.type === 'tool_result') {
        const t = blockContentText(b.content).slice(0, CONFIG.toolTextLimit);
        if (t) tools.push('[工具结果]\n' + t);
      }
    }
    // 老格式：没有 content 块时退回顶层 text
    if (!texts.length && typeof m.text === 'string' && m.text.trim()) texts.push(m.text);
    // 附件 / 上传的文件
    for (const a of m.attachments || []) texts.push(`[附件: ${(a && a.file_name) || '文件'}]`);
    for (const f of m.files || []) {
      texts.push(f && f.file_kind === 'image' ? '[图片]' : `[文件: ${(f && f.file_name) || ''}]`);
    }

    const out = [];
    if (thinkings.length) out.push({ role: 'assistant', kind: 'reasoning', text: thinkings.join('\n\n'), createTime: created });
    for (const t of tools) out.push({ role: 'assistant', kind: 'tool', text: t, createTime: created });
    const text = texts.join('\n').trim();
    if (text) out.push({ role, kind: 'message', text, createTime: created });
    return out;
  }

  // ---- 4. 主流程 ----
  let list = await listConversations();
  // 按更新时间倒序 → 抓取时新对话在前
  list.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
  // 抓取前筛选（插件设置）：标题关键词 / 时间范围，减少不必要的请求
  if (CONFIG.titleKeyword) {
    const kw = String(CONFIG.titleKeyword).toLowerCase();
    list = list.filter((it) => String(it.name || '').toLowerCase().includes(kw));
  }
  if (CONFIG.fromDate || CONFIG.toDate) {
    const from = CONFIG.fromDate ? new Date(CONFIG.fromDate) : null;
    const to = CONFIG.toDate ? new Date(CONFIG.toDate + 'T23:59:59.999') : null;
    list = list.filter((it) => {
      const t = new Date(it.updated_at || it.created_at || 0);
      return (!from || t >= from) && (!to || t <= to);
    });
  }
  if (list.length > CONFIG.maxConversations) list = list.slice(0, CONFIG.maxConversations);
  log(`共 ${list.length} 个对话，开始逐个抓取详情…`);

  const conversations = [];
  const failures = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const title = item.name || '(无标题)';
    try {
      const detail = await apiGet(
        `/api/organizations/${orgId}/chat_conversations/${item.uuid}?tree=True&rendering_mode=messages&render_all_tools=true`
      );
      const messages = (detail.chat_messages || []).flatMap(extractFromChatMessage);
      conversations.push({
        id: item.uuid,
        title: detail.name || title,
        createTime: toIso(detail.created_at) || toIso(item.created_at),
        updateTime: toIso(detail.updated_at) || toIso(item.updated_at),
        messages,
      });
      log(`[${i + 1}/${list.length}] ✓ ${title}`);
    } catch (err) {
      failures.push({ id: item.uuid, title, error: String(err && err.message) });
      warn(`[${i + 1}/${list.length}] ✗ ${title}：${err.message}`);
    }
    await sleep(CONFIG.requestDelayMs);
  }

  // ---- 5. 下载 JSON ----
  const payload = {
    schema: 'chatgpt-export/v1',
    source: 'claude.ai',
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
