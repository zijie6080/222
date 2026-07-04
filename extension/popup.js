// 弹窗逻辑：四态状态机 configure → confirm → running → done（多语言 zh/en/ja）
// 抓取/筛选/导出语义与旧版一致；界面文案经 t() 走 i18n.js 的文案表。
const PLATFORMS = [
  { hostRe: /(^|\.)chatgpt\.com$/, name: 'ChatGPT', file: 'scrapers/chatgpt-scraper.js', archived: true, hasTime: true, dom: false },
  { hostRe: /(^|\.)claude\.ai$/, name: 'Claude', file: 'scrapers/claude-scraper.js', hasTime: true, dom: false },
  { hostRe: /(^|\.)gemini\.google\.com$/, name: 'Gemini', file: 'scrapers/gemini-scraper-dom.js', dom: true, hasTime: false },
  { hostRe: /(^|\.)grok\.com$/, name: 'Grok', file: 'scrapers/grok-scraper.js', hasTime: true, dom: false },
  { hostRe: /(^|\.)deepseek\.com$/, name: 'DeepSeek', file: 'scrapers/deepseek-scraper.js', hasTime: true, dom: false },
  { hostRe: /(^|\.)(kimi\.com|kimi\.moonshot\.cn)$/, name: 'Kimi', file: 'scrapers/kimi-scraper.js', hasTime: true, dom: false },
  { hostRe: /(^|\.)chatglm\.cn$/, name: '智谱清言', file: 'scrapers/zhipu-scraper.js', hasTime: true, dom: false },
  { hostRe: /(^|\.)doubao\.com$/, name: '豆包', file: 'scrapers/doubao-scraper-dom.js', dom: true, hasTime: false },
];

// 需要持久化的控件（id → 属性）
const FIELDS = {
  maxConv: 'value', fromDate: 'value', toDate: 'value', titleKeyword: 'value',
  filePrefix: 'value', fileMode: 'value', timeStyle: 'value',
  archived: 'checked', showTimestamps: 'checked', includeReasoning: 'checked',
  includeSystem: 'checked', includeLinks: 'checked', downloadAssets: 'checked',
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
let rangeMode = 'all';
let selectedIds = [];
let listItems = null;
let prefetching = false;
let runStart = 0;
let elapsedTimer = null;
let downloadedFiles = [];
let progress = { cur: 0, total: 0 };

// ---------------- i18n ----------------
let currentLang = 'zh';

function detectLang() {
  const nav = String(navigator.language || '').toLowerCase();
  if (nav.startsWith('zh')) return 'zh';
  if (nav.startsWith('ja')) return 'ja';
  return 'en';
}

function t(key, params) {
  const table = globalThis.AI_EXPORT_I18N || {};
  const dict = table[currentLang] || {};
  let s = dict[key];
  if (s == null) s = (table.zh || {})[key];
  if (s == null) return key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

// 刷新 DOM 里的静态文案；动态区（统计/徽标）由各自 update 函数重建
function applyLanguage() {
  document.documentElement.lang = { zh: 'zh-CN', en: 'en', ja: 'ja' }[currentLang];
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh);
  for (const el of document.querySelectorAll('[data-i18n-tip]')) el.dataset.tip = t(el.dataset.i18nTip);
  if (!platform) {
    if (state === 'unsupported') $('statusLine').textContent = t('app.noPlatform');
  }
  updatePickBadge();
  updateStats();
  if (!$('picker').hidden && listItems) updatePickerCount();
}

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
    if (data.lang) { currentLang = data.lang; $('langSel').value = data.lang; }
  } catch (_) {}
}

async function saveSettings() {
  const data = { rangeMode, lang: currentLang };
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
  if (rangeMode === 'today') { const t0 = localDateStr(today); return { from: t0, to: t0 }; }
  if (rangeMode === '7d') { const f = new Date(today); f.setDate(f.getDate() - 6); return { from: localDateStr(f), to: localDateStr(today) }; }
  if (rangeMode === '30d') { const f = new Date(today); f.setDate(f.getDate() - 29); return { from: localDateStr(f), to: localDateStr(today) }; }
  if (rangeMode === 'custom') return { from: $('fromDate').value || null, to: $('toDate').value || null };
  return { from: null, to: null };
}

function rangeLabel() {
  if (rangeMode === 'all') return t('range.label.all');
  if (rangeMode !== 'custom') return t(`range.${rangeMode}`);
  const { from, to } = rangeDates();
  if (!from && !to) return t('range.label.all');
  return t('range.label.custom', { from: from || t('range.earliest'), to: to || t('range.now') });
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
      const t0 = to ? new Date(to + 'T23:59:59.999') : null;
      if (f || t0) {
        items = items.filter((it) => {
          const d = it.time ? new Date(it.time) : null;
          if (!d || Number.isNaN(d.getTime())) return true; // 无时间戳的保留（与抓取端一致）
          return (!f || d >= f) && (!t0 || d <= t0);
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
  if (sec < 60) return t('time.sec', { n: Math.max(1, Math.round(sec)) });
  return t('time.minsec', { m: Math.floor(sec / 60), s: Math.round(sec % 60) });
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
    box.innerHTML = `<span class="spinner"></span>${t('stats.loading')}`;
    return;
  }
  if (!listItems) {
    box.innerHTML = platform.dom
      ? `${t('stats.geminiManual')} <a class="refresh" id="statsRefresh">${t('stats.load')}</a>`
      : `${t('stats.failed')} <a class="refresh" id="statsRefresh">${t('stats.retry')}</a>`;
    const a = $('statsRefresh');
    if (a) a.addEventListener('click', prefetchList);
    return;
  }
  const est = estimates();
  if (est.count === 0) {
    box.innerHTML = t('stats.none');
    return;
  }
  box.innerHTML = t('stats.line', {
    count: est.count,
    msgs: est.msgs.toLocaleString(),
    size: humanSize(est.bytes),
    time: humanDuration(est.sec),
  });
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
    setTimeout(() => {
      if (prefetching) { prefetching = false; updateStats(); }
    }, platform.dom ? 60000 : 30000);
  } catch (_) {
    prefetching = false;
    updateStats();
  }
}

// ---------------- 配置构建 ----------------
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
  cfg.downloadAssets = $('downloadAssets').checked;
  const prefix = $('filePrefix').value;
  cfg.filePrefix = prefix !== '' ? prefix : `${platform.name}-`;
  cfg.timeStyle = $('timeStyle').value;
  cfg.lang = currentLang;
  if (selectedIds.length) cfg.selectedIds = selectedIds;
  return cfg;
}

// ---------------- 确认摘要 ----------------
function openConfirm() {
  const cfg = buildConfig();
  if (!cfg.formats.length) {
    $('statsLine').innerHTML = `<span style="color:var(--danger)">${t('stats.noFormats')}</span>`;
    return;
  }
  const FMT_LABEL = { json: 'JSON', md: 'Markdown', txt: 'TXT', html: 'HTML', pdf: t('fmt.pdf.confirm') };
  const est = estimates();
  const scope = selectedIds.length
    ? t('confirm.scopeSelected', { n: selectedIds.length })
    : [rangeLabel(), cfg.titleKeyword ? t('confirm.kw', { kw: cfg.titleKeyword }) : null,
       cfg.maxConversations ? t('confirm.max', { n: cfg.maxConversations }) : null]
        .filter(Boolean).join(' · ');
  const content = [
    cfg.showTimestamps ? t('step2.timestamps') : null,
    cfg.includeLinks ? t('step2.links') : null,
    cfg.includeReasoning ? t('step2.reasoning') : null,
    cfg.includeSystem ? t('step2.system') : null,
    cfg.downloadAssets ? t('confirm.assets') : null,
  ].filter(Boolean).join(' · ') || t('confirm.contentNone');
  const rows = [
    [t('confirm.platform'), platform.name],
    [t('confirm.scope'), scope],
    [t('confirm.content'), content],
    [t('confirm.formats'), cfg.formats.map((f) => FMT_LABEL[f]).join(' · ')],
    [t('confirm.layout'), t(`mode.${$('fileMode').value}`)],
    [t('confirm.estimate'), est
      ? t('confirm.estLine', { count: est.count, msgs: est.msgs.toLocaleString(), size: humanSize(est.bytes), time: humanDuration(est.sec) })
      : t('confirm.noEstimate')],
  ];
  $('summaryList').innerHTML = rows
    .map(([k]) => `<div class="srow"><span class="sk"></span><span class="sv"></span></div>`)
    .join('');
  const sks = $('summaryList').querySelectorAll('.sk');
  const svs = $('summaryList').querySelectorAll('.sv');
  rows.forEach(([k, v], i) => { sks[i].textContent = k; svs[i].textContent = v; });
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
  $('progressText').textContent = total > 0 ? t('run.progress', { cur, total, pct }) : '';
}

async function runExport() {
  const cfg = buildConfig();
  await saveSettings();
  downloadedFiles = [];
  $('runLog').textContent = '';
  $('doneLog').textContent = '';
  setProgress(0, 0);
  setStage(t('run.listing'));
  $('elapsedText').textContent = '';
  showView('running');
  runStart = Date.now();
  clearInterval(elapsedTimer);
  elapsedTimer = setInterval(() => {
    $('elapsedText').textContent = t('run.elapsed', { t: humanDuration((Date.now() - runStart) / 1000) });
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
    finishRun(false, t('inject.fail', { err: err.message }));
  }
}

function finishRun(success, text) {
  clearInterval(elapsedTimer);
  const used = humanDuration((Date.now() - runStart) / 1000);
  // 抓取脚本的完成消息是中文（脚本与控制台共用），解析出数字后按界面语言重排
  const m = String(text).match(/成功 (\d+) 个，失败 (\d+) 个/);
  const sub = success
    ? `${m ? t('done.sub', { ok: m[1], fail: m[2] }) : text} · ${t('done.used', { t: used })}`
    : text;
  $('resultIcon').className = `result-icon ${success ? 'ok' : 'err'}`;
  $('resultIcon').textContent = success ? '✓' : '✕';
  $('resultTitle').textContent = success ? t('done.ok') : t('done.fail');
  $('resultSub').textContent = sub;
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
  if (state === 'configure' || state === 'confirm') return;

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
    setStage(t('run.scraping', { cur: m[1], total: m[2] }));
  } else if (/已下载|将下载|打印页/.test(msg.text)) {
    setStage(t('run.generating'));
    const dm = String(msg.text).match(/^已下载 (.+)$/);
    if (dm) downloadedFiles.push(dm[1]);
  } else if (/对话列表/.test(msg.text)) {
    setStage(t('run.listing'));
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
  $('pickerCount').textContent = t('picker.count', { sel: checked, total: listItems ? listItems.length : 0 });
}

function renderPickerList(items) {
  const box = $('pickerList');
  box.textContent = '';
  if (!items || !items.length) {
    box.innerHTML = `<div class="hintline" style="padding:12px">${t('picker.empty')}</div>`;
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
    title.textContent = it.title || t('untitled');
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
    $('pickerList').innerHTML = `<div class="hintline" style="padding:12px"><span class="spinner"></span>${t('stats.loading')}</div>`;
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
    $('pickBadgeText').textContent = t('step1.picked', { n: selectedIds.length });
  } else {
    $('pickBadge').hidden = true;
  }
}

// ---------------- 初始化 ----------------
async function init() {
  currentLang = detectLang();
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = '';
  try { host = new URL(tab.url).hostname; } catch (_) {}
  platform = PLATFORMS.find((p) => p.hostRe.test(host));

  if (!platform) {
    await restoreSettings();
    $('langSel').value = currentLang;
    showView('unsupported');
    applyLanguage();
    $('statusLine').textContent = t('app.noPlatform');
    $('langSel').addEventListener('change', () => {
      currentLang = $('langSel').value;
      saveSettings();
      applyLanguage();
      $('statusLine').textContent = t('app.noPlatform');
    });
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
  $('langSel').value = currentLang;
  applyLanguage();
  updatePickBadge();
  showView('configure');

  // 事件绑定
  $('langSel').addEventListener('change', () => {
    currentLang = $('langSel').value;
    saveSettings();
    applyLanguage();
  });
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
      const tt = r.querySelector('.pick-title').textContent.toLowerCase();
      r.style.display = !kw || tt.includes(kw) ? 'flex' : 'none';
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
      if (!res || !res.result) appendLog('warn', t('done.pdfBlocked'));
    } catch (err) {
      appendLog('warn', t('done.pdfBlocked'));
    }
  });

  // 打开弹窗即静默预取清单驱动统计；Gemini（DOM 版）预取会滚动页面，改为手动触发
  if (!platform.dom) prefetchList();
  else updateStats();
}

init();
