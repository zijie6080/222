/**
 * 插件端多格式导出（由 popup 在抓取脚本之前注入）。
 * 定义两个全局钩子：
 *   __AI_EXPORT_BUILD(payload, cfg) → [{name, text, mime}]  纯函数，便于测试
 *   __AI_EXPORT_EMIT(payload, cfg)  → 生成文件并逐个触发下载、回报进度
 * 控制台直接粘贴抓取脚本运行时没有这两个钩子，脚本退回只下载 JSON。
 *
 * 注意：插件端的 Markdown/TXT/HTML 是轻量版（HTML 不做 markdown 渲染与代码高亮）；
 * 要出高质量排版和 PDF，请用仓库里的本地命令 node export.js。
 */
(() => {
  const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const pad = (n) => String(n).padStart(2, '0');

  // 导出产物标签的多语言表（cfg.lang: zh/en/ja，默认 zh，控制台老用法不变）
  const L10N = {
    zh: {
      user: '用户', assistant: '助手', thinking: '助手 · 思考过程', tool: '工具输出',
      system: '系统', unknown: '未知', untitled: '(无标题)',
      created: (t) => `创建于 ${t}`, updated: (t) => `最后更新 ${t}`, msgs: (n) => `${n} 条消息`,
      exportedAt: (t) => `导出时间 ${t}`, total: (n) => `共 ${n} 个对话`, toc: '目录', original: '原对话',
      docTitle: (name) => (name ? `${name} 对话导出` : '聊天记录导出'),
      printHint: '🖨 按 <b>Ctrl/⌘ + P</b>，目标选择「另存为 PDF」即可生成 PDF。此提示条不会被打印。需要带精确页码目录和代码高亮的高质量 PDF，请用仓库里的本地命令 node export.js。',
    },
    en: {
      user: 'User', assistant: 'Assistant', thinking: 'Assistant · Thinking', tool: 'Tool output',
      system: 'System', unknown: 'Unknown', untitled: '(untitled)',
      created: (t) => `Created ${t}`, updated: (t) => `Updated ${t}`, msgs: (n) => `${n} messages`,
      exportedAt: (t) => `Exported at ${t}`, total: (n) => `${n} conversations`, toc: 'Contents', original: 'Original chat',
      docTitle: (name) => (name ? `${name} Conversation Export` : 'Chat Export'),
      printHint: '🖨 Press <b>Ctrl/⌘ + P</b> and choose "Save as PDF" as the destination. This banner will not be printed. For a high-quality PDF with page-numbered TOC and code highlighting, use the local command node export.js.',
    },
    ja: {
      user: 'ユーザー', assistant: 'アシスタント', thinking: 'アシスタント・思考', tool: 'ツール出力',
      system: 'システム', unknown: '不明', untitled: '（無題）',
      created: (t) => `作成 ${t}`, updated: (t) => `最終更新 ${t}`, msgs: (n) => `${n} 件のメッセージ`,
      exportedAt: (t) => `エクスポート日時 ${t}`, total: (n) => `全 ${n} 件の会話`, toc: '目次', original: '元の会話',
      docTitle: (name) => (name ? `${name} 会話エクスポート` : 'チャット履歴エクスポート'),
      printHint: '🖨 <b>Ctrl/⌘ + P</b> を押して出力先に「PDF に保存」を選ぶと PDF を生成できます。このバナーは印刷されません。ページ番号付き目次とコードハイライトの高品質 PDF はローカルコマンド node export.js をご利用ください。',
    },
  };
  const langOf = (cfg) => L10N[(cfg && cfg.lang)] || L10N.zh;

  // timeStyle: 'iso'（默认，24h）| 'zh'（中文日期）| '12h'
  function fmtTime(iso, timeStyle) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    if (timeStyle === 'zh') {
      return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    if (timeStyle === '12h') {
      const h = d.getHours();
      const ap = h < 12 ? '上午' : '下午';
      const h12 = h % 12 === 0 ? 12 : h % 12;
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${ap} ${h12}:${pad(d.getMinutes())}`;
    }
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function roleLabel(m, L) {
    if (m.kind === 'reasoning') return L.thinking;
    if (m.kind === 'tool') return L.tool;
    if (m.kind === 'system' || m.role === 'system') return L.system;
    if (m.role === 'user') return L.user;
    if (m.role === 'assistant') return L.assistant;
    return m.role || L.unknown;
  }

  function msgClass(m) {
    if (m.kind === 'reasoning') return 'reasoning';
    if (m.kind === 'system' || m.role === 'system' || m.kind === 'tool') return 'system';
    return m.role === 'user' ? 'user' : 'assistant';
  }

  function convUrl(source, id) {
    if (!id) return '';
    const s = String(source || '').toLowerCase();
    if (s.includes('chatgpt')) return `https://chatgpt.com/c/${id}`;
    if (s.includes('claude')) return `https://claude.ai/chat/${id}`;
    if (s.includes('gemini')) return `https://gemini.google.com/app/${id}`;
    if (s.includes('grok')) return `https://grok.com/c/${id}`;
    return '';
  }

  function docTitle(source, L) {
    const s = String(source || '').toLowerCase();
    if (s.includes('claude')) return L.docTitle('Claude');
    if (s.includes('gemini')) return L.docTitle('Gemini');
    if (s.includes('grok')) return L.docTitle('Grok');
    if (s.includes('chatgpt')) return L.docTitle('ChatGPT');
    return L.docTitle('');
  }

  function sanitize(name) {
    return String(name)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'untitled';
  }

  // 内容开关只影响 Markdown/TXT/HTML；JSON 始终保留完整数据（作为档案源）
  function prepare(payload, cfg) {
    const convs = [];
    for (const c of payload.conversations || []) {
      const messages = (c.messages || []).filter((m) => {
        if (!m || typeof m.text !== 'string' || !m.text.trim()) return false;
        const kind = m.kind || 'message';
        if (kind === 'reasoning') return !!cfg.includeReasoning;
        if (kind === 'system' || kind === 'tool') return !!cfg.includeSystem;
        return true;
      });
      if (messages.length) convs.push({ ...c, messages });
    }
    return convs;
  }

  function convMetaLines(c, cfg, source) {
    const L = langOf(cfg);
    const meta = [];
    if (c.createTime) meta.push(L.created(fmtTime(c.createTime, cfg.timeStyle)));
    if (c.updateTime) meta.push(L.updated(fmtTime(c.updateTime, cfg.timeStyle)));
    meta.push(L.msgs(c.messages.length));
    const url = cfg.includeLinks !== false ? convUrl(source, c.id) : '';
    return { meta: meta.join(' · '), url };
  }

  // ---------------- Markdown ----------------
  function convToMd(c, i, cfg, source) {
    const L = langOf(cfg);
    const { meta, url } = convMetaLines(c, cfg, source);
    const lines = [`## ${i + 1}. ${c.title || L.untitled}`, '', `> ${meta}`];
    if (url) lines.push(`>`, `> ${L.original}: <${url}>`);
    lines.push('');
    for (const m of c.messages) {
      const t = cfg.showTimestamps !== false && m.createTime ? ` · ${fmtTime(m.createTime, cfg.timeStyle)}` : '';
      lines.push(`### ${roleLabel(m, L)}${t}`, '', m.text, '');
    }
    return lines.join('\n');
  }

  function buildMd(convs, cfg, source, stamp) {
    const L = langOf(cfg);
    const header = `# ${docTitle(source, L)}\n\n> ${L.exportedAt(fmtTime(new Date().toISOString(), cfg.timeStyle))} · ${L.total(convs.length)}\n`;
    const toc = convs.map((c, i) => `- [${i + 1}. ${c.title || L.untitled}](#conv-${i})`).join('\n');
    const body = convs.map((c, i) => `<a id="conv-${i}"></a>\n\n${convToMd(c, i, cfg, source)}`).join('\n\n---\n\n');
    return `${header}\n## ${L.toc}\n\n${toc}\n\n---\n\n${body}\n`;
  }

  // ---------------- TXT ----------------
  const HR = '='.repeat(72);
  const hr2 = '-'.repeat(72);
  function convToTxt(c, i, cfg, source) {
    const L = langOf(cfg);
    const { meta, url } = convMetaLines(c, cfg, source);
    const lines = [HR, `${i + 1}. ${c.title || L.untitled}`, meta];
    if (url) lines.push(`${L.original}: ${url}`);
    lines.push(HR, '');
    for (const m of c.messages) {
      const t = cfg.showTimestamps !== false && m.createTime ? `  ${fmtTime(m.createTime, cfg.timeStyle)}` : '';
      lines.push(`【${roleLabel(m, L)}】${t}`, m.text, '', hr2, '');
    }
    return lines.join('\n');
  }

  function buildTxt(convs, cfg, source) {
    const L = langOf(cfg);
    const head = [
      docTitle(source, L),
      `${L.exportedAt(fmtTime(new Date().toISOString(), cfg.timeStyle))} · ${L.total(convs.length)}`,
      '',
    ].join('\n');
    return `${head}\n${convs.map((c, i) => convToTxt(c, i, cfg, source)).join('\n\n')}`;
  }

  // ---------------- HTML（轻量版：不渲染 markdown / 不做代码高亮）----------------
  const HTML_CSS = `
  body { margin:0; font-family:-apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
    font-size:14px; line-height:1.7; color:#1f2328; background:#fff; }
  .page { max-width:860px; margin:0 auto; padding:24px; }
  h1 { font-size:22px; margin:0 0 4px; } .doc-meta { color:#57606a; font-size:12px; margin-bottom:20px; }
  .toc a { display:block; padding:4px 2px; color:inherit; text-decoration:none; }
  .toc a:hover { color:#0b57d0; }
  section { margin-top:36px; border-top:2px solid #d0d7de; padding-top:10px; }
  section h2 { font-size:17px; margin:0 0 4px; } .conv-meta { color:#57606a; font-size:12px; }
  .conv-meta a { color:#0b57d0; }
  .msg { border-radius:8px; padding:10px 14px; margin:12px 0; border:1px solid transparent; }
  .msg-head { display:flex; justify-content:space-between; font-size:12px; margin-bottom:4px; }
  .msg-head .who { font-weight:600; } .msg-head .when { color:#57606a; }
  .msg.user { background:#e8f1fd; border-color:#c6dcf8; } .msg.user .who { color:#0b57d0; }
  .msg.assistant { background:#f6f7f9; border-color:#e3e6ea; } .msg.assistant .who { color:#10a37f; }
  .msg.reasoning { background:#fbf6e8; border-color:#efe3bd; color:#57534e; } .msg.reasoning .who { color:#9a6700; }
  .msg.system { background:#f3eefb; border-color:#e0d4f5; } .msg.system .who { color:#6639ba; }
  .msg-body { white-space:pre-wrap; overflow-wrap:break-word; word-break:break-word;
    font-variant-ligatures:none; }
  `;

  // 打印版附加样式与提示条（opts.print = true 时启用）
  const PRINT_CSS = `
  @page { margin: 14mm 12mm; }
  @media print {
    .print-hint { display: none !important; }
    section { break-before: page; }
    section:first-of-type { break-before: auto; }
    .msg { break-inside: avoid-page; }
  }
  .print-hint { position: sticky; top: 0; z-index: 9; background: #fff8e1;
    border-bottom: 1px solid #eadfa9; padding: 10px 16px; font-size: 13px; color: #6b5d1f; }
  `;
  const printHintHtml = (L) => `<div class="print-hint">${L.printHint}</div>`;
  const PRINT_SCRIPT = '<script>window.addEventListener("load",function(){setTimeout(function(){window.print();},400);});</script>';

  function buildHtml(convs, cfg, source, opts) {
    const print = !!(opts && opts.print);
    const L = langOf(cfg);
    const title = docTitle(source, L);
    const toc = convs
      .map((c, i) => `<a href="#conv-${i}">${i + 1}. ${esc(c.title || L.untitled)}</a>`)
      .join('\n');
    const sections = convs
      .map((c, i) => {
        const { meta, url } = convMetaLines(c, cfg, source);
        const link = url ? ` · <a href="${esc(url)}">${esc(L.original)}</a>` : '';
        const msgs = c.messages
          .map((m) => {
            const t = cfg.showTimestamps !== false && m.createTime ? fmtTime(m.createTime, cfg.timeStyle) : '';
            return `<div class="msg ${msgClass(m)}"><div class="msg-head"><span class="who">${esc(roleLabel(m, L))}</span><span class="when">${esc(t)}</span></div><div class="msg-body">${esc(m.text)}</div></div>`;
          })
          .join('\n');
        return `<section id="conv-${i}"><h2>${i + 1}. ${esc(c.title || L.untitled)}</h2><div class="conv-meta">${esc(meta)}${link}</div>\n${msgs}</section>`;
      })
      .join('\n');
    const htmlLang = { zh: 'zh-CN', en: 'en', ja: 'ja' }[(cfg && cfg.lang) || 'zh'] || 'zh-CN';
    return `<!DOCTYPE html>\n<html lang="${htmlLang}"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${HTML_CSS}${print ? PRINT_CSS : ''}</style></head>\n<body>${print ? printHintHtml(L) : ''}<div class="page"><h1>${esc(title)}</h1><div class="doc-meta">${esc(L.exportedAt(fmtTime(new Date().toISOString(), cfg.timeStyle)))} · ${esc(L.total(convs.length))}</div>\n<nav class="toc">${toc}</nav>\n${sections}</div>${print ? PRINT_SCRIPT : ''}</body></html>`;
  }

  // PDF 走浏览器打印通道：生成打印优化 HTML，新标签页打开后自动弹出打印对话框
  function buildPrintHtml(convs, cfg, source) {
    return buildHtml(convs, cfg, source, { print: true });
  }

  // ---------------- 汇总构建 ----------------
  globalThis.__AI_EXPORT_BUILD = (payload, cfg) => {
    cfg = cfg || {};
    const source = payload.source || '';
    const stamp = (payload.exportedAt || new Date().toISOString()).slice(0, 10);
    const prefix = cfg.filePrefix != null && cfg.filePrefix !== '' ? cfg.filePrefix : '';
    const formats = Array.isArray(cfg.formats) && cfg.formats.length ? cfg.formats : ['json'];
    const files = [];
    const add = (name, text, mime) => files.push({ name: sanitize(name), text, mime });

    if (formats.includes('json')) {
      add(`${prefix}conversations-${stamp}.json`, JSON.stringify(payload, null, 2), 'application/json');
    }

    const convs = prepare(payload, cfg);
    // datePrefix：文件名以对话日期开头（2025-06-15 标题.md），下载目录里天然按日期聚类
    const perConvName = (c, i, ext) => {
      if (cfg.datePrefix) {
        const d = String(c.createTime || c.updateTime || '').slice(0, 10) || '未知日期';
        return `${prefix}${d} ${sanitize(c.title || 'untitled')}.${ext}`;
      }
      return `${prefix}${String(i + 1).padStart(3, '0')}-${sanitize(c.title || 'untitled')}.${ext}`;
    };

    for (const f of formats) {
      if (f === 'json' || f === 'pdf') continue; // pdf 走打印通道，不产出下载文件
      if (convs.length === 0) break;
      if (f === 'md') {
        if (cfg.splitFiles) convs.forEach((c, i) => add(perConvName(c, i, 'md'), convToMd(c, i, cfg, source), 'text/markdown;charset=utf-8'));
        else add(`${prefix}export-${stamp}.md`, buildMd(convs, cfg, source, stamp), 'text/markdown;charset=utf-8');
      } else if (f === 'txt') {
        if (cfg.splitFiles) convs.forEach((c, i) => add(perConvName(c, i, 'txt'), convToTxt(c, i, cfg, source), 'text/plain;charset=utf-8'));
        else add(`${prefix}export-${stamp}.txt`, buildTxt(convs, cfg, source), 'text/plain;charset=utf-8');
      } else if (f === 'html') {
        if (cfg.splitFiles) convs.forEach((c, i) => add(perConvName(c, i, 'html'), buildHtml([c], cfg, source), 'text/html;charset=utf-8'));
        else add(`${prefix}export-${stamp}.html`, buildHtml(convs, cfg, source), 'text/html;charset=utf-8');
      }
    }
    return files;
  };

  // 打印版构建（纯函数，便于测试；popup 的「打开 PDF 打印页」按钮也会用到缓存结果）
  globalThis.__AI_EXPORT_BUILD_PRINT = (payload, cfg) => {
    cfg = cfg || {};
    return buildPrintHtml(prepare(payload, cfg), cfg, (payload && payload.source) || '');
  };

  // ---------------- 下载 ----------------
  globalThis.__AI_EXPORT_EMIT = async (payload, cfg) => {
    cfg = cfg || {};
    const report = (level, text) => {
      try { chrome.runtime.sendMessage({ __aiExport: true, level, text }); } catch (_) {}
    };

    // PDF：生成打印页并尝试自动打开；被弹窗拦截时留给完成页的按钮兜底
    const formatsWanted = Array.isArray(cfg.formats) ? cfg.formats : [];
    if (formatsWanted.includes('pdf')) {
      const printHtml = globalThis.__AI_EXPORT_BUILD_PRINT(payload, cfg);
      globalThis.__AI_EXPORT_PRINT_HTML = printHtml;
      let opened = null;
      try {
        opened = window.open('', '_blank');
        if (opened) { opened.document.write(printHtml); opened.document.close(); }
      } catch (_) { opened = null; }
      if (opened) report('info', '已打开 PDF 打印页，在打印对话框选「另存为 PDF」即可');
      else report('warn', 'PDF 打印页被浏览器拦截，请在完成页点「打开 PDF 打印页」');
    }

    const files = globalThis.__AI_EXPORT_BUILD(payload, cfg);
    if (files.length > 1) report('info', '将下载多个文件，浏览器若询问「允许下载多个文件」请点允许');
    for (const { name, text, mime } of files) {
      const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      report('info', `已下载 ${name}`);
      if (files.length > 1) await new Promise((r) => setTimeout(r, 400));
    }
  };
})();
