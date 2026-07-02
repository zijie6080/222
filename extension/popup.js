// 弹窗逻辑：识别平台 → 恢复/保存设置 → 注入 formatters + 配置 + 抓取脚本 → 展示进度
const PLATFORMS = [
  { hostRe: /(^|\.)chatgpt\.com$/, name: 'ChatGPT', file: 'scrapers/chatgpt-scraper.js', archived: true, hasTime: true },
  { hostRe: /(^|\.)claude\.ai$/, name: 'Claude', file: 'scrapers/claude-scraper.js', hasTime: true },
  { hostRe: /(^|\.)gemini\.google\.com$/, name: 'Gemini', file: 'scrapers/gemini-scraper-dom.js', dom: true, hasTime: false },
  { hostRe: /(^|\.)grok\.com$/, name: 'Grok', file: 'scrapers/grok-scraper.js', hasTime: true },
];

// 需要持久化的控件（id → 类型）
const FIELDS = {
  maxConv: 'value', fromDate: 'value', toDate: 'value', titleKeyword: 'value',
  filePrefix: 'value', fileMode: 'value', timeStyle: 'value',
  archived: 'checked', showTimestamps: 'checked', includeReasoning: 'checked',
  includeSystem: 'checked', includeLinks: 'checked',
  fmtJson: 'checked', fmtMd: 'checked', fmtTxt: 'checked', fmtHtml: 'checked',
};
const STORAGE_KEY = 'aiExportSettings';

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

async function restoreSettings() {
  try {
    const data = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
    if (!data) return;
    for (const [id, prop] of Object.entries(FIELDS)) {
      if (id in data && $(id)) $(id)[prop] = data[id];
    }
  } catch (_) {}
}

async function saveSettings() {
  const data = {};
  for (const [id, prop] of Object.entries(FIELDS)) {
    if ($(id)) data[id] = $(id)[prop];
  }
  try { await chrome.storage.local.set({ [STORAGE_KEY]: data }); } catch (_) {}
}

function buildConfig() {
  const cfg = {};
  const maxN = parseInt($('maxConv').value, 10);
  if (Number.isFinite(maxN) && maxN > 0) cfg.maxConversations = maxN;
  if (platform.archived) cfg.includeArchived = $('archived').checked;
  if ($('titleKeyword').value.trim()) cfg.titleKeyword = $('titleKeyword').value.trim();
  if (platform.hasTime) {
    if ($('fromDate').value) cfg.fromDate = $('fromDate').value;
    if ($('toDate').value) cfg.toDate = $('toDate').value;
  }

  const formats = [];
  if ($('fmtJson').checked) formats.push('json');
  if ($('fmtMd').checked) formats.push('md');
  if ($('fmtTxt').checked) formats.push('txt');
  if ($('fmtHtml').checked) formats.push('html');
  cfg.formats = formats;
  cfg.splitFiles = $('fileMode').value === 'split';

  cfg.showTimestamps = $('showTimestamps').checked;
  cfg.includeReasoning = $('includeReasoning').checked;
  cfg.includeSystem = $('includeSystem').checked;
  cfg.includeLinks = $('includeLinks').checked;

  const prefix = $('filePrefix').value;
  cfg.filePrefix = prefix !== '' ? prefix : `${platform.name}-`;
  cfg.timeStyle = $('timeStyle').value;
  return cfg;
}

async function start() {
  const cfg = buildConfig();
  if (!cfg.formats.length) {
    appendLog('error', '请至少选择一种导出格式');
    return;
  }
  await saveSettings();

  $('start').disabled = true;
  $('log').textContent = '';
  appendLog('info', `开始抓取 ${platform.name}…（关闭本弹窗不会中断抓取，下载仍会完成）`);

  try {
    // 三次注入进的是同一个 isolated world，globalThis 互通：
    // ① 多格式导出钩子 → ② 配置 → ③ 抓取脚本
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['formatters.js'] });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (c) => { globalThis.__AI_EXPORT_CONFIG = c; },
      args: [cfg],
    });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [platform.file] });
  } catch (err) {
    appendLog('error', '注入失败：' + err.message + '（请刷新页面后重试）');
    $('start').disabled = false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !msg.__aiExport) return;
  if (sender.tab && tab && sender.tab.id !== tab.id) return;
  if (msg.level === 'done') {
    appendLog('done', '✓ 完成：' + msg.text);
    $('start').disabled = false;
  } else if (msg.level === 'error') {
    appendLog('error', '✗ ' + msg.text);
    $('start').disabled = false;
  } else {
    appendLog(msg.level, msg.text);
  }
});

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = '';
  try { host = new URL(tab.url).hostname; } catch (_) {}
  platform = PLATFORMS.find((p) => p.hostRe.test(host));

  if (!platform) {
    $('status').innerHTML =
      '<span class="unsupported">当前页面不支持。</span>请先打开：' +
      'chatgpt.com / claude.ai / gemini.google.com / grok.com';
    $('footer').style.display = 'none';
    return;
  }
  $('status').innerHTML = `当前平台：<span class="platform">${platform.name}</span>（${host}）`;
  $('options').style.display = 'block';
  if (platform.archived) $('archivedRow').style.display = 'flex';
  if (!platform.hasTime) {
    $('dateHintRow').style.display = 'flex';
    $('fromDate').disabled = true;
    $('toDate').disabled = true;
  }
  $('filePrefix').placeholder = `${platform.name}-`;

  await restoreSettings();
  $('start').addEventListener('click', start);
  for (const id of Object.keys(FIELDS)) {
    if ($(id)) $(id).addEventListener('change', saveSettings);
  }
}

init();
