#!/usr/bin/env node
// ChatGPT 聊天记录导出 CLI
// 用法见 README.md 或 node export.js --help
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseCliArgs, HELP } from './lib/args.js';
import { applyFilters } from './lib/filter.js';
import { exportTxt, exportMd, exportHtml } from './lib/writers.js';

const log = (...args) => console.log(...args);

// 根据抓取来源决定文档标题和合并文件名
function platformInfo(source) {
  const s = String(source || '').toLowerCase();
  if (s.includes('claude')) return { docTitle: 'Claude 对话导出', baseName: 'claude-export' };
  if (s.includes('gemini')) return { docTitle: 'Gemini 对话导出', baseName: 'gemini-export' };
  if (s.includes('grok')) return { docTitle: 'Grok 对话导出', baseName: 'grok-export' };
  if (s.includes('chatgpt')) return { docTitle: 'ChatGPT 对话导出', baseName: 'chatgpt-export' };
  return { docTitle: '聊天记录导出', baseName: 'chat-export' };
}

async function loadConversations(inputPath) {
  let raw;
  try {
    raw = await fs.readFile(inputPath, 'utf8');
  } catch (err) {
    throw new Error(`读不到输入文件 ${inputPath}：${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`输入文件不是有效 JSON：${err.message}`);
  }
  // 兼容两种形态：{ conversations: [...] } 或直接是数组
  const conversations = Array.isArray(data) ? data : data.conversations;
  if (!Array.isArray(conversations)) {
    throw new Error('输入 JSON 里找不到 conversations 数组，请用 scraper/ 里的脚本重新导出');
  }
  return { conversations, source: Array.isArray(data) ? '' : data.source };
}

async function main() {
  let opts;
  try {
    opts = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`参数错误: ${err.message}\n`);
    console.error('用 --help 查看用法');
    process.exit(2);
  }
  if (opts.help) {
    console.log(HELP);
    return;
  }

  const { conversations: all, source } = await loadConversations(opts.input);
  Object.assign(opts, platformInfo(source));
  log(`读取 ${opts.input}：共 ${all.length} 个对话（来源: ${source || '未知'}）`);

  const { conversations, skipped } = applyFilters(all, opts);
  for (const s of skipped) {
    if (s.warn) log(`  ⚠ ${s.title}：${s.warn}`);
  }
  const filteredOut = skipped.filter((s) => s.reason);
  if (filteredOut.length) {
    const byReason = {};
    for (const s of filteredOut) byReason[s.reason] = (byReason[s.reason] || 0) + 1;
    log(`筛选后排除 ${filteredOut.length} 个：` + Object.entries(byReason).map(([r, n]) => `${r} ×${n}`).join('，'));
  }
  if (conversations.length === 0) {
    log('没有符合条件的对话，未生成任何文件。');
    return;
  }
  log(`将导出 ${conversations.length} 个对话 → ${opts.formats.join(', ')}（${opts.merge ? '合并' : '分文件'}模式）`);

  await fs.mkdir(opts.output, { recursive: true });

  const written = [];
  for (const format of opts.formats) {
    if (format === 'pdf') {
      // 动态 import：不导 PDF 时无需启动 Puppeteer
      const { exportPdf } = await import('./lib/pdf.js');
      written.push(...(await exportPdf(conversations, opts, log)));
    } else if (format === 'txt') {
      written.push(...(await exportTxt(conversations, opts, log)));
    } else if (format === 'md') {
      written.push(...(await exportMd(conversations, opts, log)));
    } else if (format === 'html') {
      written.push(...(await exportHtml(conversations, opts, log)));
    }
  }

  log(`\n完成 ✓ 共写出 ${written.length} 个文件到 ${path.resolve(opts.output)}`);
}

main().catch((err) => {
  console.error(`失败: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
