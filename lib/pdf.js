// PDF 导出：Puppeteer 渲染 HTML → PDF
//
// 合并模式的页码目录采用两遍渲染：
//   第 1 遍：每个对话单独渲染，用 pdf-lib 数出各自页数；
//   第 2 遍：迭代渲染目录页确定目录占几页，然后按
//            「目录页数 + 前面对话页数之和 + 1」算出每个对话的起始页，
//            把真实页码写进目录后整体渲染最终 PDF。
//   因为每个对话都从新的一页开始（break-before: page）、页面参数完全一致，
//   合并后各对话的分页与单独渲染时相同，页码是精确的。
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PDFDocument } from 'pdf-lib';
import { buildMergedHtml, buildSingleHtml, buildTocOnlyHtml, buildIndexHtml } from './html.js';
import { sanitizeFilename } from './util.js';

const PDF_OPTIONS = {
  format: 'A4',
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate:
    '<div style="width:100%;text-align:center;font-size:8px;color:#8a8f98;font-family:Arial,sans-serif;">' +
    '<span class="pageNumber"></span> / <span class="totalPages"></span></div>',
  margin: { top: '14mm', bottom: '16mm', left: '13mm', right: '13mm' },
};

async function launchBrowser() {
  const args = ['--disable-dev-shm-usage', '--font-render-hinting=none'];
  // root（容器）环境下 Chromium 必须关沙箱才能启动
  if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
  return puppeteer.launch({
    headless: true,
    args,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });
}

async function renderPdfBuffer(page, html) {
  await page.setContent(html, { waitUntil: 'load' });
  return Buffer.from(await page.pdf(PDF_OPTIONS));
}

async function pdfPageCount(buffer) {
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });
  return doc.getPageCount();
}

function computeStartPages(tocPages, pageCounts) {
  const starts = [];
  let cursor = tocPages;
  for (const n of pageCounts) {
    starts.push(cursor + 1);
    cursor += n;
  }
  return starts;
}

export async function exportPdf(conversations, opts, log) {
  const browser = await launchBrowser();
  const written = [];
  try {
    const page = await browser.newPage();

    if (opts.merge) {
      // ---- 第 1 遍：测量每个对话的页数 ----
      const pageCounts = [];
      for (let i = 0; i < conversations.length; i++) {
        const buf = await renderPdfBuffer(page, buildSingleHtml(conversations[i]));
        pageCounts.push(await pdfPageCount(buf));
        log(`  [PDF] 测量分页 ${i + 1}/${conversations.length}（${pageCounts[i]} 页）`);
      }

      // ---- 迭代确定目录自身占几页（目录行数多时可能超过一页）----
      let tocPages = 1;
      for (let iter = 0; iter < 5; iter++) {
        const starts = computeStartPages(tocPages, pageCounts);
        const buf = await renderPdfBuffer(page, buildTocOnlyHtml(conversations, starts, opts.docTitle));
        const actual = await pdfPageCount(buf);
        if (actual === tocPages) break;
        tocPages = actual;
      }

      // ---- 第 2 遍：带真实页码整体渲染 ----
      const starts = computeStartPages(tocPages, pageCounts);
      const outPath = path.join(opts.output, `${opts.baseName}.pdf`);
      await page.setContent(buildMergedHtml(conversations, { pageNumbers: starts, docTitle: opts.docTitle }), { waitUntil: 'load' });
      await page.pdf({ ...PDF_OPTIONS, path: outPath });
      written.push(outPath);
      log(`  [PDF] 已生成合并文件: ${outPath}（目录 ${tocPages} 页 + 正文 ${pageCounts.reduce((a, b) => a + b, 0)} 页）`);
    } else {
      // ---- 分文件模式：每个对话一个 PDF + 一个索引 PDF ----
      const files = [];
      for (let i = 0; i < conversations.length; i++) {
        const conv = conversations[i];
        const name = `${String(i + 1).padStart(3, '0')}-${sanitizeFilename(conv.title)}.pdf`;
        const outPath = path.join(opts.output, name);
        await page.setContent(buildSingleHtml(conv), { waitUntil: 'load' });
        await page.pdf({ ...PDF_OPTIONS, path: outPath });
        files.push(name);
        written.push(outPath);
        log(`  [PDF] ${i + 1}/${conversations.length} ${name}`);
      }
      const indexPath = path.join(opts.output, 'index.pdf');
      await page.setContent(buildIndexHtml(conversations, files, '点击标题打开对应 PDF 文件', opts.docTitle), { waitUntil: 'load' });
      await page.pdf({ ...PDF_OPTIONS, path: indexPath });
      written.push(indexPath);
      log(`  [PDF] 已生成索引: ${indexPath}`);
    }
  } finally {
    await browser.close();
  }
  return written;
}
