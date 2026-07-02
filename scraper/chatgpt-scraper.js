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

  // 浏览器插件注入时通过 globalThis.__AI_EXPORT_CONFIG 覆盖配置；控制台直接运行时无影响
  try { Object.assign(CONFIG, globalThis.__AI_EXPORT_CONFIG || {}); } catch (_) {}
  if (!CONFIG.maxConversations) CONFIG.maxConversations = Infinity;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 浏览器插件注入时把进度回传给弹窗；控制台直接运行时静默跳过
  const report = (level, text) => {
    try { chrome.runtime.sendMessage({ __aiExport: true, level, text }); } catch (_) {}
  };
  const log = (...args) => { console.log('%c[chatgpt-export]', 'color:#10a37f;font-weight:bold', ...args); report('info', args.map(String).join(' ')); };
  const warn = (...args) => { console.warn('[chatgpt-export]', ...args); report('warn', args.map(String).join(' ')); };

  // ---- 1. 拿 accessToken ----
  // 兜底：会话接口不可用时，从页面内嵌的启动数据里找 accessToken
  function findTokenInPage() {
    try {
      for (const s of document.querySelectorAll('script')) {
        const m = (s.textContent || '').match(/"accessToken"\s*:\s*"([^"]+)"/);
        if (m) return m[1];
      }
    } catch (_) {}
    return null;
  }

  // /api/auth/session 经常瞬时 503（Cloudflare/服务端抖动），必须带重试
  async function getAccessToken() {
    let lastErr = null;
    for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
      if (attempt > 0) {
        const wait = 1500 * 2 ** (attempt - 1);
        warn(`获取登录态失败（${lastErr && lastErr.message}），${wait}ms 后重试（${attempt}/${CONFIG.maxRetries}）`);
        await sleep(wait);
      }
      try {
        const res = await fetch('/api/auth/session', {
          credentials: 'include',
          cache: 'no-store',
          headers: { accept: 'application/json' },
        });
        if (res.status === 401 || res.status === 403) {
          throw new Error(`HTTP ${res.status}：未登录或登录已过期，请刷新页面重新登录后再试`);
        }
        if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue; }
        const data = await res.json().catch(() => null);
        if (data && data.accessToken) return data.accessToken;
        lastErr = new Error('会话接口没有返回 accessToken');
      } catch (err) {
        if (/未登录或登录已过期/.test(String(err && err.message))) throw err;
        lastErr = err;
      }
    }
    const fromPage = findTokenInPage();
    if (fromPage) {
      warn('会话接口不可用，已从页面数据中取得登录态，继续抓取');
      return fromPage;
    }
    throw new Error(
      `获取登录态失败（${lastErr && lastErr.message}）。请依次尝试：` +
      '① 刷新 chatgpt.com 页面、随便发一句话确认能正常对话后重试；' +
      '② 等一两分钟再试（503 通常是服务端瞬时问题）；' +
      '③ 仍不行就改用 DOM 备用版（scraper/chatgpt-scraper-dom.js 粘到控制台运行）'
    );
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
  // 插件「选择对话」：勾选了具体对话时只抓这些，忽略其它筛选
  const selectedSet = Array.isArray(CONFIG.selectedIds) && CONFIG.selectedIds.length
    ? new Set(CONFIG.selectedIds) : null;
  if (selectedSet) {
    list = list.filter((it) => selectedSet.has(String(it.id)));
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
        const t = new Date(it.update_time || it.create_time || 0);
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
        items: list.map((it) => ({ id: String(it.id), title: it.title || '(无标题)', time: it.update_time || it.create_time || null })),
      });
    } catch (_) {}
    log(`已回传对话列表（${list.length} 个），请在弹窗中勾选…`);
    return;
  }
  if (!selectedSet && list.length > CONFIG.maxConversations) list = list.slice(0, CONFIG.maxConversations);
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
