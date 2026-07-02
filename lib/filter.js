// 对话/消息筛选逻辑

// 先按 include-reasoning / include-system 过滤消息，再做对话级筛选，
// 这样关键词匹配只针对最终会被导出的内容。
export function applyFilters(conversations, opts) {
  const skipped = []; // {title, reason}

  const result = [];
  for (const conv of conversations) {
    const title = conv.title || '(无标题)';

    // ---- 消息级过滤 ----
    const messages = (conv.messages || []).filter((m) => {
      if (!m || typeof m.text !== 'string' || !m.text.trim()) return false;
      const kind = m.kind || 'message';
      if (kind === 'reasoning') return opts.includeReasoning;
      if (kind === 'system' || kind === 'tool') return opts.includeSystem;
      return true;
    });

    if (messages.length === 0) {
      skipped.push({ title, reason: '空对话（无可导出的消息）' });
      continue;
    }

    // ---- 标题黑名单 ----
    if (opts.titleExclude.length && opts.titleExclude.some((s) => title.includes(s))) {
      skipped.push({ title, reason: '命中标题黑名单' });
      continue;
    }
    // ---- 标题白名单 ----
    if (opts.titleInclude.length && !opts.titleInclude.some((s) => title.includes(s))) {
      skipped.push({ title, reason: '不在标题白名单' });
      continue;
    }

    // ---- 时间范围：对话的 [创建时间, 最后更新时间] 与 [from, to] 有交集即保留 ----
    if (opts.from || opts.to) {
      const created = conv.createTime ? new Date(conv.createTime) : null;
      const updated = conv.updateTime ? new Date(conv.updateTime) : created;
      if (!created && !updated) {
        // DOM 版抓取没有时间戳：保留但提醒
        skipped.push({ title, reason: null, warn: '无时间戳，时间筛选对它不生效（已保留）' });
      } else {
        const start = created || updated;
        const end = updated || created;
        if ((opts.to && start > opts.to) || (opts.from && end < opts.from)) {
          skipped.push({ title, reason: '不在时间范围内' });
          continue;
        }
      }
    }

    // ---- 关键词（标题或正文，忽略大小写）----
    if (opts.keywords.length) {
      const haystacks = [title.toLowerCase(), ...messages.map((m) => m.text.toLowerCase())];
      const hit = opts.keywords.some((kw) => {
        const k = kw.toLowerCase();
        return haystacks.some((h) => h.includes(k));
      });
      if (!hit) {
        skipped.push({ title, reason: '未命中关键词' });
        continue;
      }
    }

    result.push({ ...conv, title, messages });
  }

  // 按创建时间升序排列（无时间戳的排在最后，保持原顺序）
  result.sort((a, b) => {
    const ta = a.createTime ? new Date(a.createTime).getTime() : Infinity;
    const tb = b.createTime ? new Date(b.createTime).getTime() : Infinity;
    return ta - tb;
  });

  return { conversations: result, skipped };
}
