// HTML 生成：PDF 与 HTML 格式共用同一套模板
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';
import { escapeHtml, fmtDate, fmtDateTime, roleLabel, messageClass } from './util.js';

const require = createRequire(import.meta.url);
// 直接内嵌 highlight.js 的 GitHub 主题，保证 HTML/PDF 自包含
const HLJS_CSS = fs.readFileSync(require.resolve('highlight.js/styles/github.css'), 'utf8');

const marked = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : 'plaintext';
      try {
        return hljs.highlight(code, { language }).value;
      } catch {
        return escapeHtml(code);
      }
    },
  }),
  {
    gfm: true,
    breaks: true,
    renderer: {
      // 消息里出现的原始 HTML 一律转义展示，避免破坏排版/注入脚本
      html(token) {
        const raw = typeof token === 'string' ? token : token.raw ?? token.text ?? '';
        return escapeHtml(raw);
      },
    },
  }
);

const BASE_CSS = `
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    margin: 0;
    font-family: -apple-system, "Segoe UI", "Helvetica Neue", Arial,
      "Noto Sans SC", "Noto Sans CJK SC", "PingFang SC", "Hiragino Sans GB",
      "Source Han Sans SC", "Microsoft YaHei", sans-serif;
    font-size: 10.5pt;
    line-height: 1.7;
    color: #1f2328;
    background: #fff;
  }
  .page { max-width: 860px; margin: 0 auto; padding: 24px; }
  @media print { .page { max-width: none; padding: 0; } }

  h1.doc-title { font-size: 20pt; margin: 0 0 4px; }
  .doc-meta { color: #57606a; font-size: 9pt; margin-bottom: 20px; }

  /* ---------- 目录 ---------- */
  .toc { margin-bottom: 8px; }
  .toc h2 { font-size: 13pt; border-bottom: 2px solid #d0d7de; padding-bottom: 6px; }
  a.toc-row {
    display: flex; align-items: baseline; gap: 8px;
    padding: 5px 2px; text-decoration: none; color: inherit;
    break-inside: avoid;
  }
  a.toc-row .toc-title { max-width: 62%; }
  a.toc-row .toc-date { color: #57606a; font-size: 8.5pt; white-space: nowrap; }
  a.toc-row .dots { flex: 1; border-bottom: 1px dotted #b1b7bd; transform: translateY(-3px); }
  a.toc-row .toc-page { color: #57606a; font-size: 9pt; font-variant-numeric: tabular-nums; }

  /* ---------- 对话 ---------- */
  section.conversation { break-before: page; }
  .standalone section.conversation, .no-page-break section.conversation { break-before: auto; }
  .conv-header { border-bottom: 2px solid #d0d7de; padding-bottom: 8px; margin-bottom: 14px; }
  .conv-header h2 { font-size: 15pt; margin: 0 0 4px; }
  .conv-header .conv-meta { color: #57606a; font-size: 8.5pt; }

  /* ---------- 消息气泡 ---------- */
  .msg { border-radius: 8px; padding: 10px 14px; margin: 12px 0; border: 1px solid transparent; }
  .msg-head {
    display: flex; justify-content: space-between; align-items: baseline;
    font-size: 8.5pt; margin-bottom: 4px; break-after: avoid;
  }
  .msg-head .who { font-weight: 600; }
  .msg-head .when { color: #57606a; }
  .msg.user       { background: #e8f1fd; border-color: #c6dcf8; }
  .msg.user .who  { color: #0b57d0; }
  .msg.assistant  { background: #f6f7f9; border-color: #e3e6ea; }
  .msg.assistant .who { color: #10a37f; }
  .msg.reasoning  { background: #fbf6e8; border-color: #efe3bd; font-size: 9.5pt; color: #57534e; }
  .msg.reasoning .who { color: #9a6700; }
  .msg.system, .msg.tool { background: #f3eefb; border-color: #e0d4f5; font-size: 9.5pt; }
  .msg.system .who, .msg.tool .who { color: #6639ba; }

  .msg-body { overflow-wrap: break-word; word-break: break-word; }
  .msg-body.plain { white-space: pre-wrap; }
  .msg-body > :first-child { margin-top: 0; }
  .msg-body > :last-child { margin-bottom: 0; }

  /* ---------- markdown 元素 ---------- */
  .msg-body pre {
    background: #f0f2f5; border: 1px solid #e0e3e8; border-radius: 6px;
    padding: 10px 12px; font-size: 8.8pt; line-height: 1.5;
    white-space: pre-wrap; word-break: break-word;
  }
  .msg-body code, .msg-body pre {
    font-family: "SF Mono", Menlo, Consolas, "Liberation Mono",
      "Noto Sans Mono CJK SC", "Sarasa Mono SC", monospace;
  }
  .msg-body :not(pre) > code {
    background: #eff1f3; border-radius: 4px; padding: 1px 5px; font-size: 0.9em;
  }
  .msg.user .msg-body :not(pre) > code { background: #d8e7fb; }
  .msg-body blockquote {
    margin: 8px 0; padding: 2px 12px; border-left: 3px solid #d0d7de; color: #57606a;
  }
  .msg-body table { border-collapse: collapse; margin: 8px 0; font-size: 9.5pt; }
  .msg-body th, .msg-body td { border: 1px solid #d0d7de; padding: 4px 10px; }
  .msg-body th { background: #eef1f4; }
  .msg-body img { max-width: 100%; }
  .msg-body a { color: #0b57d0; }
  .msg-body h1, .msg-body h2, .msg-body h3 { font-size: 11.5pt; margin: 12px 0 6px; }
  .msg-body hr { border: none; border-top: 1px solid #d0d7de; }
`;

export function buildDocument({ title, bodyHtml, bodyClass = '' }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${BASE_CSS}</style>
<style>${HLJS_CSS}</style>
</head>
<body class="${bodyClass}">
<div class="page">
${bodyHtml}
</div>
</body>
</html>`;
}

export function renderMessage(msg) {
  const cls = messageClass(msg);
  const when = msg.createTime ? fmtDateTime(msg.createTime) : '';
  // assistant 相关内容按 markdown 渲染（代码块高亮）；用户输入原样转义展示
  const asMarkdown = cls === 'assistant' || cls === 'reasoning';
  const body = asMarkdown
    ? `<div class="msg-body">${marked.parse(msg.text)}</div>`
    : `<div class="msg-body plain">${escapeHtml(msg.text)}</div>`;
  return `<div class="msg ${cls}">
  <div class="msg-head"><span class="who">${escapeHtml(roleLabel(msg))}</span><span class="when">${escapeHtml(when)}</span></div>
  ${body}
</div>`;
}

export function renderConversationSection(conv, index, total) {
  const metaParts = [];
  if (conv.createTime) metaParts.push(`创建于 ${fmtDateTime(conv.createTime)}`);
  if (conv.updateTime) metaParts.push(`最后更新 ${fmtDateTime(conv.updateTime)}`);
  metaParts.push(`${conv.messages.length} 条消息`);
  if (total > 1) metaParts.push(`第 ${index + 1} / ${total} 个对话`);
  return `<section class="conversation" id="conv-${index}">
<div class="conv-header">
  <h2>${escapeHtml(conv.title)}</h2>
  <div class="conv-meta">${escapeHtml(metaParts.join(' · '))}</div>
</div>
${conv.messages.map(renderMessage).join('\n')}
</section>`;
}

/**
 * 目录。pageNumbers 为 null 时（HTML 格式）不显示页码列。
 * hrefs 缺省时使用文内锚点 #conv-i；分文件模式下传入各文件相对路径。
 */
export function renderToc(conversations, { pageNumbers = null, hrefs = null, subtitle = '' } = {}) {
  const rows = conversations
    .map((conv, i) => {
      const href = hrefs ? hrefs[i] : `#conv-${i}`;
      const date = fmtDate(conv.createTime || conv.updateTime) || '—';
      const page = pageNumbers
        ? `<span class="dots"></span><span class="toc-page">${pageNumbers[i]}</span>`
        : '';
      return `<a class="toc-row" href="${escapeHtml(href)}">` +
        `<span class="toc-title">${i + 1}. ${escapeHtml(conv.title)}</span>` +
        `<span class="toc-date">${escapeHtml(date)}</span>${page}</a>`;
    })
    .join('\n');
  return `<h1 class="doc-title">ChatGPT 对话导出</h1>
<div class="doc-meta">导出时间 ${fmtDateTime(new Date().toISOString())} · 共 ${conversations.length} 个对话${subtitle ? ' · ' + escapeHtml(subtitle) : ''}</div>
<nav class="toc"><h2>目录</h2>
${rows}
</nav>`;
}

/** 合并模式的完整文档；pageNumbers 由 PDF 两遍渲染时传入 */
export function buildMergedHtml(conversations, { pageNumbers = null } = {}) {
  const toc = renderToc(conversations, { pageNumbers });
  const sections = conversations
    .map((c, i) => renderConversationSection(c, i, conversations.length))
    .join('\n');
  return buildDocument({ title: 'ChatGPT 对话导出', bodyHtml: `${toc}\n${sections}` });
}

/** 单个对话的独立文档（也用于 PDF 第一遍测量页数） */
export function buildSingleHtml(conv) {
  return buildDocument({
    title: conv.title,
    bodyHtml: renderConversationSection(conv, 0, 1),
    bodyClass: 'standalone',
  });
}

/** 仅目录页（用于 PDF 测量目录占多少页） */
export function buildTocOnlyHtml(conversations, pageNumbers) {
  return buildDocument({
    title: '目录',
    bodyHtml: renderToc(conversations, { pageNumbers }),
  });
}

/** 分文件模式下的索引页（链接指向各文件） */
export function buildIndexHtml(conversations, hrefs, subtitle) {
  return buildDocument({
    title: 'ChatGPT 对话导出 - 索引',
    bodyHtml: renderToc(conversations, { hrefs, subtitle }),
  });
}
