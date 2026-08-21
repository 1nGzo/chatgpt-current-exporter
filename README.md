# ChatGPT 当前单会话导出器

这是一个本地优先的 Chromium Manifest V3 扩展和 Python 转换器，用于把浏览器当前打开的单个 ChatGPT conversation 保存为：

```text
<名称>.raw.json
<名称>.md
```

扩展只观察 ChatGPT 页面自己已经发出的 `fetch`/`XMLHttpRequest` JSON 响应，不抓取消息 DOM，不调用 OpenAI API，不上传任何数据，也不读取或保存 Cookie、Authorization、access token、session token、密码、analytics 或 telemetry。

## 当前实现

浏览器端由三层组成：

1. `extension/content.js` 在 `document_start` 运行，读取 URL、页面标题并提供右下角紧凑按钮和 popup 状态；点击该按钮后才展开页面导出面板。它不把 DOM 消息列表当作历史数据源。
2. `extension/injected.js` 以 page world 观察 `fetch` 和 XHR。它只对 response 做 `clone()`/读取，不修改原始 response，也不读取请求 headers。符合 conversation 形状的数据通过 `window.postMessage` 交给 content script。
3. `extension/converter.js` 优先使用 `mapping`/`current_node` active-path 规则；对当前 Web 返回的 `messages`/`current_node` 结构，会在内存中构造 synthetic mapping 后生成 Markdown；扩展随后通过 Blob 下载未经改写的 raw JSON 和 Markdown 两个文件。

Python 端的 `exporter/conversation.py` 是可重新处理历史 raw JSON 的独立核心；`exporter/markdown.py` 生成 Raw Markdown；`exporter/naming.py` 负责文件名和标题编号；`exporter/convert.py` 是 CLI。

mapping 结构的页面端和 Python 端都遵守：

```text
current_node → parent → parent → ... → root → reverse
```

因此只会输出当前 active path，不会按时间遍历 `mapping`，也不会混入兄弟 branch。`thoughts` 和 `reasoning_recap` 等内部 content type 不进入 Markdown，但仍保留在 raw JSON 中。没有 `message`、不可见 role、空正文节点会被跳过并计入诊断；未知 content part 不静默丢弃，而会写入可见占位符并标记 warning。

Markdown 采用稳定的 `Turn + metadata + 原文` 形态，并使用实际 conversation title 作为 H1。正文不总结、不改写、不截断、不按内容类型做语义过滤；中文、emoji、换行、Markdown 和 code block 都按原字符串写入。

## 文件命名

默认使用经过安全清洗的 conversation title 作为文件名。需要系列编号规则时，可复制：

```text
extension/naming.local.example.json → extension/naming.local.json
```

`naming.local.json` 被 `.gitignore` 排除，并同时供 Python CLI 和浏览器扩展读取。规则使用 `title_pattern`、第一个数字捕获组、`filename_prefix` 和 `minimum_digits`；因此不同用户可以配置自己的系列标题格式，而不会把个人命名信息提交到公开仓库。

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

默认 Markdown 写在 raw JSON 同目录，输出路径可自定义：

```bash
./chatgpt-current-export convert /path/to/conversation.raw.json \
  --output /path/to/output/conversation.md \
  --new \
  --verbose
```

CLI 会输出 title、conversation id、mapping 节点数、active path 节点数、user/assistant 数量、排除分支数量、状态和 Markdown 字节数。默认不输出正文预览，避免把私人内容刷进终端。

如果 payload 明确含有 `has_more`、`has_more_messages`、`truncated`、`partial`、`next_cursor` 等分页/截断信号，CLI 会以非零状态退出并拒绝生成 Markdown。没有这些字段并不等于后端完整性已被证明，因此状态会明确写成“payload completeness is not independently provable”。

## 安装 Chromium / Chrome 扩展

1. 打开 `chrome://extensions`。
2. 开启右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本目录下的 `extension/`，不是项目根目录。
5. 打开或刷新 `https://chatgpt.com/c/<conversation-id>`（旧域名 `chat.openai.com` 也匹配）。
6. 等待当前会话自己的结构化 JSON 响应被捕获。页面右下角的“导出器”小按钮或扩展 popup 会显示/提供状态；点击页面按钮后可查看 `Ready`、conversation id、mapping 数量、active path 数量和 raw 字节数。
7. 点击页面右下角“导出器”按钮打开面板，再点击“导出当前会话”；也可以打开扩展 popup 点击同名按钮。

文件会进入 Chrome 当前配置的默认下载目录。Chrome 可能在首次连续下载两个文件时要求允许该站点的多个自动下载；需要允许，否则可能只看到 raw 或只看到 Markdown。

如果显示：

```text
尚未捕获完整 conversation 数据，可刷新当前会话后重试
```

请刷新当前会话，让 `document_start` 监听器从请求开始运行，再等待页面加载完成；也可以先点击“重新扫描当前页面”。扩展不会改用 DOM 抓取来伪造完整结果。

## 当前接口不确定性与诊断

本项目不把某个 endpoint 作为唯一数据源。根据目标页面实际观察到的请求路径，并参考 API-first 的公开实现，`extension/fallback-config.js` 集中配置了受限的 verified same-origin fallback。重新扫描时按顺序尝试当前 URL 对应的 `/backend-api/conversations/<id>` 和兼容旧版本的 `/backend-api/conversation/<id>`，使用浏览器当前 session 的 `credentials: include`，不读取或保存认证 header/cookie/token：

```text
页面已经发出的、符合 conversation 结构的 JSON response
>
verified same-origin fallback（仅当前 conversation、仅 JSON response）
>
明确告诉用户尚未捕获
```

fallback response 仍必须通过 `mapping` 或 `messages`、`current_node`、active path 和可见消息检查；失败时不会生成半成品 Markdown。纯终端测试只能证明 parser、扩展语法和 fallback mock，不足以证明当前登录会话确实返回完整 conversation response。

如果仍然捕获不到数据，请只从 DevTools 的 Network 中提供一次请求的 Request URL 和不含认证信息的 response schema 字段，例如是否有 `mapping`、`current_node`、`title`、conversation id；不要提供 Cookie、Authorization、token、密码或完整私人 response。

## 测试

人工 fixture `fixtures/branch.json` 包含旧 assistant branch 和新 branch，`current_node` 指向 `E`；测试要求输出 `A → B2 → D → E`，不输出旧 branch。运行：

```bash
python3 -m unittest discover -s tests -v
```

覆盖：

- 无 branch、有 branch、空/metadata 节点；
- current_node active path 与循环/缺 parent 错误；
- 中文、emoji、multiline Markdown、code block；
- 5000 行长文本不截断；
- 显式分页/截断信号拒绝生成；
- 文件名清洗和可选的系列编号规则。

还可以运行扩展静态检查：

```bash
for file in extension/*.js; do node --check "$file"; done
python3 -m json.tool extension/manifest.json >/dev/null
```

## 已知限制

- 页面监听器只能捕获它安装之后页面自己发出的 JSON response；刷新通常是最可靠的重新捕获方式。
- 如果当前版本使用 streaming/SSE、明确存在下一页的分页 response、非 JSON transport，当前版本不会偷偷改成 DOM 抓取；它会保持 Waiting/Error 并提示需要诊断。`page_info.end_cursor` 单独存在不等于仍有下一页，需结合 `has_next_page`/`has_more` 或明确的 next cursor 判断。
- 扩展端和 Python 端各有一个小型 renderer，这是为了让一次点击可以同时下载两个本地文件；两者共享同一 active-path/schema 规则，但暂时没有真实页面的 parity fixture。Python 端是历史 raw JSON 的权威重建入口。
- 当前 ChatGPT 页面返回的 `messages` schema 已由扩展端兼容；本轮按任务边界未修改 Python 核心，因此这类 raw JSON 仍可由扩展直接生成 Markdown，但通过 Python CLI 重新生成仍需要后续增加同等 schema adapter。
- 对不可见内部节点只从 Markdown 过滤，不从 raw JSON 删除；附件正文若不在 response 中，只能保留 response 中已有的 pointer/metadata 占位符。
- Chrome 页面 Blob 下载可能受浏览器的多个下载确认和默认下载目录设置影响。

## Scope and privacy

本项目只处理用户主动导出的当前 conversation，并默认将数据保留在本地。它不上传数据、不调用云端 LLM 或 OpenAI API、不读取或保存认证信息，也不包含真实 conversation fixture。`exports/`、`*.raw.json`、可选的 `naming.local.json` 和临时文件均已加入 `.gitignore`，适合发布到公开仓库。
