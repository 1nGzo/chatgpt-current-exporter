(function () {
  "use strict";

  const SOURCE = "chatgpt-current-exporter";
  const converter = globalThis.CCEConversationConverter;
  const captured = new Map();
  const basePayloads = new Map();
  const messagePages = new Map();
  const runtimeDiagnostics = {
    extension: true,
    injected: false,
    fetchObserved: 0,
    xhrObserved: 0,
    jsonCandidates: 0,
    conversationCandidates: 0,
    jsonParseErrors: 0,
    streamResponses: 0,
    webSocketObserved: 0,
    webSocketMessages: 0,
    conversationEndpointObserved: 0,
    currentConversationEndpointResponses: 0,
    fallbackAttempts: 0,
    fallbackResponses: 0,
    fallbackConversationCandidates: 0,
    fallbackLastResult: "",
    fallbackConfigured: false,
    fallbackSkipReason: "",
    fallbackLastEndpoint: "",
    messagePageResponses: 0,
    messagePageCandidates: 0,
    cachedMessagePages: 0,
    capturedPageCount: 0,
    paginationState: "unknown",
    lastParsedStats: { mappingNodes: 0, activePathNodes: 0, excludedBranchNodes: 0, visibleMessages: 0, incompleteReasons: [] },
    lastParsedSchemaVariant: "none",
    lastPageInfo: { keys: [], hasMore: null, hasPreviousPage: null, hasNextPage: null, endCursorPresent: false },
    lastDetectedKeys: [],
    lastEndpointKeys: [],
    lastEndpointSchema: { mapping: false, currentNode: false, title: false, conversationId: null },
    lastCandidatePath: "",
    lastSchema: { mapping: false, messages: false, currentNode: false, title: false, conversationId: null, schemaType: "none" },
    lastContentType: "",
    lastResponsePath: "",
    observedResponsePaths: [],
    rejectedIdMismatches: 0,
    lastRescan: ""
  };
  let currentId = currentConversationId();
  let lastError = "";
  let panel = null;
  const namingConfigReady = loadLocalNamingConfig();

  function loadLocalNamingConfig() {
    if (!converter || typeof converter.setNamingRules !== "function" || typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.getURL !== "function") return Promise.resolve();
    return fetch(chrome.runtime.getURL("naming.local.json"), { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((config) => {
        if (config && Array.isArray(config.series_rules)) converter.setNamingRules(config.series_rules);
      })
      .catch(() => {
        // The optional file is intentionally absent in public clones.
      });
  }

  function currentConversationId() {
    try {
      const parts = new URL(window.location.href).pathname.split("/").filter(Boolean);
      const index = parts.lastIndexOf("c");
      return index >= 0 && parts[index + 1] ? decodeURIComponent(parts[index + 1]) : null;
    } catch (_) {
      return null;
    }
  }

  function currentEntry() {
    return currentId ? captured.get(currentId) || null : null;
  }

  function pageInfoOf(payload) {
    const value = payload && payload.page_info;
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  }

  function paginationState(basePayload, pages) {
    const pagePayloads = pages.map((page) => page && page.payload ? page.payload : page);
    const pageInfos = [basePayload, ...pagePayloads].map(pageInfoOf).filter(Boolean);
    if (!pageInfos.length) return "not-paginated";
    if (pageInfos.some((info) => info.has_previous_page === false)) return "complete";
    if (pageInfos.some((info) => info.has_previous_page === true)) return "waiting-older-pages";
    return "unknown";
  }

  function currentPageCount(id) {
    return messagePages.has(id) ? messagePages.get(id).length : 0;
  }

  function updateParsedDiagnostics(document, id) {
    runtimeDiagnostics.lastParsedStats = {
      mappingNodes: document.stats.mappingNodes,
      activePathNodes: document.stats.activePathNodes,
      excludedBranchNodes: document.stats.excludedBranchNodes,
      visibleMessages: document.stats.visibleMessages,
      incompleteReasons: document.stats.incompleteReasons.slice()
    };
    runtimeDiagnostics.lastPageInfo = { ...document.pageInfo, keys: document.pageInfo.keys.slice() };
    runtimeDiagnostics.lastSchema = {
      mapping: Boolean(document.stats.mappingNodes),
      messages: document.schemaVariant !== "mapping",
      currentNode: Boolean(document.stats.activePathNodes),
      title: Boolean(document.title),
      conversationId: document.conversationId || id,
      schemaType: document.schemaVariant || "mapping"
    };
    runtimeDiagnostics.lastParsedSchemaVariant = document.schemaVariant || "mapping";
  }

  function rebuildConversation(id) {
    const basePayload = basePayloads.get(id);
    if (!basePayload) return;
    const pages = messagePages.get(id) || [];
    const pagination = paginationState(basePayload, pages);
    runtimeDiagnostics.paginationState = pagination;
    runtimeDiagnostics.capturedPageCount = pages.length;
    const pagePayloads = pages.map((page) => page.payload);
    const payload = pagePayloads.length && typeof converter.mergeMessagePages === "function"
      ? converter.mergeMessagePages(basePayload, pagePayloads, { olderComplete: pagination === "complete" })
      : basePayload;
    let document;
    try {
      document = converter.inspect(payload);
    } catch (error) {
      captured.delete(id);
      lastError = `schema 解析失败：${error && error.message ? error.message : String(error)}`;
      runtimeDiagnostics.lastSchemaError = lastError;
      updatePanel();
      return;
    }
    updateParsedDiagnostics(document, id);
    if (document.stats.incompleteReasons.length) {
      captured.delete(id);
      const reason = document.stats.incompleteReasons.join("；");
      lastError = pagination === "waiting-older-pages"
        ? `当前响应仍有旧消息分页：${reason}；请继续向上滚动至最顶端后重新扫描`
        : `捕获响应明确表示不完整：${reason}`;
      updatePanel();
      return;
    }
    const rawText = `${JSON.stringify(payload, null, 2)}\n`;
    captured.set(id, {
      payload,
      document,
      rawText,
      rawSize: new Blob([rawText]).size,
      capturedAt: new Date().toISOString(),
      pageCount: pages.length,
      paginationState: pagination
    });
    lastError = "";
    updatePanel();
  }

  function safeCurrentUrl() {
    try {
      const url = new URL(window.location.href);
      return `${url.origin}${url.pathname}`;
    } catch (_) {
      return "(unavailable)";
    }
  }

  function readyReason(entry) {
    if (entry) {
      if (entry.document.stats.incompleteReasons.length) return `明确不完整：${entry.document.stats.incompleteReasons.join("；")}`;
      if (entry.document.messages.length === 0) return "active path 没有 user/assistant 可见消息";
      if (entry.paginationState === "complete" && entry.pageCount > 0) {
        if (entry.document.warningSummary) return `已合并 ${entry.pageCount} 个旧消息分页，active path 可导出；${entry.document.warningSummary}`;
        return `已合并 ${entry.pageCount} 个旧消息分页，active path 可导出`;
      }
      if (entry.document.warningSummary) return `已捕获 conversation，active path 可导出；${entry.document.warningSummary}`;
      return "已捕获 conversation，active path 可导出";
    }
    if (lastError) return lastError;
    if (runtimeDiagnostics.paginationState === "waiting-older-pages") return "当前 conversation 仍有旧消息分页；请继续向上滚动至最顶端后重新扫描";
    if (!currentId) return "当前 URL 未识别 /c/<conversation_id>";
    if (!runtimeDiagnostics.injected) return "尚未确认 injected.js 在 page world 运行";
    if (runtimeDiagnostics.fallbackSkipReason === "config-not-loaded") return "fallback adapter 未加载；请重新加载扩展并刷新当前页面";
    if (runtimeDiagnostics.fallbackLastResult === "json-without-mapping") return "当前 conversation endpoint 返回了 JSON，但没有发现 mapping；未生成不完整导出";
    if (runtimeDiagnostics.fallbackLastResult === "response-not-json") return "当前 conversation endpoint 返回的内容不是 JSON；未生成不完整导出";
    if (runtimeDiagnostics.fallbackLastResult === "request-failed") return "当前 conversation endpoint 重试失败；未生成不完整导出";
    if (runtimeDiagnostics.fallbackLastResult && runtimeDiagnostics.fallbackLastResult.startsWith("http-")) return `当前 conversation endpoint 返回 ${runtimeDiagnostics.fallbackLastResult}；未生成不完整导出`;
    if (runtimeDiagnostics.conversationCandidates === 0) {
      if (runtimeDiagnostics.jsonCandidates === 0) {
        if (runtimeDiagnostics.fetchObserved === 0 && runtimeDiagnostics.xhrObserved === 0) return "尚未观察到 fetch/XHR；请刷新当前会话";
        if (runtimeDiagnostics.streamResponses > 0) return "观察到 streaming response，但尚未发现 conversation JSON";
        return "已观察请求，但尚未解析出 JSON response";
      }
      return "已解析 JSON，但没有发现 mapping conversation response";
    }
    if (runtimeDiagnostics.rejectedIdMismatches > 0) return "conversation candidate 的 id 与当前 URL 不匹配";
    return "已发现 conversation candidate，但 schema 尚未通过 active path 解析";
  }

  function status() {
    const entry = currentEntry();
    const parsedDocument = entry ? entry.document : null;
    const stats = parsedDocument ? parsedDocument.stats : null;
    const reason = readyReason(entry);
    const state = lastError ? "Error" : (entry && (stats.incompleteReasons.length || stats.visibleMessages === 0) ? "Error" : entry && stats.warnings.length ? "Review" : entry ? "Ready" : "Waiting");
    return {
      extension: true,
      conversationId: currentId,
      title: parsedDocument ? parsedDocument.title : window.document.title || "",
      capturedAt: entry ? entry.capturedAt : null,
      captured: Boolean(entry),
      mappingNodes: stats ? stats.mappingNodes : 0,
      activePathNodes: stats ? stats.activePathNodes : 0,
      activePathMessages: stats ? stats.visibleMessages : 0,
      rawJsonSize: entry ? entry.rawSize : 0,
      pagesCaptured: entry ? entry.pageCount : currentPageCount(currentId),
      incompleteReasons: stats ? stats.incompleteReasons : [],
      warnings: stats ? stats.warnings : [],
      warningSummary: parsedDocument ? parsedDocument.warningSummary : "",
      state,
      readyReason: reason,
      diagnostics: {
        ...runtimeDiagnostics,
        currentUrl: safeCurrentUrl(),
        conversationId: currentId,
        pagesCaptured: entry ? entry.pageCount : currentPageCount(currentId),
        paginationState: entry ? entry.paginationState : runtimeDiagnostics.paginationState,
        mapping: Boolean(stats ? stats.mappingNodes : runtimeDiagnostics.lastSchema.mapping),
        currentNode: Boolean(stats ? stats.activePathNodes : runtimeDiagnostics.lastSchema.currentNode),
        readyReason: reason,
        lastDetectedKeys: runtimeDiagnostics.lastDetectedKeys.slice(),
        lastSchema: { ...runtimeDiagnostics.lastSchema }
      }
    };
  }

  function text(value) {
    return value === undefined || value === null || value === "" ? "—" : String(value);
  }

  function updatePanel() {
    if (!panel) return;
    const snapshot = status();
    panel.state.textContent = lastError || (snapshot.state === "Ready" ? "Ready（捕获结构化响应；完整性仍需实际验证）" : snapshot.state === "Review" ? "Review（有未识别字段，请检查诊断）" : snapshot.state === "Waiting" ? "Waiting：刷新会话后等待结构化响应" : "Error");
    panel.id.textContent = text(snapshot.conversationId);
    panel.title.textContent = text(snapshot.title);
    panel.detail.textContent = snapshot.captured ? `mapping ${snapshot.mappingNodes} · active path ${snapshot.activePathNodes} · messages ${snapshot.activePathMessages} · raw ${snapshot.rawJsonSize} bytes` : snapshot.readyReason;
    panel.button.disabled = !snapshot.captured || snapshot.incompleteReasons.length > 0 || snapshot.activePathMessages === 0;
  }

  function downloadText(filename, content, mimeType) {
    const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = "none";
    (document.body || document.documentElement).appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async function exportCurrent() {
    await namingConfigReady;
    const entry = currentEntry();
    if (!entry) {
      lastError = "尚未捕获完整 conversation 数据，可刷新当前会话后重试";
      updatePanel();
      return { ok: false, error: lastError };
    }
    if (entry.document.stats.incompleteReasons.length) {
      lastError = `捕获响应明确表示不完整：${entry.document.stats.incompleteReasons.join("；")}`;
      updatePanel();
      return { ok: false, error: lastError };
    }
    if (entry.document.messages.length === 0) {
      lastError = "active path 上没有可导出的 user/assistant 可见消息";
      updatePanel();
      return { ok: false, error: lastError };
    }
    try {
      const rendered = converter.renderMarkdown(entry.payload);
      const stem = converter.filenameStem(entry.document.title, entry.document.conversationId || currentId);
      // No artificial length limit: stringify and Blob retain the full payload.
      const rawText = entry.rawText || `${JSON.stringify(entry.payload, null, 2)}\n`;
      downloadText(`${stem}.raw.json`, rawText, "application/json");
      window.setTimeout(() => downloadText(`${stem}.md`, rendered.markdown, "text/markdown"), 300);
      lastError = "";
      updatePanel();
      return { ok: true, files: [`${stem}.raw.json`, `${stem}.md`] };
    } catch (error) {
      lastError = `导出失败：${error && error.message ? error.message : String(error)}`;
      updatePanel();
      return { ok: false, error: lastError };
    }
  }

  function capture(payload) {
    const payloadId = payload && (payload.conversation_id || payload.id)
      ? String(payload.conversation_id || payload.id)
      : null;
    if (payloadId && currentId && payloadId !== currentId) {
      runtimeDiagnostics.rejectedIdMismatches += 1;
      updatePanel();
      return;
    }
    const id = payloadId || currentId;
    if (!id) {
      lastError = "捕获到 conversation candidate，但当前 URL 没有可匹配的 conversation id";
      updatePanel();
      return;
    }
    basePayloads.set(id, payload);
    rebuildConversation(id);
  }

  function captureMessagePage(conversationId, payload, pageKey) {
    const id = conversationId ? String(conversationId) : currentId;
    if (!id) return;
    if (currentId && id !== currentId) {
      runtimeDiagnostics.rejectedIdMismatches += 1;
      return;
    }
    const pages = messagePages.get(id) || [];
    if (pageKey && pages.some((page) => page.pageKey === pageKey)) return;
    pages.push({ pageKey: pageKey || `page-${pages.length + 1}`, payload });
    messagePages.set(id, pages);
    runtimeDiagnostics.capturedPageCount = pages.length;
    if (basePayloads.has(id)) rebuildConversation(id);
    else updatePanel();
  }

  function mergeObserverDiagnostics(info) {
    if (!info || typeof info !== "object") return;
    for (const key of ["injected", "fetchObserved", "xhrObserved", "jsonCandidates", "conversationCandidates", "jsonParseErrors", "streamResponses", "webSocketObserved", "webSocketMessages", "conversationEndpointObserved", "currentConversationEndpointResponses", "fallbackAttempts", "fallbackResponses", "fallbackConversationCandidates", "fallbackLastResult", "fallbackConfigured", "fallbackSkipReason", "fallbackLastEndpoint", "messagePageResponses", "messagePageCandidates", "messagePagePreviousTrue", "messagePagePreviousFalse", "messagePagePreviousUnknown", "messagePageNextTrue", "messagePageNextFalse", "messagePageNextUnknown", "cachedMessagePages", "lastMessagePageKeys", "lastContentType", "lastResponsePath", "observedResponsePaths", "cacheSize", "fetchHooked", "xhrHooked", "lastCandidatePath"]) {
      if (info[key] !== undefined) runtimeDiagnostics[key] = info[key];
    }
    if (Array.isArray(info.lastDetectedKeys)) runtimeDiagnostics.lastDetectedKeys = info.lastDetectedKeys.slice(0, 80);
    if (Array.isArray(info.lastEndpointKeys)) runtimeDiagnostics.lastEndpointKeys = info.lastEndpointKeys.slice(0, 80);
    if (Array.isArray(info.lastMessagePageKeys)) runtimeDiagnostics.lastMessagePageKeys = info.lastMessagePageKeys.slice(0, 80);
    if (info.lastSchema && typeof info.lastSchema === "object") runtimeDiagnostics.lastSchema = { ...runtimeDiagnostics.lastSchema, ...info.lastSchema };
    if (info.lastEndpointSchema && typeof info.lastEndpointSchema === "object") runtimeDiagnostics.lastEndpointSchema = { ...runtimeDiagnostics.lastEndpointSchema, ...info.lastEndpointSchema };
    updatePanel();
  }

  function requestRescan() {
    lastError = "";
    runtimeDiagnostics.lastRescan = `requested ${new Date().toISOString()}`;
    window.postMessage({ source: SOURCE, type: "rescan", conversationId: currentId }, "*");
    updatePanel();
  }

  function buildPanel() {
    if (panel || !document.documentElement) return;
    const host = document.createElement("div");
    host.id = "cce-exporter-host";
    host.dataset.open = "false";
    host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; font-family: system-ui, sans-serif; }
        .shell { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
        .launcher { width: auto; min-width: 44px; padding: 8px 11px; color: #fff; background: #10a37f; border: 0; border-radius: 999px; box-shadow: 0 4px 14px #0005; cursor: pointer; font: 700 12px/1.2 system-ui, sans-serif; }
        .launcher:hover { background: #0d8f70; }
        .launcher:focus-visible, button:focus-visible { outline: 2px solid #8bd5ff; outline-offset: 2px; }
        .box { display: none; width: min(310px, calc(100vw - 32px)); color: #f5f5f5; background: #202123; border: 1px solid #565869; border-radius: 10px; box-shadow: 0 6px 24px #0008; padding: 12px; font-size: 12px; }
        :host([data-open="true"]) .box { display: block; }
        .header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
        .title { font-weight: 700; }
        .close { width: auto; padding: 2px 7px; color: #c5c5d2; background: transparent; border: 0; border-radius: 5px; cursor: pointer; font: 700 16px/1 system-ui, sans-serif; }
        .close:hover { color: #fff; background: #565869; }
        .state { color: #9bd6a4; margin-bottom: 6px; }
        .meta { color: #c5c5d2; word-break: break-word; line-height: 1.45; }
        .detail { color: #aab; margin: 7px 0; line-height: 1.4; }
        .box > .export, .box > .secondary { width: 100%; padding: 8px; color: #fff; background: #10a37f; border: 0; border-radius: 6px; cursor: pointer; font: 700 12px/1.2 system-ui, sans-serif; }
        .box button.secondary { margin-top: 6px; background: #565869; }
        .box button:hover:not(:disabled) { background: #0d8f70; }
        .box button.secondary:hover:not(:disabled) { background: #6b6d80; }
        button:disabled { color: #aaa; background: #555; cursor: not-allowed; }
      </style>
      <div class="shell">
        <section class="box" role="dialog" aria-label="ChatGPT 当前会话导出器">
          <div class="header">
            <div class="title">ChatGPT 当前会话导出器</div>
            <button class="close" type="button" aria-label="关闭导出器">×</button>
          </div>
          <div class="state"></div>
          <div class="meta">Conversation ID: <span class="id"></span></div>
          <div class="meta">Title: <span class="conversation-title"></span></div>
          <div class="detail"></div>
          <button class="export" type="button">导出当前会话</button>
        </section>
        <button class="launcher" type="button" aria-expanded="false" aria-controls="cce-exporter-panel" aria-label="打开 ChatGPT 当前会话导出器">导出器</button>
      </div>`;
    const box = {
      state: shadow.querySelector(".state"),
      id: shadow.querySelector(".id"),
      title: shadow.querySelector(".conversation-title"),
      detail: shadow.querySelector(".detail"),
      button: shadow.querySelector(".export"),
      close: shadow.querySelector(".close"),
      launcher: shadow.querySelector(".launcher")
    };
    const panelBox = shadow.querySelector(".box");
    panelBox.id = "cce-exporter-panel";
    function setOpen(open) {
      host.dataset.open = open ? "true" : "false";
      box.launcher.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) box.close.focus();
    }
    const rescanButton = document.createElement("button");
    rescanButton.type = "button";
    rescanButton.textContent = "重新扫描当前页面";
    rescanButton.className = "secondary";
    rescanButton.addEventListener("click", requestRescan);
    panelBox.appendChild(rescanButton);
    box.button.addEventListener("click", exportCurrent);
    box.launcher.addEventListener("click", () => setOpen(host.dataset.open !== "true"));
    box.close.addEventListener("click", () => {
      setOpen(false);
      box.launcher.focus();
    });
    document.documentElement.appendChild(host);
    panel = box;
    updatePanel();
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.source !== SOURCE) return;
    if (event.data.type === "observer-status") mergeObserverDiagnostics(event.data.diagnostics);
    if (event.data.type === "conversation-response") capture(event.data.payload);
    if (event.data.type === "conversation-message-page") captureMessagePage(event.data.conversationId, event.data.payload, event.data.pageKey);
  });

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || !message.type) return false;
      if (message.type === "GET_STATUS") {
        sendResponse(status());
        return false;
      }
      if (message.type === "EXPORT_CURRENT") {
        exportCurrent().then(sendResponse).catch((error) => sendResponse({ ok: false, error: `导出失败：${error && error.message ? error.message : String(error)}` }));
        return true;
      }
      if (message.type === "RESCAN_CURRENT") {
        requestRescan();
        sendResponse(status());
        return false;
      }
      return false;
    });
  }

  function injectObserver() {
    if (!document.documentElement || document.documentElement.querySelector("script[data-cce-observer]")) return;
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("injected.js");
    script.dataset.cceObserver = "true";
    script.onload = () => script.remove();
    script.onerror = () => {
      runtimeDiagnostics.injectionError = "injected.js script element failed to load";
      updatePanel();
    };
    (document.head || document.documentElement).appendChild(script);
  }

  injectObserver();
  // If the MAIN-world declaration ran before this isolated listener, ask it
  // to replay its bounded in-memory candidate cache after the listener exists.
  window.setTimeout(requestRescan, 0);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      injectObserver();
      buildPanel();
    }, { once: true });
  }
  else buildPanel();
  window.setInterval(() => {
    const nextId = currentConversationId();
    if (nextId !== currentId) {
      currentId = nextId;
      lastError = "";
      updatePanel();
    }
  }, 750);
})();
