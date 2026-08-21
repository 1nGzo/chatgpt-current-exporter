# Current Conversation Exporter

这是一个本地优先的 Chromium Manifest V3 扩展和 Python 转换器，用于保存浏览器当前打开的单个网页 conversation：

```text
<名称>.raw.json
<名称>.md
```

当前正式保留 ChatGPT 单会话导出行为，并加入 Gemini Web 的安全结构诊断与平台适配骨架。Gemini 的未公开 response schema 必须经过真实浏览器观察后才能实现正式导出；在此之前不会把猜测的 schema 或 DOM 文本标记为成功。

## 架构

```text
网页 fetch / XHR / stream / WebSocket response
                    ↓
             page-world observer
                    ↓
             platform adapter
                    ↓
       normalized conversation model
                    ↓
              raw JSON + Markdown
```

主要目录：

- `extension/core/`：平台识别和统一的 normalized conversation model；
- `extension/adapters/chatgpt.js`：ChatGPT candidate detection 和 normalized adapter 边界；
- `extension/adapters/gemini.js`：Gemini 结构诊断 adapter，当前不声明 schema 已验证；
- `extension/injected.js`：page-world response 观察器；
- `extension/content.js`：当前页面状态、导出按钮和 popup 消息桥；
- `extension/converter.js`：现有 ChatGPT `mapping/current_node` 转换逻辑；
- `exporter/model.py`：Python normalized model；
- `exporter/conversation.py`、`exporter/markdown.py`、`exporter/naming.py`：历史 raw 转换核心。

Raw payload 始终独立保留，不会因为进入 normalized model 而删除平台字段。

## ChatGPT 支持

ChatGPT 的现有行为保持不变：

```text
current_node → parent → parent → ... → root → reverse
```

因此 Markdown 只输出当前 active path，不按时间遍历 `mapping`，不会混入兄弟 branch。当前 ChatGPT `messages` 分页合并、`create_time` 顺序 fallback、内部 role/content 过滤、完整性检查和冲突保护继续由原有逻辑负责。

ChatGPT adapter 不会把 `mapping/current_node` 规则泄漏到 Gemini adapter。旧 raw JSON 没有 exporter metadata 时，Python 仍会根据 `mapping` schema 识别为 ChatGPT。

## Gemini 支持状态

扩展已匹配：

```text
https://gemini.google.com/*
```

Gemini 当前阶段只做安全 discovery：

- 观察 page-world 的 fetch、XHR、stream 和 WebSocket 数据通道；
- 对 JSON 或 stream frame 做内存结构分析；
- 只报告 top-level keys、wrapper depth、可能的 turn 数量、role 计数、分页信号和 completeness 状态；
- 不输出 response 正文；
- 不使用 DOM 消息列表作为正式历史数据源；
- 不猜测或写死 Gemini 私有 endpoint；
- 不把可能的 turn 结构标记为 Ready；
- 未确认 schema、顺序、候选分支和完整性前，不生成 Gemini raw 或 Markdown。

因此当前 Gemini popup 可能显示：

```text
Platform: Gemini
Completeness: UNKNOWN
Gemini possible candidates (unverified): ...
```

这表示诊断链路已经运行，不表示 Gemini 正式导出已经完成。下一步需要在真实 Gemini 页面观察安全诊断字段，再实现针对实际 schema 的 normalize、branch selection、pagination validation 和 Raw Bundle 保存。

## Normalized Conversation Model

平台 adapter 在进入共享 renderer 前使用统一模型：

```text
platform
conversation_id
title
source_url
captured_at

messages:
    sequence
    role
    text
    timestamp?
    platform_message_id?
    metadata?
```

normalized model 不是 raw JSON 的替代品。ChatGPT 现有 renderer 保持兼容格式；经过 schema 验证的平台可以使用通用 normalized Markdown renderer。

## 文件命名

默认使用经过安全清洗的 conversation title。需要系列编号规则时，可复制：

```text
extension/naming.local.example.json → extension/naming.local.json
```

`naming.local.json` 被 `.gitignore` 排除，并同时供 Python CLI 和浏览器扩展读取。规则使用 `title_pattern`、第一个数字捕获组、`filename_prefix` 和 `minimum_digits`，因此不同用户可以配置自己的系列标题格式，而不会把个人命名信息提交到公开仓库。

其他标题会清洗控制字符、`/`、`\` 及常见文件系统非法字符。Python CLI 默认不会覆盖已有的不同 Markdown：可使用 `--new` 生成 `.new`/`.new2`，或明确使用 `--force`。浏览器下载由 Chrome 的本地下载冲突规则处理，通常会产生 `(1)` 等新文件名；项目不会主动删除或覆盖已有下载。

## Python CLI

在项目目录执行：

```bash
python3 -m exporter.convert /path/to/conversation.raw.json --verbose
```

或者：

```bash
./chatgpt-current-export convert /path/to/conversation.raw.json --verbose
```

旧 ChatGPT raw JSON 仍可独立转换。CLI 会输出平台识别结果、title、conversation id、mapping 节点数、active path 节点数、user/assistant 数量、排除分支数量、状态和 Markdown 字节数。默认不输出正文预览，避免把私人内容刷进终端。

当前 Python active-path parser 正式支持 ChatGPT `mapping` schema。Gemini raw schema 尚未确认，因此 CLI 不会把任意 Gemini response 猜测成可转换 conversation。

## 安装与使用

1. 打开 `chrome://extensions`。
2. 开启右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本目录下的 `extension/`，不是项目根目录。
5. 打开或刷新 ChatGPT 或 Gemini 页面。
6. 点击扩展 popup 查看 `Platform` 和诊断状态。
7. ChatGPT 捕获到完整结构化数据后，点击页面右下角“导出器”按钮，再点击“导出当前会话”。

文件会进入 Chrome 当前配置的默认下载目录。Chrome 可能在首次连续下载两个文件时要求允许该站点的多个自动下载；需要允许，否则可能只看到 raw 或只看到 Markdown。

如果 ChatGPT 显示尚未捕获完整 conversation 数据，请刷新页面，让 `document_start` 监听器从请求开始运行，再等待页面加载完成；也可以点击“重新扫描当前页面”。扩展不会改用 DOM 抓取来伪造完整结果。

## Gemini Live Discovery

终端无法证明当前登录 Gemini 页面实际使用的 transport 或 schema。进行下一步 live test 时：

1. 重新加载扩展并打开 `https://gemini.google.com/`；
2. 打开一个非敏感测试 conversation；
3. 刷新页面并等待请求完成；
4. 打开扩展 popup；
5. 只提供以下诊断字段：`Platform`、`Current URL`、`Fetch observed`、`XHR observed`、`Stream responses`、`JSON candidates`、`Gemini possible candidates`、`Last top-level keys`、`Wrapper depth`、`Possible turns`、`Possible user messages`、`Possible assistant messages`、`Pagination detected`、`Completeness`。

不要提供 Cookie、Authorization、token、session、response 正文或私人 conversation 内容。当前诊断只展示结构字段和计数，不展示 response 文本。

## Completeness 与安全边界

如果检测到分页、cursor、partial、truncated、未知 branch state 或其他明确的不完整信号，状态必须保持 `Incomplete` 或 `UNKNOWN`，不会生成伪完整 Markdown。没有分页信号也不自动证明后端完整。

所有数据默认只留在本地：

- 不上传第三方；
- 不调用云端 LLM、OpenAI API 或 Gemini API；
- 无 analytics、telemetry 或错误上报；
- 不读取或保存 Cookie、Authorization、access token、session token 或密码；
- `exports/`、`*.raw.json`、本地命名配置和临时 capture 文件均在 `.gitignore` 中；
- 测试 fixture 不包含真实 conversation。

## 测试

Python 回归测试：

```bash
python3 -m unittest discover -s tests -v
```

扩展语法和配置检查：

```bash
for file in extension/*.js extension/core/*.js extension/adapters/*.js; do node --check "$file"; done
python3 -m json.tool extension/manifest.json >/dev/null
```

Gemini/platform diagnostics mock：

```bash
node tests/test_platform_adapters.js
```

测试覆盖现有 ChatGPT active branch、current_node、长文本、Unicode、Markdown、分页拒绝、文件命名，以及平台识别、normalized model 和 Gemini 结构诊断。真实 Gemini transport/schema 和完整导出仍需浏览器 acceptance test 后才能标记为正式支持。
