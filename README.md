# PromptDock

> Navigate and export ChatGPT and Grok conversations.

PromptDock 是一个本地优先的 Chromium Manifest V3 扩展和 Python 转换器，用于在网页端浏览提示词历史并导出当前单个 ChatGPT 或 Grok 会话：

```text
<名称>.raw.json
<名称>.md
```

扩展只观察目标页面自己已经发出的网络请求或结构化数据，不抓取 DOM 假数据，不调用外部 API，不上传任何数据，也不读取或保存 Cookie、Authorization、access token、session token、密码、analytics 或 telemetry。

## 功能特性

1. **Prompt History 导航（ChatGPT）**
   - 右下角常驻微型 Dock：`[ History | Export ]`。
   - **History 主开关**：默认关闭时保持页面整洁，仅显示右下角 Dock；开启后同时展开侧边 Dot Rail 与 `[ · · · ]` 手柄。
   - **Dot Rail**：纯净圆点时间线，悬停即时预览提示词片段与序号/时间戳，点击快速定位跳转到对应 Prompt。
   - **History Window**：点击 `[ · · · ]` 手柄弹出 Voyage 风格历史搜索面板，支持全文过滤搜索与快速回跳。
   - 随滚动自动同步当前视口 active 提示词。

2. **当前会话导出（ChatGPT & Grok）**
   - 支持导出 **Markdown**、**JSON** 或 **两者**。
   - 遵循 active path 逆序回溯链路（`current_node → parent → ... → root → reverse`），保证导出完整的主干分支，不混入旁支或草稿。
   - 原文原样导出，完整保留代码块、数学公式与表情符号。

## 架构组成

浏览器端由平台隔离的几层组成：

1. `extension/core/platform.js` 识别当前平台（ChatGPT、Grok）并提供 URL/conversation-id 提示；`extension/core/normalized.js` 定义平台无关的 normalized model。
2. `extension/injected.js` 在 page world 观察 response。它只读取 `clone()` 或 XHR response，不修改原始 response，也不读取请求 headers。结构化候选通过 `window.postMessage` 交给 content script。
3. `extension/adapters/chatgpt.js` 与 `extension/adapters/grok-isolated.js` 集中保存平台特有规则；`extension/core/chatgpt-navigator.js` 负责会话的 prompt 提取与虚拟化滚动跳转。
4. `extension/content.js` 维护本地捕获状态、Dock 交互与下载。

Python 端的 `exporter/conversation.py` 是可重新处理历史 raw JSON 的独立核心；`exporter/markdown.py` 生成 Raw Markdown；`exporter/naming.py` 负责文件名和标题编号；`exporter/convert.py` 是 CLI。

## 文件命名

默认使用经过安全清洗的 conversation title 作为文件名。需要系列编号规则时，可复制：

```text
extension/naming.local.example.json → extension/naming.local.json
```

`naming.local.json` 被 `.gitignore` 排除，并同时供 Python CLI 和浏览器扩展读取。规则使用 `title_pattern`、第一个数字捕获组、`filename_prefix` 和 `minimum_digits`。

其他标题会清洗控制字符、`/`、`\` 及常见文件系统非法字符。Python CLI 默认不会覆盖已有的不同 Markdown：可使用 `--new` 生成 `.new`/`.new2`，或明确使用 `--force`。

## Python CLI

在项目目录执行：

```bash
python3 -m exporter.convert /path/to/conversation.raw.json --verbose
```

或者：

```bash
./chatgpt-current-export convert /path/to/conversation.raw.json --verbose
```

默认 Markdown 写在 raw JSON 同目录，输出路径可自定义：

```bash
./chatgpt-current-export convert /path/to/conversation.raw.json \
  --output /path/to/output/conversation.md \
  --new \
  --verbose
```

CLI 会输出 title、conversation id、mapping 节点数、active path 节点数、user/assistant 数量、排除分支数量、状态和 Markdown 字节数。

## 安装 Chromium / Chrome 扩展

1. 打开 `chrome://extensions`。
2. 开启右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本仓库下的 `extension/` 目录。
5. 打开或刷新 ChatGPT (`chatgpt.com/c/<conversation-id>`) 或 Grok (`grok.com/c/<conversation-id>`) 页面。
6. 右下角会出现 PromptDock 控制条，可在弹出菜单中选择导出格式，或开启 ChatGPT 的 Prompt History 导航栏。

## 测试与校验

运行 Python 测试：

```bash
python3 -m unittest discover -s tests -v
```

运行扩展静态语法检查与单元测试：

```bash
node tests/test_chatgpt_navigator.js
node tests/test_export_format.js
node tests/test_platform_adapters.js
node tests/test_ui_integration.js
for file in extension/*.js extension/core/*.js extension/adapters/*.js; do node --check "$file"; done
python3 -m json.tool extension/manifest.json >/dev/null
```

## Scope and privacy

本项目只处理用户主动导出的当前 conversation，并默认将数据保留在本地。它不上传数据、不调用云端 LLM 或第三方 API、不读取或保存认证信息，也不包含真实 conversation fixture。`exports/`、`*.raw.json`、可选的 `naming.local.json` 和临时文件均已加入 `.gitignore`。
