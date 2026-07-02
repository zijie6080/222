// 弹窗逻辑：识别平台 → 注入配置 + 抓取脚本（scrapers/ 下与控制台脚本同源）→ 展示进度
const PLATFORMS = [
  { hostRe: /(^|\.)chatgpt\.com$/, name: 'ChatGPT', file: 'scrapers/chatgpt-scraper.js', archived: true },
  { hostRe: /(^|\.)claude\.ai$/, name: 'Claude', file: 'scrapers/claude-scraper.js' },
  { hostRe: /(^|\.)gemini\.google\.com$/, name: 'Gemini', file: 'scrapers/gemini-scraper-dom.js', dom: true },
  { hostRe: /(^|\.)grok\.com$/, name: 'Grok', file: 'scrapers/grok-scraper.js' },
];

const $ = (id) => document.getElementById(id);
let tab = null;
let platform = null;

function appendLog(level, text) {
  const box = $('log');
  box.style.display = 'block';
  const line = document.createElement('div');
  line.className = level;
  line.textContent = text;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = '';
  try { host = new URL(tab.url).hostname; } catch (_) {}
  platform = PLATFORMS.find((p) => p.hostRe.test(host));

  if (!platform) {
    $('status').innerHTML =
      '<span class="unsupported">当前页面不支持。</span>请先打开：' +
      'chatgpt.com / claude.ai / gemini.google.com / grok.com';
    return;
  }
  $('status').innerHTML = `当前平台：<span class="platform">${platform.name}</span>（${host}）`;
  $('options').style.display = 'block';
  if (platform.archived) $('archivedRow').style.display = 'flex';
  if (platform.dom) $('domHint').style.display = 'block';
  $('start').addEventListener('click', start);
}

async function start() {
  const cfg = {};
  const maxN = parseInt($('maxConv').value, 10);
  if (Number.isFinite(maxN) && maxN > 0) cfg.maxConversations = maxN;
  if (platform.archived) cfg.includeArchived = $('archived').checked;

  $('start').disabled = true;
  $('log').textContent = '';
  appendLog('info', `开始抓取 ${platform.name}…（关闭本弹窗不会中断抓取，下载仍会完成）`);

  try {
    // 两次注入进的是同一个 isolated world，globalThis 互通
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (c) => { globalThis.__AI_EXPORT_CONFIG = c; },
      args: [cfg],
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: [platform.file],
    });
  } catch (err) {
    appendLog('error', '注入失败：' + err.message + '（请刷新页面后重试）');
    $('start').disabled = false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !msg.__aiExport) return;
  if (sender.tab && tab && sender.tab.id !== tab.id) return;
  if (msg.level === 'done') {
    appendLog('done', '✓ 完成：' + msg.text + '，已下载 conversations.json');
    $('start').disabled = false;
  } else if (msg.level === 'error') {
    appendLog('error', '✗ ' + msg.text);
    $('start').disabled = false;
  } else {
    appendLog(msg.level, msg.text);
  }
});

init();
