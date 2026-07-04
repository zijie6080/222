# AI 聊天记录导出工具（ChatGPT / Claude / Gemini / Grok）

把你在 **ChatGPT、Claude、Gemini、Grok** 的对话抓取下来，导出为 **PDF / TXT / Markdown / HTML**。

分两步走：

1. **浏览器端**：抓取对话并下载统一格式的 `conversations.json`——可以用**谷歌浏览器插件**一键抓取（见下文），也可以把脚本粘到控制台运行；
2. **本地端**：`node export.js` 读取这个 JSON，按条件筛选后生成目标格式（PDF 用 Puppeteer 渲染 HTML，非字符串拼接，排版质量高）。四个平台共用同一套筛选/导出功能，输出的标题和文件名会按来源自动切换（如 `claude-export.pdf`）。

## 支持的平台

| 平台 | 抓取脚本 | 方式 | 消息时间戳 | Markdown 结构 |
| --- | --- | --- | --- | --- |
| ChatGPT（chatgpt.com） | `scraper/chatgpt-scraper.js` | 页面内调后端接口 | ✅ | ✅ |
| ChatGPT 备用 | `scraper/chatgpt-scraper-dom.js` | DOM 抓取 | ❌ | ⚠️ 纯文本 |
| Claude（claude.ai） | `scraper/claude-scraper.js` | 页面内调后端接口 | ✅ | ✅ |
| Gemini（gemini.google.com） | `scraper/gemini-scraper-dom.js` | DOM 抓取¹ | ❌ | ⚠️ 纯文本 |
| Grok（grok.com）² | `scraper/grok-scraper.js` | 页面内调后端接口 | ✅ | ✅ |
| DeepSeek（chat.deepseek.com） | `scraper/deepseek-scraper.js` | 页面内调后端接口 | ✅ | ✅ |
| Kimi（kimi.com / kimi.moonshot.cn） | `scraper/kimi-scraper.js` | 页面内调后端接口 | ✅ | ✅ |
| 智谱清言（chatglm.cn） | `scraper/zhipu-scraper.js` | 页面内调后端接口 | ✅ | ✅ |
| 豆包（doubao.com） | `scraper/doubao-scraper-dom.js` | DOM 抓取³ | ❌ | ⚠️ 纯文本 |
| 腾讯元宝（yuanbao.tencent.com） | `scraper/yuanbao-scraper.js` | 页面内调后端接口 | ✅ | ✅ |
| Meta AI（meta.ai） | `scraper/meta-scraper-dom.js` | DOM 抓取³ | ❌ | ⚠️ 纯文本 |

¹ Gemini 网页端内部走 batchexecute 私有协议，没有干净的 REST 接口，故用 DOM 方式（自动滚动侧边栏和消息区加载全部内容）。
² 指 grok.com 独立站；X（推特）内嵌的 Grok 是另一套接口，暂不支持。
³ 豆包 / Meta AI Web 端无干净 REST 接口（Meta 走带反爬令牌的 GraphQL），故用 DOM 方式（自动滚动侧边栏和消息区）。

> **较新平台（DeepSeek / Kimi / 智谱清言 / 豆包 / 腾讯元宝 / Meta AI）说明**：这些平台的接口未公开，脚本按其
> Web 结构编写并对字段做了多候选兜底，但作者无法在开发环境用真实账号验证。**首次使用请先把
> 脚本顶部 `CONFIG.maxConversations` 或插件的「最多抓取对话数」设为 3 试跑**，确认无误再抓全部；
> 若某平台报错，把控制台/弹窗里的红字发回即可修正。DeepSeek/Kimi 需已登录（脚本从 localStorage
> 取登录令牌），智谱/腾讯元宝走 cookie 登录态；Meta AI 用 DOM 抓取（需登录并展开对话历史）。

> **若某平台「列表里缺对话」**：抓取脚本已对分页做了健壮化（按 id 去重、本页新增为 0 才停、
> 响应字段深度扫描兜底），并对智谱/腾讯元宝先尝试「不带智能体 id」拉全量。若仍有对话没出现：
> ① 看控制台日志的「已获取会话列表 N（本页 X，新增 Y）」是否在应有数量前就停了；
> ② 智谱/元宝若只缺某个智能体下的对话，在网络面板找到该请求里的 assistant_id / agentId，
> 填到脚本顶部 CONFIG（或反馈给我）；③ 把一条 conversation/list 响应样例发回，我据此补字段。

```
├── scraper/
│   ├── chatgpt-scraper.js       # ChatGPT（API 版，推荐）
│   ├── chatgpt-scraper-dom.js   # ChatGPT（DOM 备用版）
│   ├── claude-scraper.js        # Claude（API 版）
│   ├── gemini-scraper-dom.js    # Gemini（DOM 版）
│   ├── grok-scraper.js          # Grok（API 版）
│   ├── deepseek-scraper.js      # DeepSeek（API 版）
│   ├── kimi-scraper.js          # Kimi（API 版）
│   ├── zhipu-scraper.js         # 智谱清言（API 版）
│   ├── doubao-scraper-dom.js    # 豆包（DOM 版）
│   ├── yuanbao-scraper.js       # 腾讯元宝（API 版）
│   └── meta-scraper-dom.js      # Meta AI（DOM 版）
├── extension/                   # Chrome 插件（MV3），一键抓取，免开控制台
│   ├── manifest.json
│   ├── popup.html / popup.js    # 弹窗：识别平台、筛选/格式/文件设置、进度
│   ├── formatters.js            # 插件端 Markdown/TXT/HTML 生成与下载
│   └── scrapers/                # 由 npm run sync:extension 从 scraper/ 复制
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

两种方式任选其一，产物完全相同。

### 方式 A：Chrome 插件（推荐，免开控制台）

1. 打开 `chrome://extensions`，右上角开启**开发者模式**；
2. 点**「加载已解压的扩展程序」**，选择本项目的 `extension/` 目录；
3. 打开并登录 chatgpt.com / claude.ai / gemini.google.com / grok.com 中任意一个；
4. 点工具栏里的插件图标，按「① 导出什么 → ② 包含哪些内容 → ③ 导出格式」三步配置，
   底部实时显示**预计导出的对话数 / 消息数 / 文件大小 / 耗时**（打开弹窗时会静默拉一次
   对话清单驱动统计，消息数与大小为估算值）；
5. 点**「开始导出」**→ 确认摘要 → 实时进度条 → 完成页（成功/失败数、文件清单、
   打开下载目录、再次导出）。关闭弹窗不会中断抓取。

弹窗里的完整设置项（自动保存，下次打开还在）：

| 分组 | 设置项 |
| --- | --- |
| ① 导出什么 | 时间范围快捷选择（全部 / 今天 / 近 7 天 / 近 30 天 / 自定义）；标题关键词；**选择具体对话**（拉取清单逐条勾选，支持搜索和全选，按钮旁显示已选数量） |
| ② 包含哪些内容 | 消息时间戳；原对话链接；**下载对话中的文件**（见下）；高级选项（默认折叠）：思考过程、系统消息/工具输出（均带说明）、时间格式、文件名前缀、最多抓取对话数、包含已归档（仅 ChatGPT） |
| ③ 导出格式 | HTML（推荐浏览）/ Markdown（Obsidian、笔记）/ **PDF（打印/存档）**/ JSON（程序处理、备份）/ TXT 多选；文件组织：合并单文件 / 每对话一个文件 / 每对话一个文件·文件名带日期 |

**界面语言**：弹窗右上角可切换 中文 / English / 日本語（默认跟随浏览器语言，选择会记住），
导出文件里的标签（"用户/助手/目录/导出时间"等）也会跟随所选语言；抓取脚本的控制台日志保持中文。

**下载对话中的文件**（默认关闭，勾选后生效；控制台运行可设 `CONFIG.downloadAssets = true`）：

| 平台 | 能下载什么 | 说明 |
| --- | --- | --- |
| ChatGPT | 消息里的图片（生成/上传）、用户上传的附件 | 走官方文件接口换签名地址，可靠性高 |
| Gemini | 消息里渲染出的图片 | 抓取页面 img 地址下载 |
| Claude | 消息附带的文件（有下载地址时）；上传文档的**提取文本**另存 .txt | 字段防御式处理，失败仅告警 |
| Grok | 生成的图片（best-effort） | 相对路径按 assets.grok.com 拼接尝试 |

文件命名为「三位对话序号-原文件名」；单个文件下载失败不影响对话文本导出，
结束时汇总成功/失败数。受各平台跨域策略影响属 best-effort，失败会在日志中列明。

插件里的 **PDF** 走浏览器打印通道：导出时自动打开一个排版好的打印页并弹出打印
对话框，目标选「另存为 PDF」即可（被弹窗拦截时可在完成页手动点「打开 PDF 打印页」）。
带精确页码目录和代码高亮的高质量 PDF 仍推荐用下载的 JSON 配合本地 `node export.js`。

说明：

- 日期/关键词筛选发生在**抓取阶段**（先按列表过滤再拉详情），大账号能明显省时间；
- 「选择对话」只需拉一次轻量的标题清单（不抓内容），勾选后只抓取选中的对话；
  勾选状态下日期/关键词筛选不再生效（以勾选为准）；
- 内容开关只影响 Markdown/TXT/HTML；**JSON 始终保留完整数据**（作为档案源，
  之后随时可以用本地命令重新出任何格式）；
- 插件端的 HTML 是轻量版（不渲染 markdown、无代码高亮）；要出带目录页码、
  语法高亮的高质量排版和 **PDF**，用下载的 JSON 配合本地 `node export.js`；
- 选了多个文件时浏览器可能询问「允许下载多个文件」，点允许即可。

插件和控制台脚本共用同一份抓取代码（`extension/scrapers/` 是从 `scraper/`
复制的副本，改动后用 `npm run sync:extension` 重新同步）。插件只申请了四个目标
网站的权限 + 本地存储（记住设置），抓取过程全部发生在你自己的浏览器里，
数据不经过任何第三方。

### 方式 B：控制台粘贴脚本

以 ChatGPT 为例（Claude / Gemini / Grok 只是换个网站和脚本，步骤完全相同）：

1. 用 Chrome / Edge 登录对应网站（如 <https://chatgpt.com>）；
2. 按 `F12` 打开开发者工具，切到 **Console（控制台）**；
   - 如果控制台提示需要输入 `allow pasting`，先照做一次；
3. 把上表中**对应抓取脚本的完整内容**粘贴进去，回车；
4. 等待进度日志跑完，浏览器会自动下载 `conversations.json`；
5. 把它放到本项目目录下（或任意位置，之后用 `--input` 指定）。

每个脚本顶部都有 `CONFIG` 可以调：最多抓多少个对话、请求间隔等。
建议第一次先把 `maxConversations` 设成 5 试跑，确认没问题再抓全部。

各平台的抓取原理与细节：

- **ChatGPT / Claude / Grok（API 版）**：在页面内用你的登录态调用网站自己的后端接口，
  不依赖页面 DOM，拿到完整消息树、精确时间戳；列表接口自带分页，不存在懒加载问题。
  Claude 的思维链（thinking）和工具调用会分别标记为 reasoning / tool 类型，
  由 `--include-reasoning` / `--include-system` 控制是否导出。
- **Gemini / ChatGPT 备用（DOM 版）**：自动滚动侧边栏加载全部对话 → 逐个点开 →
  向上滚动加载完整历史 → 抓取渲染后的文本。没有时间戳，代码块围栏会丢失。
  Gemini 如果展开过思考面板（model-thoughts），也会作为 reasoning 导出。

> 抓取用的都是你自己的登录态，只读你自己的数据；请求间有延时以避免触发限流。

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
DOM 版（Gemini、ChatGPT 备用）抓的数据没有时间戳，时间筛选对这些对话不生效（会保留并提示）。

### 输出说明

- **合并模式（`--merge`）**：生成单个 `{平台}-export.{pdf,txt,md,html}`（按 JSON 里的
  `source` 字段自动命名，如 `chatgpt-export.pdf`、`claude-export.pdf`）。
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
- **ChatGPT 报「获取登录态失败（HTTP 503）」**：会话接口瞬时抖动，脚本已内置自动重试和页面数据兜底；若重试后仍失败，刷新页面、确认能正常对话后再试，或等一两分钟；
- **抓取脚本报 404 或字段对不上**：说明该平台接口有变动，欢迎提 issue；Gemini/ChatGPT 可先用 DOM 版脚本兜底；
- **报 429（限流）**：脚本会自动退避重试；也可调大 `CONFIG.requestDelayMs`；
- **插件点了没反应**：先刷新目标网页再点插件图标；确认地址栏域名是支持的四个之一（X 内嵌的 Grok 不支持）；
- **改了 scraper/ 里的脚本但插件行为没变**：运行 `npm run sync:extension` 同步到 `extension/scrapers/`。

## 免责声明

仅用于导出**你自己账号**的聊天记录做个人备份。请遵守各平台（OpenAI / Anthropic / Google / xAI）的服务条款，不要用于批量爬取他人数据。
