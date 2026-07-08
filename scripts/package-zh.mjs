// 打包一个「强制界面中文」的变体 zip（不改动主源码，临时拷贝后修改再打包）。
// 注意：主包已通过 detectLang 跟随浏览器语言 + _locales 自动本地化名称/描述，
//       中文浏览器无需本变体即会显示中文；本变体仅用于「强制中文、不跟随浏览器」的场景。
// 用法：node scripts/package-zh.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'extension');
const build = path.join(root, 'dist', '_zh-build');
const distDir = path.join(root, 'dist');

fs.rmSync(build, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });
fs.cpSync(src, build, { recursive: true });

// 1) popup 默认语言 en → zh
const popupPath = path.join(build, 'popup.js');
let popup = fs.readFileSync(popupPath, 'utf8');
const before = `function detectLang() {
  // 跟随浏览器语言：zh→中文，ja→日文，其余→英文；
  // 用户在弹窗里手动切换后由 chrome.storage 记住其选择并优先覆盖。
  const l = (navigator.language || (navigator.languages && navigator.languages[0]) || 'en').toLowerCase();
  if (l.startsWith('zh')) return 'zh';
  if (l.startsWith('ja')) return 'ja';
  return 'en';
}`;
const after = "function detectLang() {\n  // 强制中文（中文变体包）；用户在弹窗里切换后由 chrome.storage 记住其选择\n  return 'zh';\n}";
if (!popup.includes(before)) throw new Error('未找到 detectLang 跟随浏览器块，源码可能已变动');
popup = popup.replace(before, after);
fs.writeFileSync(popupPath, popup);

// 2) manifest 名称/描述/标题改中文
const mPath = path.join(build, 'manifest.json');
const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
m.name = 'ChatArk';
m.action.default_title = 'ChatArk';
m.description = '一键把 AI 聊天记录导出为 PDF、Markdown、HTML、JSON、TXT，可筛选、预览，全程本地处理，数据不外传。';
if ([...m.description].length > 132) throw new Error('中文描述超 132 字符：' + [...m.description].length);
fs.writeFileSync(mPath, JSON.stringify(m, null, 2) + '\n');

// 3) 打包
const zipPath = path.join(distDir, `chatark-zh-v${m.version}.zip`);
fs.rmSync(zipPath, { force: true });
execFileSync('zip', ['-r', '-X', zipPath, '.', '-x', '*.DS_Store'], { cwd: build, stdio: 'inherit' });
fs.rmSync(build, { recursive: true, force: true });
console.log(`\n✓ 中文变体已生成 ${path.relative(root, zipPath)}（描述 ${[...m.description].length} 字符）`);
