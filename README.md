# ChatGPT 聊天记录导出工具

把你在 [chatgpt.com](https://chatgpt.com) 的全部对话抓取下来，导出为 **PDF / TXT / Markdown / HTML**。

分两步走：

1. **浏览器端**：在 chatgpt.com 的控制台运行一段脚本，抓取全部对话，下载 `conversations.json`；
2. **本地端**：`node export.js` 读取这个 JSON，按条件筛选后生成目标格式（PDF 用 Puppeteer 渲染 HTML，非字符串拼接，排版质量高）。

```
├── scraper/
│   ├── chatgpt-scraper.js       # 浏览器控制台抓取脚本（API 版，推荐）
│   └── chatgpt-scraper-dom.js   # 浏览器控制台抓取脚本（DOM 备用版）
├── export.js                    # 本地 CLI 入口
├── lib/
│   ├── args.js                  # 命令行参数解析
│   ├── filter.js                # 关键词 / 时间 / 黑白名单筛选
│   ├── html.js                  # HTML 模板（PDF 与 HTML 格式共用）
│   ├── pdf.js                   # Puppeteer 渲染 PDF（两遍渲染算页码）
│   ├── writers.js               # TXT / Markdown / HTML 写出
│   └── util.js
└── samples/
    └── sample-conversations.json  # 测试用样例数据
```

---

## 第一步：在浏览器里抓取对话

1. 用 Chrome / Edge 登录 <https://chatgpt.com>；
2. 按 `F12` 打开开发者工具，切到 **Console（控制台）**；
   - 如果控制台提示需要输入 `allow pasting`，先照做一次；
3. 把 **`scraper/chatgpt-scraper.js` 的完整内容**粘贴进去，回车；
4. 等待进度日志跑完，浏览器会自动下载 `conversations.json`；
5. 把它放到本项目目录下（或任意位置，之后用 `--input` 指定）。

脚本顶部有 `CONFIG` 可以调：最多抓多少个对话、是否包含归档对话、请求间隔等。

**两个脚本的区别：**

| | `chatgpt-scraper.js`（推荐） | `chatgpt-scraper-dom.js`（备用） |
| --- | --- | --- |
| 原理 | 在页面内调用 ChatGPT 自己的后端接口 | 模拟点击侧边栏 + 自动滚动抓 DOM |
| 消息时间戳 | ✅ 有 | ❌ 无 |
| Markdown 结构（代码块等） | ✅ 保留 | ⚠️ 只有渲染后的纯文本 |
| 懒加载处理 | 接口分页，天然完整 | 自动滚动侧边栏 / 消息区直到加载完 |
| 稳定性 | 高（不依赖页面样式） | 页面改版可能失效 |

> 抓取用的是你自己的登录态，只读你自己的数据；请求间有延时以避免触发限流。

## 第二步：本地安装依赖

需要 Node.js ≥ 18.11。

```bash
npm install
```

首次安装时 Puppeteer 会自动下载一份 Chrome（约 150MB）。如果你想用本机已有的
Chrome/Chromium，可以跳过下载并指定路径：

```bash
PUPPETEER_SKIP_DOWNLOAD=1 npm install
export PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome   # 按实际路径修改
```

## 第三步：导出

```bash
# 最常用：全部对话合并成一个带目录页码的 PDF
node export.js --input conversations.json --format pdf --merge --output ./out

# 题目里的完整示例：按关键词 + 时间范围筛选
node export.js --input conversations.json --format pdf --merge \
  --keyword "投资" --from 2025-01-01 --to 2025-06-30 --output ./out

# 每个对话单独一个 PDF + 一个索引页；同时再出一份 Markdown
node export.js --input conversations.json --format pdf,md --output ./out

# 标题黑白名单、包含思维链和系统消息
node export.js --input conversations.json --format html --merge \
  --title-include "面试" --title-exclude "草稿" \
  --include-reasoning --include-system
```

### 命令行参数

| 参数 | 说明 | 默认 |
| --- | --- | --- |
| `-i, --input <file>` | 抓取脚本导出的 JSON | `conversations.json` |
| `-f, --format <list>` | 输出格式，逗号分隔：`pdf,txt,md,html` | `pdf` |
| `-o, --output <dir>` | 输出目录 | `./out` |
| `--merge` | 合并成一个文件；不加则每个对话一个文件 + 索引页 | 关 |
| `--keyword <kw>` | 关键词，标题**或正文**包含即保留（忽略大小写）；可多次指定或逗号分隔，多个之间是"或"关系 | — |
| `--from <date>` | 起始日期 `YYYY-MM-DD` | — |
| `--to <date>` | 截止日期（含当天） | — |
| `--title-include <s>` | 标题白名单：包含任一子串才保留 | — |
| `--title-exclude <s>` | 标题黑名单：包含任一子串则排除（优先于白名单） | — |
| `--include-reasoning` | 包含 assistant 的思维链/推理消息 | 关 |
| `--include-system` | 包含系统消息和工具输出 | 关 |
| `-h, --help` | 帮助 | — |

时间筛选的口径：对话的「创建时间 ~ 最后更新时间」区间与 `[from, to]` **有交集**即保留。
DOM 备用版抓的数据没有时间戳，时间筛选对这些对话不生效（会保留并提示）。

### 输出说明

- **合并模式（`--merge`）**：生成单个 `chatgpt-export.{pdf,txt,md,html}`。
  PDF 首页是目录：**标题 + 日期 + 精确页码**，点击可跳转到对应对话；页脚有页码。
- **分文件模式**：每个对话生成 `001-标题.pdf` 等独立文件，另生成 `index.pdf` / `index.html` 等索引页，点击标题打开对应文件。
- 排版：用户消息蓝底、助手消息灰底、思维链黄底、系统消息紫底；每条消息保留时间戳；
  代码块等宽字体 + highlight.js 语法高亮；中文字体走系统字体栈（PingFang / 微软雅黑 / Noto Sans CJK）。

**PDF 目录页码是怎么精确算出来的？** 两遍渲染：第一遍把每个对话单独渲染成 PDF 数页数，
迭代确定目录自身占几页，再算出每个对话的起始页；第二遍把真实页码写进目录整体渲染。
因为每个对话都从新一页开始、页面参数一致，页码与最终文档完全吻合。

### 边界情况

- **空对话**：自动跳过并在日志里说明；
- **超长对话**：PDF 自动分页，代码块折行不溢出；
- **特殊字符**：所有内容经 HTML 转义，消息里出现的原始 HTML 按文本展示（不会破坏排版或执行脚本）；文件名自动清洗非法字符；
- **图片/音视频消息**：以 `[图片]` / `[音频]` / `[视频]` 占位标注；
- **消息树分支**：ChatGPT 里编辑过消息会产生分支，导出的是当前显示的分支（与网页一致）。

### 常见问题

- **Linux 下 PDF 中文变方块**：装中文字体，如 `sudo apt install fonts-noto-cjk`；
- **PDF 里目录点击不跳转**：内部锚点链接需要较新的 Chrome（108+）渲染、且部分 PDF 阅读器不支持，页码仍然有效；
- **抓取脚本报 401/403**：登录态过期，刷新页面重新运行；
- **报 429（限流）**：脚本会自动退避重试；也可调大 `CONFIG.requestDelayMs`。

## 免责声明

仅用于导出**你自己账号**的聊天记录做个人备份。请遵守 OpenAI 的服务条款，不要用于批量爬取他人数据。
