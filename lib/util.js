// 通用小工具

export function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const dateFmt = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' });
const dateTimeFmt = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : dateFmt.format(d);
}

export function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : dateTimeFmt.format(d);
}

// 生成安全的文件名（去掉非法字符、控制字符，限制长度）
export function sanitizeFilename(name, fallback = 'untitled') {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/[. ]+$/, '');
  return cleaned || fallback;
}

// 角色/类型 → 中文标签
export function roleLabel(msg) {
  if (msg.kind === 'reasoning') return '助手 · 思考过程';
  if (msg.kind === 'tool') return '工具输出';
  if (msg.kind === 'system' || msg.role === 'system') return '系统';
  if (msg.role === 'user') return '用户';
  if (msg.role === 'assistant') return '助手';
  return msg.role || '未知';
}

// 消息用于渲染的 CSS 类 / 分组
export function messageClass(msg) {
  if (msg.kind === 'reasoning') return 'reasoning';
  if (msg.kind === 'system' || msg.role === 'system') return 'system';
  if (msg.kind === 'tool') return 'tool';
  return msg.role === 'user' ? 'user' : 'assistant';
}
