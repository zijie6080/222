// 弹窗逻辑：四态状态机 configure → confirm → running → done
// 抓取/筛选/导出语义与旧版完全一致；仅重组信息架构并增加统计、进度与完成态。
const PLATFORMS = [
  { hostRe: /(^|\.)chatgpt\.com$/, name: 'ChatGPT', file: 'scrapers/chatgpt-scraper.js', archived: true, hasTime: true, dom: false },
  { hostRe: /(^|\.)claude\.ai$/, name: 'Claude', file: 'scrapers/claude-scraper.js', hasTime: true, dom: false },
  { hostRe: /(^|\.)gemini\.google\.com$/, name: 'Gemini', file: 'scrapers/gemini-scraper-dom.js', dom: true, hasTime: false },
  { hostRe: /(^|\.)grok\.com$/, name: 'Grok', file: 'scrapers/grok-scraper.js', hasTime: true, dom: false },
];

// 需要持久化的控件（id → 属性）
const FIELDS = {
  maxConv: 'value', fromDate: 'value', toDate: 'value', titleKeyword: 'value',
  filePrefix: 'value', fileMode: 'value', timeStyle: 'value',
  archived: 'checked', showTimestamps: 'checked', includeReasoning: 'checked',
  includeSystem: 'checked', includeLinks: 'checked',
  fmtJson: 'checked', fmtMd: 'checked', fmtTxt: 'checked', fmtHtml: 'checked', fmtPdf: 'checked',
};
const STORAGE_KEY = 'aiExportSettings';

// 估算系数（抓取前消息数/体积物理上不可知，只能按经验估）
const EST_MSGS_PER_CONV = 12;
const EST_BYTES_PER_MSG = 800;
const EST_SEC_PER_CONV_API = 0.65;
const EST_SEC_PER_CONV_DOM = 4.5;

const $ = (id) => document.getElementById(id);
let tab = null;
let platform = null;
let state = 'configure';
let rangeMode = 'all';          // all | today | 7d | 30d | custom
let selectedIds = [];           // 「选择对话」勾选结果（空 = 全部）
let listItems = null;           // 预取的对话清单
let prefetching = false;
let runStart = 0;
let elapsedTimer = null;
let downloadedFiles = [];
let progress = { cur: 0, total: 0 };

// ---------------- 视图切换 ----------------
const VIEWS = ['unsupported', 'configure', 'confirm', 'running', 'done'];
function showView(name) {
  state = name;
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== name;
  $('picker').hidden = true;
  $('footerBar').hidden = name !== 'configure';
}

function showPicker(show) {
  $('view-configure').hidden = show;
  $('footerBar').hidden = show;
  $('picker').hidden = !show;
}

// ---------------- 设置持久化 ----------------
async function restoreSettings() {
  try {
    const data = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
    if (!data) return;
    for (const [id, prop] of Object.entries(FIELDS)) {
      if (id in data && $(id)) $(id)[prop] = data[id];
    }
    if (data.rangeMode) setRangeMode(data.rangeMode, false);
  } catch (_) {}
}

async function saveSettings() {
  const data = { rangeMode };
  for (const [id, prop] of Object.entries(FIELDS)) {
    if ($(id)) data[id] = $(id)[prop];
  }
  try { await chrome.storage.local.set({ [STORAGE_KEY]: data }); } catch (_) {}
}

// ---------------- 日期快捷 ----------------
function localDateStr(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function rangeDates() {
  const today = new Date();
  if (rangeMode === 'today') { const t = localDateStr(today); return { from: t, to: t }; }
  if (rangeMode === '7d') { const f = new Date(today); f.setDate(f.getDate() - 6); return { from: localDateStr(f), to: localDateStr(today) }; }
  if (rangeMode === '30d') { const f = new Date(today); f.setDate(f.getDate() - 29); return { from: localDateStr(f), to: localDateStr(today) }; }
  if (rangeMode === 'custom') return { from: $('fromDate').value || null, to: $('toDate').value || null };
  return { from: null, to: null };
}

function rangeLabel() {
  const map = { all: '全部时间', today: '今天', '7d': '最近 7 天', '30d': '最近 30 天' };
  if (rangeMode !== 'custom') return map[rangeMode];
  const { from, to } = rangeDates();
  if (!from && !to) return '全部时间';
  return `${from || '最早'} → ${to || '今天'}`;
}

function setRangeMode(mode, save = true) {
  rangeMode = mode;
  for (const b of $('rangeSeg').querySelectorAll('button')) b.classList.toggle('on', b.dataset.range === mode);
  $('customDates').hidden = mode !== 'custom';
  if (save) saveSettings();
  updateStats();
}

// ---------------- 实时统计 ----------------
function filteredCount() {
  if (!listItems) return null;
  let items = listItems;
  if (selectedIds.length) {
    const sel = new Set(selectedIds);
    items = items.filter((it) => sel.has(it.id));
  } else {
    const kw = $('titleKeyword').value.trim().toLowerCase();
    if (kw) items = items.filter((it) => String(it.title || '').toLowerCase().includes(kw));
    if (platform.hasTime) {
      const { from, to } = rangeDates();
      const f = from ? new Date(from) : null;
      const t = to ? new Date(to + 'T23:59:59.999') : null;
      if (f || t) {
        items = items.filter((it) => {
          const d = it.time ? new Date(it.time) : null;
          if (!d || Number.isNaN(d.getTime())) return true; // 无时间戳的保留（与抓取端一致）
          return (!f || d >= f) && (!t || d <= t);
        });
      }
    }
    const maxN = parseInt($('maxConv').value, 10);
    if (Number.isFinite(maxN) && maxN > 0 && items.length > maxN) return maxN;
  }
  return items.length;
}

function humanSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function humanDuration(sec) {
  if (sec < 60) return `${Math.max(1, Math.round(sec))} 秒`;
  return `${Math.floor(sec / 60)} 分 ${Math.round(sec % 60)} 秒`;
}

function estimates() {
  const count = filteredCount();
  if (count == null) return null;
  const formats = currentFormats();
  const fileFormats = Math.max(1, formats.filter((f) => f !== 'pdf').length);
  const msgs = count * EST_MSGS_PER_CONV;
  const bytes = msgs * EST_BYTES_PER_MSG * fileFormats;
  const sec = count * (platform.dom ? EST_SEC_PER_CONV_DOM : EST_SEC_PER_CONV_API) + 2;
  return { count, msgs, bytes, sec };
}

function updateStats() {
  if (state !== 'configure' || !platform) return;
  const box = $('statsLine');
  if (prefetching) {
    box.innerHTML = '<span class="spinner"></span>正在读取对话清单…';
    return;
  }
  if (!listItems) {
    box.innerHTML = platform.dom
      ? '统计需扫描侧边栏 <a class="refresh" id="statsRefresh">点击读取</a>'
      : '未能读取对话清单 <a class="refresh" id="statsRefresh">重试</a>';
    const a = $('statsRefresh');
    if (a) a.addEventListener('click', prefetchList);
    return;
  }
  const est = estimates();
  if (est.count === 0) {
    box.innerHTML = '当前筛选条件下<b>没有对话</b>，请放宽条件';
    return;
  }
  box.innerHTML =
    `将导出 <b>${est.count}</b> 个对话 · 估 <b>~${est.msgs.toLocaleString()}</b> 条消息` +
    ` · 约 <b>${humanSize(est.bytes)}</b> · 预计 <b>${humanDuration(est.sec)}</b>`;
}

// ---------------- 清单预取（复用抓取脚本的 listOnly 模式） ----------------
async function prefetchList() {
  if (prefetching || !platform) return;
  prefetching = true;
  updateStats();
  const cfg = { listOnly: true };
  if (platform.archived) cfg.includeArchived = $('archived').checked;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (c) => { globalThis.__AI_EXPORT_CONFIG = c; },
      args: [cfg],
    });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [platform.file] });
    // 结果由 'list' 消息带回；这里只设超时兜底
    setTimeout(() => {
      if (prefetching) { prefetching = false; updateStats(); }
    }, platform.dom ? 60000 : 30000);
  } catch (_) {
    prefetching = false;
    updateStats();
  }
}

// ---------------- 配置构建（与旧版字段完全一致 + datePrefix/pdf） ----------------
function currentFormats() {
  const formats = [];
  if ($('fmtJson').checked) formats.push('json');
  if ($('fmtMd').checked) formats.push('md');
  if ($('fmtTxt').checked) formats.push('txt');
  if ($('fmtHtml').checked) formats.push('html');
  if ($('fmtPdf').checked) formats.push('pdf');
  return formats;
}

function buildConfig() {
  const cfg = {};
  const maxN = parseInt($('maxConv').value, 10);
  if (Number.isFinite(maxN) && maxN > 0) cfg.maxConversations = maxN;
  if (platform.archived) cfg.includeArchived = $('archived').checked;
  if ($('titleKeyword').value.trim()) cfg.titleKeyword = $('titleKeyword').value.trim();
  if (platform.hasTime) {
    const { from, to } = rangeDates();
    if (from) cfg.fromDate = from;
    if (to) cfg.toDate = to;
  }
  cfg.formats = currentFormats();
  const mode = $('fileMode').value;
  cfg.splitFiles = mode !== 'merge';
  cfg.datePrefix = mode === 'splitDate';
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

// ---------------- 确认摘要 ----------------
const FMT_LABEL = { json: 'JSON', md: 'Markdown', txt: 'TXT', html: 'HTML', pdf: 'PDF（打印页）' };
const MODE_LABEL = { merge: '合并为一个文件', split: '每个对话单独文件', splitDate: '每对话一个文件 · 文件名带日期' };

function openConfirm() {
  const cfg = buildConfig();
  if (!cfg.formats.length) {
    $('statsLine').innerHTML = '<span style="color:var(--danger)">请至少选择一种导出格式</span>';
    return;
  }
  const est = estimates();
  const scope = selectedIds.length
    ? `已勾选的 ${selectedIds.length} 个对话`
    : [rangeLabel(), cfg.titleKeyword ? `标题含「${cfg.titleKeyword}」` : null, cfg.maxConversations ? `最多 ${cfg.maxConversations} 个` : null]
        .filter(Boolean).join(' · ');
  const content = [
    cfg.showTimestamps ? '时间戳' : null,
    cfg.includeLinks ? '原对话链接' : null,
    cfg.includeReasoning ? '思考过程' : null,
    cfg.includeSystem ? '系统/工具消息' : null,
  ].filter(Boolean).join('、') || '仅正文';
  const rows = [
    ['平台', platform.name],
    ['范围', scope],
    ['内容', content],
    ['格式', cfg.formats.map((f) => FMT_LABEL[f]).join(' · ')],
    ['组织', MODE_LABEL[$('fileMode').value]],
    ['预估', est
      ? `${est.count} 个对话 · ~${est.msgs.toLocaleString()} 条消息 · 约 ${humanSize(est.bytes)} · ${humanDuration(est.sec)}`
      : '（未读取清单，无法预估）'],
  ];
  $('summaryList').innerHTML = rows
    .map(([k, v]) => `<div class="srow"><span class="sk">${k}</span><span class="sv"></span></div>`)
    .join('');
  // 值用 textContent 填充，避免注入
  const svs = $('summaryList').querySelectorAll('.sv');
  rows.forEach(([, v], i) => { svs[i].textContent = v; });
  showView('confirm');
}

// ---------------- 运行 ----------------
function appendLog(level, text) {
  for (const boxId of ['runLog', 'doneLog']) {
    const box = $(boxId);
    const line = document.createElement('div');
    line.className = `logline ${level}`;
    line.textContent = text;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }
}

function setStage(text, spin = true) {
  $('stageText').innerHTML = spin ? '<span class="spinner"></span>' : '';
  $('stageText').appendChild(document.createTextNode(text));
}

function setProgress(cur, total) {
  progress = { cur, total };
  const pct = total > 0 ? Math.min(100, Math.round((cur / total) * 100)) : 0;
  $('progressFill').style.width = `${pct}%`;
  $('progressText').textContent = total > 0 ? `${cur} / ${total} 个对话 · ${pct}%` : '';
}

async function runExport() {
  const cfg = buildConfig();
  await saveSettings();
  downloadedFiles = [];
  $('runLog').textContent = '';
  $('doneLog').textContent = '';
  setProgress(0, 0);
  setStage('正在读取对话列表…');
  $('elapsedText').textContent = '';
  showView('running');
  runStart = Date.now();
  clearInterval(elapsedTimer);
  elapsedTimer = setInterval(() => {
    $('elapsedText').textContent = `已用时 ${humanDuration((Date.now() - runStart) / 1000)}`;
  }, 1000);

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['formatters.js'] });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (c) => { globalThis.__AI_EXPORT_CONFIG = c; },
      args: [cfg],
    });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [platform.file] });
  } catch (err) {
    finishRun(false, '注入失败：' + err.message + '（请刷新页面后重试）');
  }
}

function finishRun(success, text) {
  clearInterval(elapsedTimer);
  const used = humanDuration((Date.now() - runStart) / 1000);
  $('resultIcon').className = `result-icon ${success ? 'ok' : 'err'}`;
  $('resultIcon').textContent = success ? '✓' : '✕';
  $('resultTitle').textContent = success ? '导出完成' : '导出失败';
  $('resultSub').textContent = success ? `${text} · 用时 ${used}` : text;
  const fl = $('fileList');
  if (downloadedFiles.length) {
    fl.hidden = false;
    fl.innerHTML = '';
    for (const f of downloadedFiles) {
      const div = document.createElement('div');
      div.textContent = `⬇ ${f}`;
      fl.appendChild(div);
    }
  } else {
    fl.hidden = true;
  }
  $('openPdfBtn').hidden = !$('fmtPdf').checked || !success;
  showView('done');
}

// ---------------- 消息处理 ----------------
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !msg.__aiExport) return;
  if (sender.tab && tab && sender.tab.id !== tab.id) return;

  if (msg.level === 'list') {
    listItems = msg.items || [];
    prefetching = false;
    updateStats();
    if (!$('picker').hidden) renderPickerList(listItems);
    return;
  }
  if (state === 'configure' || state === 'confirm') return; // 预取过程中的日志不打扰配置页

  if (msg.level === 'done') {
    setProgress(progress.total || 1, progress.total || 1);
    finishRun(true, msg.text);
    return;
  }
  if (msg.level === 'error') {
    appendLog('error', msg.text);
    finishRun(false, msg.text);
    return;
  }
  appendLog(msg.level, msg.text);
  if (state !== 'running') return;
  const m = String(msg.text).match(/\[(\d+)\s*\/\s*(\d+)\]/);
  if (m) {
    setProgress(parseInt(m[1], 10), parseInt(m[2], 10));
    setStage(`正在抓取对话 ${m[1]} / ${m[2]}`);
  } else if (/已下载|将下载|打印页/.test(msg.text)) {
    setStage('正在生成并下载文件…');
    const dm = String(msg.text).match(/^已下载 (.+)$/);
    if (dm) downloadedFiles.push(dm[1]);
  } else if (/对话列表/.test(msg.text)) {
    setStage('正在读取对话列表…');
  }
});

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
  if (!items || !items.length) {
    box.innerHTML = '<div class="hintline" style="padding:12px">没有找到对话</div>';
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

function openPicker() {
  showPicker(true);
  $('pickerSearch').value = '';
  if (listItems) {
    renderPickerList(listItems);
  } else {
    $('pickerList').innerHTML = '<div class="hintline" style="padding:12px"><span class="spinner"></span>正在读取对话列表…</div>';
    $('pickerCount').textContent = '';
    prefetchList();
  }
}

function closePicker(apply) {
  if (apply && listItems) {
    selectedIds = [...$('pickerList').querySelectorAll('input:checked')].map((cb) => cb.value);
  }
  showPicker(false);
  updatePickBadge();
  updateStats();
}

function updatePickBadge() {
  if (selectedIds.length) {
    $('pickBadge').hidden = false;
    $('pickBadgeText').textContent = `已选 ${selectedIds.length} 个`;
  } else {
    $('pickBadge').hidden = true;
  }
}

// ---------------- 初始化 ----------------
async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = '';
  try { host = new URL(tab.url).hostname; } catch (_) {}
  platform = PLATFORMS.find((p) => p.hostRe.test(host));

  if (!platform) {
    $('statusLine').textContent = '未识别到支持的平台';
    showView('unsupported');
    return;
  }

  $('statusLine').textContent = host;
  $('platBadge').hidden = false;
  $('platBadge').textContent = platform.name;
  $('filePrefix').placeholder = `${platform.name}-`;
  $('archivedRow').hidden = !platform.archived;
  if (!platform.hasTime) {
    $('noTimeNote').hidden = false;
    for (const b of $('rangeSeg').querySelectorAll('button')) b.disabled = true;
  }

  await restoreSettings();
  updatePickBadge();
  showView('configure');

  // 事件绑定
  $('rangeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-range]');
    if (b && !b.disabled) setRangeMode(b.dataset.range);
  });
  for (const id of Object.keys(FIELDS)) {
    if (!$(id)) continue;
    $(id).addEventListener('change', () => { saveSettings(); updateStats(); });
  }
  $('titleKeyword').addEventListener('input', updateStats);
  $('maxConv').addEventListener('input', updateStats);

  $('startBtn').addEventListener('click', openConfirm);
  $('confirmBack').addEventListener('click', () => { showView('configure'); updateStats(); });
  $('confirmGo').addEventListener('click', runExport);

  $('pickBtn').addEventListener('click', openPicker);
  $('pickClear').addEventListener('click', () => { selectedIds = []; updatePickBadge(); updateStats(); });
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

  // 完成态快捷操作
  $('openDirBtn').addEventListener('click', () => {
    try { chrome.downloads.showDefaultFolder(); } catch (_) {}
  });
  $('againBtn').addEventListener('click', runExport);
  $('backBtn').addEventListener('click', () => { showView('configure'); updateStats(); });
  $('openPdfBtn').addEventListener('click', async () => {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const html = globalThis.__AI_EXPORT_PRINT_HTML;
          if (!html) return false;
          const w = window.open('', '_blank');
          if (!w) return false;
          w.document.write(html);
          w.document.close();
          return true;
        },
      });
      if (!res || !res.result) appendLog('warn', '打印页打开失败：请允许该网站的弹出式窗口后重试');
    } catch (err) {
      appendLog('warn', '打印页打开失败：' + err.message);
    }
  });

  // 打开弹窗即静默预取清单驱动统计；Gemini（DOM 版）预取会滚动页面，改为手动触发
  if (!platform.dom) prefetchList();
  else updateStats();
}

init();
