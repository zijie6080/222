# Chrome 应用商店上架材料与操作指引

本文件汇总了提交到 Chrome Web Store 所需的全部文案与步骤。图标已在 `extension/icons/`，
打包用 `npm run package:extension`。

---

## 一、上架前检查清单

- [ ] `npm run package:extension` 能生成 `dist/ai-chat-exporter-vX.Y.Z.zip`
- [ ] 至少在 ChatGPT / Claude 上实测导出可用（避免因「功能不可用」被拒）
- [ ] 隐私政策 `PRIVACY.md` 已托管为**公开可访问的 URL**（见第五节）
- [ ] 准备好 1–5 张 1280×800 或 640×400 的商店截图（见第四节）
- [ ] 已注册 Chrome 开发者账号并支付一次性 $5 注册费

---

## 二、商店 listing 文案

**名称 / Name（≤45 字符）**
`AI Chat Exporter | AI 聊天记录导出`

**简短描述 / Summary（≤132 字符，不要堆砌品牌名）**
English (primary)：`Export your AI chat history to PDF, Markdown, HTML, JSON or TXT. Filter, preview and save. 100% local, nothing leaves your device.`
中文（辅）：`一键把 AI 聊天记录导出为 PDF、Markdown、HTML、JSON、TXT，可筛选、预览，全程本地处理，数据不外传。`

**类别 / Category：** Productivity（生产力工具）

**详细描述 / Detailed description（英文版，直接粘贴。已去掉品牌名清单以免再被判关键词堆砌）**

```
Back up and archive your AI chat history in one click.

Export formats: HTML (best for reading), Markdown (great for notes apps), PDF (print or archive), JSON (backup or processing) and TXT.

Features:
- Filter by date range (today, last 7 or 30 days, or a custom range), filter by title keyword, or pick specific conversations
- Optionally include message timestamps, the assistant's reasoning, system messages and a link back to the original chat
- Download images and files that appear in your conversations
- Interface available in English, Chinese and Japanese
- See an estimate before you export, watch live progress while it runs, and open the download folder when it finishes

Privacy first: everything runs locally in your browser. The extension only reads your own chat history and saves it to your computer. Nothing is uploaded, collected, or sent to any third-party server.

It works with the popular AI chat assistants you already use.
```

> 提示：审核方明确说「产品说明中有过多关键字」，所以上面**不再逐一列出各家 AI 的名字**。
> 如果你想让用户知道支持哪些平台，最多在一句话里自然提到一两个（如 "such as ChatGPT"），
> **不要再列一长串品牌名**，否则会再次被判垃圾内容。

---

## 三、权限用途（隐私标签 / 审核必填，逐条如实说明）

| 权限 | 用途说明（可直接粘贴到「权限理由」） |
| --- | --- |
| `activeTab` | 仅在用户点击插件、于当前 AI 网站标签页发起导出时访问该页面。 |
| `scripting` | 向当前 AI 网站页面注入导出脚本，读取用户本人的聊天记录并在本地生成文件。 |
| `storage` | 在本地保存用户的导出偏好（语言、格式等），不含任何聊天内容，不外传。 |
| `downloads` | 完成后打开下载目录（「打开下载目录」按钮），便于用户找到导出的文件。 |
| host 权限（10 个 AI 站点） | 插件只在这些受支持的 AI 网站上运行，读取用户在该站点自己账号的聊天记录用于导出。不访问其它任何网站。 |

**单一用途声明 / Single purpose：**
`导出用户本人在受支持的 AI 网站上的聊天记录到本地文件。`
`Export the user's own chat history from supported AI websites to local files.`

**数据用途勾选：** 「网站内容 / Website content」——用途选「App functionality」（实现功能所必需）；
声明**不出售/不转让**数据、**不用于**与核心功能无关的用途。

---

## 四、截图素材（1280×800 或 640×400，1–5 张）

可复用本项目在开发中生成的弹窗截图作为素材（配置页、确认页、进度页、完成页、选择对话、
多语言）。若需要商店规格，可把弹窗放到 1280×800 画布居中截图。建议至少：
1. 配置页（三步流程 + 实时统计）
2. 导出格式与文件组织
3. 完成页（成功统计 + 打开下载目录）
4. 多语言（English/日本語）

---

## 五、把隐私政策变成公开链接

商店要求隐私政策是一个可公开访问的 URL。两种简单做法：

- **GitHub 仓库 raw 链接**：仓库设为 public 后，用
  `https://raw.githubusercontent.com/<用户名>/<仓库>/<分支>/PRIVACY.md`（或直接用仓库内
  `PRIVACY.md` 的页面链接）。
- **GitHub Pages**：仓库 Settings → Pages 开启，把 `PRIVACY.md` 发布为网页后用该地址。

---

## 六、提交步骤（在开发者后台，需你本人操作）

1. 打开 <https://chrome.google.com/webstore/devconsole>，登录并支付一次性 **$5** 注册费。
2. 本地运行 `npm run package:extension`，得到 `dist/ai-chat-exporter-vX.Y.Z.zip`。
3. 后台「新增项目 / New item」→ 上传该 zip。
4. 填写第二节的名称/描述、选类别 Productivity、上传第四节截图（图标会自动取自包内 128px）。
5. 「隐私实践 / Privacy practices」标签：粘贴第三节的权限理由与单一用途声明，
   勾选数据用途、声明不出售数据，填入第五节的隐私政策 URL。
6. 保存草稿 → 「提交审核 / Submit for review」。

**审核预期：** 因涉及 10 个站点的广泛 host 权限 + 读取页面内容，通常需人工审核，
一般数天、偶尔可长达两周。若被打回，多半是要在权限理由里更清楚地说明为何需要这些站点权限——
照第三节如实补充即可。

**不想公开发布？** 在「可见性」里选「未列出（Unlisted）」或「私享（Private）」，
只把链接发给自己或同事，同样需过审但不出现在搜索结果里；或干脆只用 `dist/` 里的 zip
让别人「加载已解压的扩展程序」自用，完全无需上架。
