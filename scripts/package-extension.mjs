// 把 extension/ 打包成可上传 Chrome 应用商店的 zip。
// 用法：npm run package:extension  →  dist/ai-chat-exporter-v<版本>.zip
// 依赖系统 zip 命令（Linux/macOS 自带；Windows 可用 WSL 或 Git Bash）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extDir = path.join(root, 'extension');
const distDir = path.join(root, 'dist');

// 上架前提醒：extension/scrapers/ 必须是最新的（改过 scraper/ 后先 npm run sync:extension）
const version = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8')).version;
fs.mkdirSync(distDir, { recursive: true });
const zipPath = path.join(distDir, `ai-chat-exporter-v${version}.zip`);
fs.rmSync(zipPath, { force: true });

// 只打包扩展运行必需的文件；排除本机临时/隐藏文件
const excludes = ['*.DS_Store', '__MACOSX', '*.map'];
const args = ['-r', '-X', zipPath, '.', '-x', ...excludes];
execFileSync('zip', args, { cwd: extDir, stdio: 'inherit' });

const size = (fs.statSync(zipPath).size / 1024).toFixed(0);
console.log(`\n✓ 已生成 ${path.relative(root, zipPath)}（${size} KB）`);
console.log('  下一步：到 https://chrome.google.com/webstore/devconsole 新建项目并上传该 zip。');
console.log('  提示：改过 scraper/ 后请先运行 npm run sync:extension 再打包。');
