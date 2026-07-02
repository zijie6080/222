// TXT / Markdown / HTML 三种格式的写出
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildMergedHtml, buildSingleHtml, buildIndexHtml } from './html.js';
import { sanitizeFilename, fmtDate, fmtDateTime, roleLabel } from './util.js';

const HR = '='.repeat(72);
const hr2 = '-'.repeat(72);

function convFilename(conv, index, ext) {
  return `${String(index + 1).padStart(3, '0')}-${sanitizeFilename(conv.title)}.${ext}`;
}

// ---------------- TXT ----------------

function conversationToTxt(conv, index, total) {
  const lines = [HR, `${index + 1}. ${conv.title}`];
  const meta = [];
  if (conv.createTime) meta.push(`创建于 ${fmtDateTime(conv.createTime)}`);
  if (conv.updateTime) meta.push(`最后更新 ${fmtDateTime(conv.updateTime)}`);
  meta.push(`${conv.messages.length} 条消息`);
  lines.push(meta.join(' · '), HR, '');
  for (const m of conv.messages) {
    const when = m.createTime ? `  ${fmtDateTime(m.createTime)}` : '';
    lines.push(`【${roleLabel(m)}】${when}`, m.text, '', hr2, '');
  }
  return lines.join('\n');
}

function txtToc(conversations) {
  const rows = conversations.map(
    (c, i) => `  ${String(i + 1).padStart(3)}. ${c.title}  （${fmtDate(c.createTime || c.updateTime) || '无日期'}）`
  );
  return [
    'ChatGPT 对话导出',
    `导出时间 ${fmtDateTime(new Date().toISOString())} · 共 ${conversations.length} 个对话`,
    '',
    '目录',
    ...rows,
    '',
  ].join('\n');
}

export async function exportTxt(conversations, opts, log) {
  const written = [];
  if (opts.merge) {
    const outPath = path.join(opts.output, 'chatgpt-export.txt');
    const body = conversations.map((c, i) => conversationToTxt(c, i, conversations.length)).join('\n\n');
    await fs.writeFile(outPath, `${txtToc(conversations)}\n\n${body}`, 'utf8');
    written.push(outPath);
  } else {
    for (let i = 0; i < conversations.length; i++) {
      const outPath = path.join(opts.output, convFilename(conversations[i], i, 'txt'));
      await fs.writeFile(outPath, conversationToTxt(conversations[i], i, conversations.length), 'utf8');
      written.push(outPath);
    }
    const indexPath = path.join(opts.output, 'index.txt');
    await fs.writeFile(indexPath, txtToc(conversations), 'utf8');
    written.push(indexPath);
  }
  log(`  [TXT] 已生成 ${written.length} 个文件`);
  return written;
}

// ---------------- Markdown ----------------

function conversationToMd(conv, index, { anchor = false } = {}) {
  const lines = [`## ${index + 1}. ${conv.title}`, ''];
  const meta = [];
  if (conv.createTime) meta.push(`创建于 ${fmtDateTime(conv.createTime)}`);
  if (conv.updateTime) meta.push(`最后更新 ${fmtDateTime(conv.updateTime)}`);
  meta.push(`${conv.messages.length} 条消息`);
  lines.push(`> ${meta.join(' · ')}`, '');
  for (const m of conv.messages) {
    const when = m.createTime ? ` · ${fmtDateTime(m.createTime)}` : '';
    lines.push(`### ${roleLabel(m)}${when}`, '', m.text, '');
  }
  return lines.join('\n');
}

export async function exportMd(conversations, opts, log) {
  const written = [];
  const header = `# ChatGPT 对话导出\n\n> 导出时间 ${fmtDateTime(new Date().toISOString())} · 共 ${conversations.length} 个对话\n`;
  if (opts.merge) {
    // GitHub 风格锚点：标题小写、空格转连字符。为稳妥起见用显式 HTML 锚点。
    const toc = conversations
      .map((c, i) => `- [${i + 1}. ${c.title}](#conv-${i})（${fmtDate(c.createTime || c.updateTime) || '无日期'}）`)
      .join('\n');
    const body = conversations
      .map((c, i) => `<a id="conv-${i}"></a>\n\n${conversationToMd(c, i)}`)
      .join('\n\n---\n\n');
    const outPath = path.join(opts.output, 'chatgpt-export.md');
    await fs.writeFile(outPath, `${header}\n## 目录\n\n${toc}\n\n---\n\n${body}\n`, 'utf8');
    written.push(outPath);
  } else {
    const files = [];
    for (let i = 0; i < conversations.length; i++) {
      const name = convFilename(conversations[i], i, 'md');
      const outPath = path.join(opts.output, name);
      await fs.writeFile(outPath, conversationToMd(conversations[i], i), 'utf8');
      files.push(name);
      written.push(outPath);
    }
    const toc = conversations
      .map((c, i) => `- [${i + 1}. ${c.title}](./${encodeURI(files[i])})（${fmtDate(c.createTime || c.updateTime) || '无日期'}）`)
      .join('\n');
    const indexPath = path.join(opts.output, 'index.md');
    await fs.writeFile(indexPath, `${header}\n## 目录\n\n${toc}\n`, 'utf8');
    written.push(indexPath);
  }
  log(`  [MD] 已生成 ${written.length} 个文件`);
  return written;
}

// ---------------- HTML ----------------

export async function exportHtml(conversations, opts, log) {
  const written = [];
  if (opts.merge) {
    const outPath = path.join(opts.output, 'chatgpt-export.html');
    await fs.writeFile(outPath, buildMergedHtml(conversations), 'utf8');
    written.push(outPath);
  } else {
    const files = [];
    for (let i = 0; i < conversations.length; i++) {
      const name = convFilename(conversations[i], i, 'html');
      await fs.writeFile(path.join(opts.output, name), buildSingleHtml(conversations[i]), 'utf8');
      files.push(name);
      written.push(path.join(opts.output, name));
    }
    const indexPath = path.join(opts.output, 'index.html');
    await fs.writeFile(indexPath, buildIndexHtml(conversations, files, '点击标题打开对应对话'), 'utf8');
    written.push(indexPath);
  }
  log(`  [HTML] 已生成 ${written.length} 个文件`);
  return written;
}
