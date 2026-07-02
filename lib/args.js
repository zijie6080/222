import { parseArgs } from 'node:util';

export const HELP = `
ChatGPT 聊天记录导出工具

用法:
  node export.js --input conversations.json --format pdf [选项]

基本选项:
  -i, --input <file>        抓取脚本导出的 JSON 文件（默认 conversations.json）
  -f, --format <list>       输出格式，逗号分隔: pdf,txt,md,html（默认 pdf）
  -o, --output <dir>        输出目录（默认 ./out）
      --merge               合并成一个文件（PDF 带页码目录）；不加则每个对话单独一个文件

筛选选项:
      --keyword <kw>        关键词（标题或正文包含即保留），可多次指定或用逗号分隔
      --from <date>         起始日期，如 2025-01-01
      --to <date>           截止日期（含当天），如 2025-06-30
      --title-include <s>   标题白名单（包含任一子串才保留），可多次指定
      --title-exclude <s>   标题黑名单（包含任一子串则排除），可多次指定
      --include-reasoning   包含 assistant 的思维链/推理消息（默认不含）
      --include-system      包含系统消息和工具输出（默认不含）

其他:
  -h, --help                显示本帮助

示例:
  node export.js --input conversations.json --format pdf --merge \\
    --keyword "投资" --from 2025-01-01 --to 2025-06-30 --output ./out
`;

const FORMATS = ['pdf', 'txt', 'md', 'html'];

// 支持 --keyword a --keyword b 和 --keyword "a,b" 两种写法
function splitMulti(values) {
  return (values || [])
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean);
}

function parseDate(str, name, endOfDay = false) {
  if (!str) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    throw new Error(`--${name} 格式应为 YYYY-MM-DD，收到: ${str}`);
  }
  const d = new Date(`${str}T${endOfDay ? '23:59:59.999' : '00:00:00'}`);
  if (Number.isNaN(d.getTime())) throw new Error(`--${name} 不是有效日期: ${str}`);
  return d;
}

export function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      input: { type: 'string', short: 'i', default: 'conversations.json' },
      format: { type: 'string', short: 'f', default: 'pdf' },
      output: { type: 'string', short: 'o', default: './out' },
      merge: { type: 'boolean', default: false },
      keyword: { type: 'string', multiple: true },
      from: { type: 'string' },
      to: { type: 'string' },
      'title-include': { type: 'string', multiple: true },
      'title-exclude': { type: 'string', multiple: true },
      'include-reasoning': { type: 'boolean', default: false },
      'include-system': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) return { help: true };

  const formats = splitMulti([values.format]);
  for (const f of formats) {
    if (!FORMATS.includes(f)) {
      throw new Error(`不支持的格式: ${f}（可选: ${FORMATS.join(', ')}）`);
    }
  }
  if (formats.length === 0) throw new Error('--format 至少要指定一种格式');

  const from = parseDate(values.from, 'from');
  const to = parseDate(values.to, 'to', true);
  if (from && to && from > to) throw new Error('--from 不能晚于 --to');

  return {
    help: false,
    input: values.input,
    output: values.output,
    formats,
    merge: values.merge,
    keywords: splitMulti(values.keyword),
    from,
    to,
    titleInclude: splitMulti(values['title-include']),
    titleExclude: splitMulti(values['title-exclude']),
    includeReasoning: values['include-reasoning'],
    includeSystem: values['include-system'],
  };
}
