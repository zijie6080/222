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
let selectedIds = [];   // 「选择对话」勾选结果（空 = 全部）
let listItems = null;   // 列表模式回传的对话清单

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
  if (selectedIds.length) cfg.selectedIds = selectedIds;
  return cfg;
}

// ---------------- 选择对话 ----------------

function fmtListDate(iso) {
  if (!iso) return '';
  const d = new Date(typeof iso === 'number' ? iso * 1000 : iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function updatePickerCount() {
  const checked = $('pickerList').querySelectorAll('input:checked').length;
  $('pickerCount').textContent = `已选 ${checked} / ${listItems ? listItems.length : 0}`;
}

function renderPickerList(items) {
  const box = $('pickerList');
  box.textContent = '';
  if (!items.length) {
    box.innerHTML = '<div class="hint" style="padding:10px">当前筛选条件下没有对话</div>';
    return;
  }
  const pre = new Set(selectedIds);
  for (const it of items) {
    const row = document.createElement('label');
    row.className = 'pick-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = it.id;
    cb.checked = pre.has(it.id);
    cb.addEventListener('change', updatePickerCount);
    const title = document.createElement('span');
    title.className = 'pick-title';
    title.textContent = it.title || '(无标题)';
    const date = document.createElement('span');
    date.className = 'pick-date';
    date.textContent = fmtListDate(it.time);
    row.append(cb, title, date);
    box.appendChild(row);
  }
  updatePickerCount();
}

function pickerVisibleRows() {
  return [...$('pickerList').querySelectorAll('.pick-item')].filter((r) => r.style.display !== 'none');
}

async function openPicker() {
  listItems = null;
  $('options').style.display = 'none';
  $('footer').style.display = 'none';
  $('picker').style.display = 'block';
  $('pickerList').innerHTML = '<div class="hint" style="padding:10px">正在读取对话列表…</div>';
  $('pickerSearch').value = '';
  $('pickerCount').textContent = '';
  const cfg = buildConfig();
  delete cfg.selectedIds;
  cfg.listOnly = true;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (c) => { globalThis.__AI_EXPORT_CONFIG = c; },
      args: [cfg],
    });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [platform.file] });
  } catch (err) {
    $('pickerList').innerHTML = '';
    appendLog('error', '读取列表失败：' + err.message + '（请刷新页面后重试）');
  }
}

function closePicker(apply) {
  if (apply && listItems) {
    selectedIds = [...$('pickerList').querySelectorAll('input:checked')].map((cb) => cb.value);
  }
  $('picker').style.display = 'none';
  $('options').style.display = 'block';
  $('footer').style.display = 'block';
  if (selectedIds.length) {
    $('pickInfoRow').style.display = 'flex';
    $('pickInfo').textContent = `已指定 ${selectedIds.length} 个对话（将忽略上面的日期/关键词筛选）`;
  } else {
    $('pickInfoRow').style.display = 'none';
  }
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
  appendLog('info', `开始抓取 ${platform.name}${cfg.selectedIds ? `（已指定 ${cfg.selectedIds.length} 个对话）` : ''}…（关闭本弹窗不会中断抓取，下载仍会完成）`);

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
  if (msg.level === 'list') {
    listItems = msg.items || [];
    if ($('picker').style.display !== 'none') renderPickerList(listItems);
    return;
  }
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

  // 选择对话
  $('pickBtn').addEventListener('click', openPicker);
  $('pickClear').addEventListener('click', () => { selectedIds = []; closePicker(false); });
  $('pickerCancel').addEventListener('click', () => closePicker(false));
  $('pickerOk').addEventListener('click', () => closePicker(true));
  $('pickerAll').addEventListener('click', () => {
    for (const r of pickerVisibleRows()) r.querySelector('input').checked = true;
    updatePickerCount();
  });
  $('pickerNone').addEventListener('click', () => {
    for (const r of pickerVisibleRows()) r.querySelector('input').checked = false;
    updatePickerCount();
  });
  $('pickerSearch').addEventListener('input', () => {
    const kw = $('pickerSearch').value.trim().toLowerCase();
    for (const r of $('pickerList').querySelectorAll('.pick-item')) {
      const t = r.querySelector('.pick-title').textContent.toLowerCase();
      r.style.display = !kw || t.includes(kw) ? 'flex' : 'none';
    }
  });
}

init();
