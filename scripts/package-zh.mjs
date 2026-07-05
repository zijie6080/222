// 打包一个「默认界面中文」的变体 zip（不改动主源码，临时拷贝后修改再打包）。
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
const before = "function detectLang() {\n  // 默认英文（初始界面语言）；用户在弹窗里切换后由 chrome.storage 记住其选择\n  return 'en';\n}";
const after = "function detectLang() {\n  // 默认中文（中文变体包）；用户在弹窗里切换后由 chrome.storage 记住其选择\n  return 'zh';\n}";
if (!popup.includes(before)) throw new Error('未找到 detectLang 英文默认块，源码可能已变动');
popup = popup.replace(before, after);
fs.writeFileSync(popupPath, popup);

// 2) manifest 名称/描述/标题改中文
const mPath = path.join(build, 'manifest.json');
const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
m.name = 'AI 聊天记录导出';
m.action.default_title = 'AI 聊天记录导出';
m.description = '一键导出 ChatGPT、Claude、Gemini、Grok、DeepSeek、Kimi 等 AI 的聊天记录为 PDF、Markdown、HTML、JSON、TXT。纯本地，数据不外传。';
if ([...m.description].length > 132) throw new Error('中文描述超 132 字符：' + [...m.description].length);
fs.writeFileSync(mPath, JSON.stringify(m, null, 2) + '\n');

// 3) 打包
const zipPath = path.join(distDir, `ai-chat-exporter-zh-v${m.version}.zip`);
fs.rmSync(zipPath, { force: true });
execFileSync('zip', ['-r', '-X', zipPath, '.', '-x', '*.DS_Store'], { cwd: build, stdio: 'inherit' });
fs.rmSync(build, { recursive: true, force: true });
console.log(`\n✓ 中文变体已生成 ${path.relative(root, zipPath)}（描述 ${[...m.description].length} 字符）`);
