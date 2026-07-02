// 把 scraper/ 下的抓取脚本复制到 extension/scrapers/
// （manifest 无法引用扩展目录之外的文件，抓取逻辑以 scraper/ 为唯一来源，
//  修改 scraper/ 后运行 `npm run sync:extension` 同步）
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'scraper');
const destDir = path.join(root, 'extension', 'scrapers');

await fs.mkdir(destDir, { recursive: true });
const files = (await fs.readdir(srcDir)).filter((f) => f.endsWith('.js'));
for (const f of files) {
  await fs.copyFile(path.join(srcDir, f), path.join(destDir, f));
  console.log(`✓ ${f} → extension/scrapers/`);
}
console.log(`已同步 ${files.length} 个抓取脚本`);
