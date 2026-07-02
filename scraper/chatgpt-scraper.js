/**
 * ChatGPT 对话抓取脚本（API 版，推荐）
 * ------------------------------------------------------------------
 * 用法：
 *   1. 登录 https://chatgpt.com
 *   2. 打开开发者工具（F12）→ Console
 *   3. 粘贴整个脚本，回车运行
 *   4. 等待抓取完成，浏览器会自动下载 conversations.json
 *
 * 原理：直接在页面内调用 ChatGPT 自己的后端接口
 * （/backend-api/conversations 列表 + /backend-api/conversation/{id} 详情），
 * 用的是你当前登录态，不依赖页面 DOM 结构，天然拿到完整消息树和时间戳，
 * 也不存在「侧边栏/消息懒加载」的问题（列表接口自带分页）。
 * 如果某天接口变动导致本脚本失效，可改用同目录下的 chatgpt-scraper-dom.js（DOM 备用版）。
 */
(async () => {
  // ======================= 可调配置 =======================
  const CONFIG = {
    // 最多抓取多少个对话（Infinity = 全部）
    maxConversations: Infinity,
    // 是否包含已归档对话
    includeArchived: true,
    // 每次请求之间的间隔（毫秒），太小容易触发限流
    requestDelayMs: 350,
    // 列表分页大小（接口上限一般为 100）
    pageSize: 100,
    // 遇到限流/网络错误时最多重试次数
    maxRetries: 5,
    // 下载的文件名
    outputFilename: 'conversations.json',
  };
  // ========================================================

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const log = (...args) => console.log('%c[chatgpt-export]', 'color:#10a37f;font-weight:bold', ...args);
  const warn = (...args) => console.warn('[chatgpt-export]', ...args);

  // ---- 1. 拿 accessToken ----
  async function getAccessToken() {
    const res = await fetch('/api/auth/session', { credentials: 'include' });
    if (!res.ok) throw new Error(`获取登录态失败（HTTP ${res.status}），请确认已登录 chatgpt.com`);
    const data = await res.json();
    if (!data || !data.accessToken) {
      throw new Error('未拿到 accessToken，请刷新页面、确认已登录后重试');
    }
    return data.accessToken;
  }

  const token = await getAccessToken();
  const authHeaders = { Authorization: `Bearer ${token}` };

  // ---- 2. 带重试的请求 ----
  async function apiGet(path, attempt = 0) {
    let res;
    try {
      res = await fetch(path, { headers: authHeaders, credentials: 'include' });
    } catch (err) {
      if (attempt >= CONFIG.maxRetries) throw err;
      const wait = 1000 * 2 ** attempt;
      warn(`网络错误，${wait}ms 后重试（${attempt + 1}/${CONFIG.maxRetries}）：${path}`);
      await sleep(wait);
      return apiGet(path, attempt + 1);
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= CONFIG.maxRetries) throw new Error(`HTTP ${res.status}：${path}（重试已用尽）`);
      const wait = 2000 * 2 ** attempt;
      warn(`HTTP ${res.status}（限流/服务端错误），${wait}ms 后重试（${attempt + 1}/${CONFIG.maxRetries}）`);
      await sleep(wait);
      return apiGet(path, attempt + 1);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`HTTP ${res.status}：登录态失效，请刷新页面重新运行脚本`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}：${path}`);
    return res.json();
  }

  // ---- 3. 分页拉取对话列表 ----
  async function listConversations(archived) {
    const items = [];
    let offset = 0;
    for (;;) {
      const qs = `offset=${offset}&limit=${CONFIG.pageSize}&order=updated` + (archived ? '&is_archived=true' : '');
      const data = await apiGet(`/backend-api/conversations?${qs}`);
      const page = data.items || [];
      items.push(...page);
      log(`已获取${archived ? '归档' : ''}对话列表 ${items.length}${data.total ? ' / ' + data.total : ''}`);
      if (page.length < CONFIG.pageSize) break;
      offset += CONFIG.pageSize;
      await sleep(CONFIG.requestDelayMs);
    }
    return items;
  }

  // ---- 4. 消息内容抽取 ----
  function toIso(v) {
    if (v == null) return null;
    if (typeof v === 'number') return new Date(v * 1000).toISOString();
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  // 把一条消息的 content 转成纯文本（markdown），图片等非文本部分用占位符
  function extractContent(content) {
    if (!content) return '';
    const partToText = (p) => {
      if (typeof p === 'string') return p;
      if (!p || typeof p !== 'object') return '';
      if (p.content_type === 'image_asset_pointer') return '[图片]';
      if (p.content_type === 'video_container_asset_pointer') return '[视频]';
      if (p.content_type === 'audio_asset_pointer') return '[音频]';
      if (p.content_type === 'audio_transcription') return p.text || '';
      if (typeof p.text === 'string') return p.text;
      return '';
    };
    switch (content.content_type) {
      case 'text':
      case 'multimodal_text':
        return (content.parts || []).map(partToText).filter(Boolean).join('\n');
      case 'thoughts':
        return (content.thoughts || [])
          .map((t) => [t.summary, t.content].filter(Boolean).join('\n'))
          .join('\n\n');
      case 'reasoning_recap':
        return content.content || '';
      case 'code':
        return content.text ? '```\n' + content.text + '\n```' : '';
      case 'execution_output':
        return content.text ? '```\n' + content.text + '\n```' : '';
      case 'user_editable_context':
        return content.user_instructions || content.user_profile || '';
      default:
        if (typeof content.text === 'string') return content.text;
        if (Array.isArray(content.parts)) return content.parts.map(partToText).filter(Boolean).join('\n');
        return '';
    }
  }

  // 消息分类：message（普通对话）/ reasoning（思维链）/ system / tool
  function classify(message) {
    const role = message.author && message.author.role;
    const ct = message.content && message.content.content_type;
    if (ct === 'thoughts' || ct === 'reasoning_recap') return 'reasoning';
    if (role === 'system' || ct === 'user_editable_context') return 'system';
    if (role === 'tool') return 'tool';
    return 'message';
  }

  // 从消息树（mapping）沿 current_node 回溯出当前分支的线性消息列表
  function extractMessages(detail) {
    const mapping = detail.mapping || {};
    const chain = [];
    let id = detail.current_node;
    let guard = 0;
    while (id && guard++ < 10000) {
      const node = mapping[id];
      if (!node) break;
      if (node.message) chain.push(node.message);
      id = node.parent;
    }
    chain.reverse();

    const messages = [];
    for (const m of chain) {
      const kind = classify(m);
      // 普通消息里被界面隐藏的节点（如内部标记）直接跳过
      if (kind === 'message' && m.metadata && m.metadata.is_visually_hidden_from_conversation) continue;
      const text = extractContent(m.content);
      if (!text.trim()) continue;
      messages.push({
        role: (m.author && m.author.role) || 'unknown',
        kind,
        text,
        createTime: toIso(m.create_time),
        model: (m.metadata && m.metadata.model_slug) || undefined,
      });
    }
    return messages;
  }

  // ---- 5. 主流程 ----
  let list = await listConversations(false);
  if (CONFIG.includeArchived) {
    try {
      const archived = await listConversations(true);
      const seen = new Set(list.map((c) => c.id));
      list = list.concat(archived.filter((c) => !seen.has(c.id)));
    } catch (err) {
      warn('获取归档对话失败（忽略）：', err.message);
    }
  }
  if (list.length > CONFIG.maxConversations) list = list.slice(0, CONFIG.maxConversations);
  log(`共 ${list.length} 个对话，开始逐个抓取详情…`);

  const conversations = [];
  const failures = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const title = item.title || '(无标题)';
    try {
      const detail = await apiGet(`/backend-api/conversation/${item.id}`);
      conversations.push({
        id: item.id,
        title: detail.title || title,
        createTime: toIso(detail.create_time) || toIso(item.create_time),
        updateTime: toIso(detail.update_time) || toIso(item.update_time),
        messages: extractMessages(detail),
      });
      log(`[${i + 1}/${list.length}] ✓ ${title}`);
    } catch (err) {
      failures.push({ id: item.id, title, error: String(err && err.message) });
      warn(`[${i + 1}/${list.length}] ✗ ${title}：${err.message}`);
    }
    await sleep(CONFIG.requestDelayMs);
  }

  // ---- 6. 下载 JSON ----
  const payload = {
    schema: 'chatgpt-export/v1',
    source: 'chatgpt.com',
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
