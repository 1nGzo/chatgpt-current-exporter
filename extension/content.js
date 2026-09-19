(function () {
  "use strict";

  const SOURCE = "chatgpt-current-exporter";
  const converter = globalThis.CCEConversationConverter;
  const platformCore = globalThis.CCEPlatformCore;
  let platformId = platformCore && typeof platformCore.detectPlatform === "function"
    ? platformCore.detectPlatform(window.location.href)
    : "chatgpt";
  if (platformId === "unsupported") platformId = "chatgpt";
  let platformDefinition = platformCore && typeof platformCore.definition === "function"
    ? platformCore.definition(platformId)
    : { id: platformId, label: platformId };
  const captured = new Map();
  const basePayloads = new Map();
  const messagePages = new Map();
  const runtimeDiagnostics = {
    extension: true,
    platform: platformId,
    platformLabel: platformDefinition.label,
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
    lastRescan: "",
    readyReason: "等待结构化 response"
  };
  let currentId = currentConversationId();
  let lastError = "";
  let panel = null;
  let quickExport = null;
  let dotHistory = null;
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

  function currentConversationTitle() {
    try {
      return typeof window.document.title === "string" && window.document.title.trim()
        ? window.document.title.trim()
        : "Untitled conversation";
    } catch (_) {
      return "Untitled conversation";
    }
  }

  function payloadFingerprint(payload) {
    try {
      const text = JSON.stringify(payload);
      let hash = 2166136261;
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return `${text.length}:${(hash >>> 0).toString(16)}`;
    } catch (_) {
      return "unserializable";
    }
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
    const normalized = platformId === "chatgpt" && globalThis.CCEChatGPTAdapter && typeof globalThis.CCEChatGPTAdapter.normalize === "function"
      ? globalThis.CCEChatGPTAdapter.normalize(document, { sourceUrl: safeCurrentUrl(), capturedAt: new Date().toISOString() })
      : null;
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
      paginationState: pagination,
      normalized
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
    if (!currentId) return "当前 URL 未识别 conversation id";
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
      platform: platformId,
      platformLabel: platformDefinition.label,
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
    const snapshot = status();
    if (quickExport && typeof quickExport.update === "function") {
      quickExport.update(snapshot);
    }
  }

  function downloadText(filename, content, mimeType) {
    return converter.downloadText(filename, content, mimeType);
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
      const files = await converter.downloadExport(stem, rawText, rendered.markdown);
      lastError = "";
      updatePanel();
      return { ok: true, files };
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
    if (typeof info.platform === "string" && info.platform !== "unsupported" && info.platform !== platformId) {
      platformId = info.platform;
      platformDefinition = platformCore && typeof platformCore.definition === "function"
        ? platformCore.definition(platformId)
        : { id: platformId, label: platformId };
      currentId = currentConversationId();
      if (platformId === "chatgpt" && !dotHistory) {
        buildDotHistoryUI();
      }
    }
    for (const key of ["injected", "fetchObserved", "xhrObserved", "jsonCandidates", "conversationCandidates", "jsonParseErrors", "streamResponses", "webSocketObserved", "webSocketMessages", "conversationEndpointObserved", "currentConversationEndpointResponses", "fallbackAttempts", "fallbackResponses", "fallbackConversationCandidates", "fallbackLastResult", "fallbackConfigured", "fallbackSkipReason", "fallbackLastEndpoint", "messagePageResponses", "messagePageCandidates", "messagePagePreviousTrue", "messagePagePreviousFalse", "messagePagePreviousUnknown", "messagePageNextTrue", "messagePageNextFalse", "messagePageNextUnknown", "cachedMessagePages", "lastMessagePageKeys", "lastContentType", "lastResponsePath", "observedResponsePaths", "cacheSize", "fetchHooked", "xhrHooked", "lastCandidatePath", "lastCandidateContentType"]) {
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

  // --- Theme Management ---
  function detectTheme() {
    const html = document.documentElement;
    const body = document.body;
    const explicit = html?.getAttribute("data-theme") || body?.getAttribute("data-theme");
    if (explicit === "dark" || explicit === "light") return explicit;
    if (html?.classList.contains("dark") || body?.classList.contains("dark")) return "dark";
    if (html?.classList.contains("light") || body?.classList.contains("light")) return "light";
    try {
      const bg = window.getComputedStyle(body || html).backgroundColor;
      const match = bg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      if (match) {
        const lum = (0.2126 * match[1] + 0.7152 * match[2] + 0.0722 * match[3]) / 255;
        return lum < 0.5 ? "dark" : "light";
      }
    } catch (_) {}
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function applyThemeToRoots() {
    const theme = detectTheme();
    const addClass = theme === "dark" ? "cce-theme-dark" : "cce-theme-light";
    const removeClass = theme === "dark" ? "cce-theme-light" : "cce-theme-dark";
    if (quickExport && quickExport.root) {
      quickExport.root.classList.remove(removeClass);
      quickExport.root.classList.add(addClass);
    }
    if (dotHistory && dotHistory.root) {
      dotHistory.root.classList.remove(removeClass);
      dotHistory.root.classList.add(addClass);
    }
  }

  function initThemeSync() {
    applyThemeToRoots();
    const observer = new MutationObserver(() => applyThemeToRoots());
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
    if (document.body) {
      observer.observe(document.body, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    if (media && media.addEventListener) media.addEventListener("change", applyThemeToRoots);
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatTimestamp(raw) {
    if (!raw) return "";
    try {
      const t = typeof raw === "number" ? (raw < 1e11 ? raw * 1000 : raw) : new Date(raw).getTime();
      if (Number.isNaN(t)) return "";
      const d = new Date(t);
      const hours = String(d.getHours()).padStart(2, "0");
      const minutes = String(d.getMinutes()).padStart(2, "0");
      return `${hours}:${minutes}`;
    } catch (_) {
      return "";
    }
  }

  // --- In-Page Unified Dock & Quick Export UI ---
  function buildQuickExportUI() {
    if (quickExport || !document.documentElement) return;
    const host = document.createElement("div");
    host.id = "cce-quick-export-host";
    host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483645;pointer-events:none;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; -webkit-font-smoothing: antialiased; }
        * { box-sizing: border-box; }
        .cce-quick-shell { pointer-events: auto; display: flex; flex-direction: column; align-items: flex-end; }
        .cce-theme-light {
          --cce-bg: rgba(255, 255, 255, 0.96);
          --cce-surface-hover: #f0f0f0;
          --cce-border: rgba(0, 0, 0, 0.1);
          --cce-border-subtle: rgba(0, 0, 0, 0.06);
          --cce-text-primary: #0d0d0d;
          --cce-text-secondary: #5d5d5d;
          --cce-text-tertiary: #8e8e8e;
          --cce-shadow-pill: 0 2px 8px rgba(0, 0, 0, 0.06);
          --cce-shadow-menu: 0 4px 16px rgba(0, 0, 0, 0.1);
        }
        .cce-theme-dark {
          --cce-bg: rgba(33, 33, 33, 0.96);
          --cce-surface-hover: #383838;
          --cce-border: rgba(255, 255, 255, 0.12);
          --cce-border-subtle: rgba(255, 255, 255, 0.08);
          --cce-text-primary: #ececec;
          --cce-text-secondary: #b4b4b4;
          --cce-text-tertiary: #737373;
          --cce-shadow-pill: 0 2px 10px rgba(0, 0, 0, 0.3);
          --cce-shadow-menu: 0 6px 20px rgba(0, 0, 0, 0.4);
        }
        .cce-quick-pill {
          display: inline-flex;
          align-items: center;
          height: 32px;
          background: var(--cce-bg);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          border: 1px solid var(--cce-border);
          border-radius: 8px;
          box-shadow: var(--cce-shadow-pill);
          overflow: hidden;
          transition: border-color 150ms ease, box-shadow 150ms ease;
        }
        .cce-quick-pill:hover { border-color: var(--cce-text-tertiary); }
        .cce-dock-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          height: 100%;
          padding: 0 11px;
          border: 0;
          background: transparent;
          color: var(--cce-text-primary);
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          user-select: none;
          transition: background-color 150ms ease, color 150ms ease;
        }
        .cce-dock-btn:hover:not(:disabled) { background: var(--cce-surface-hover); }
        .cce-dock-btn.is-active { background: var(--cce-surface-hover); font-weight: 600; }
        .cce-dock-btn:disabled { opacity: 0.45; cursor: not-allowed; }
        .cce-dock-divider {
          width: 1px;
          height: 14px;
          background: var(--cce-border-subtle);
          flex-shrink: 0;
        }
        .cce-format-menu {
          position: absolute;
          bottom: 38px;
          right: 0;
          min-width: 140px;
          background: var(--cce-bg);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          border: 1px solid var(--cce-border);
          border-radius: 8px;
          box-shadow: var(--cce-shadow-menu);
          padding: 4px;
          display: none;
          flex-direction: column;
          gap: 2px;
        }
        .cce-format-menu.is-open { display: flex; }
        .cce-format-item {
          width: 100%;
          padding: 6px 8px;
          border: 0;
          border-radius: 6px;
          background: transparent;
          color: var(--cce-text-primary);
          font-size: 11.5px;
          font-weight: 400;
          text-align: left;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: space-between;
          transition: background-color 120ms ease;
        }
        .cce-format-item:hover { background: var(--cce-surface-hover); }
        .cce-format-item.is-selected { font-weight: 600; }
        .cce-format-item.is-selected::after { content: "✓"; font-size: 11px; }
      </style>
      <div class="cce-quick-shell cce-theme-light">
        <div class="cce-quick-pill">
          <button class="cce-dock-btn cce-dock-history" type="button" aria-label="Toggle prompt history" title="Toggle prompt history" style="${platformId === "chatgpt" ? "" : "display:none;"}">
            History
          </button>
          <div class="cce-dock-divider" style="${platformId === "chatgpt" ? "" : "display:none;"}"></div>
          <button class="cce-dock-btn cce-dock-export cce-quick-btn" type="button" aria-label="Export conversation" aria-haspopup="true" aria-expanded="false" title="Export conversation" disabled>
            <span class="cce-quick-label">Export</span>
          </button>
        </div>
        <div class="cce-format-menu" role="menu" aria-hidden="true">
          <button class="cce-format-item" data-format="markdown" type="button" role="menuitem">Markdown</button>
          <button class="cce-format-item" data-format="json" type="button" role="menuitem">JSON</button>
          <button class="cce-format-item" data-format="both" type="button" role="menuitem">Markdown + JSON</button>
        </div>
      </div>`;

    const root = shadow.querySelector(".cce-quick-shell");
    const historyBtn = shadow.querySelector(".cce-dock-history");
    const exportBtn = shadow.querySelector(".cce-dock-export");
    const label = shadow.querySelector(".cce-quick-label");
    const formatMenu = shadow.querySelector(".cce-format-menu");
    const formatItems = Array.from(shadow.querySelectorAll(".cce-format-item"));

    let currentFormat = "markdown";

    function syncFormatSelection(format) {
      currentFormat = ["markdown", "json", "both"].includes(format) ? format : "markdown";
      formatItems.forEach((it) => it.classList.toggle("is-selected", it.dataset.format === currentFormat));
    }

    chrome.storage.local.get({ exportFormat: "markdown" }).then(({ exportFormat }) => {
      syncFormatSelection(exportFormat);
      updatePanel();
    }).catch(() => {});

    function closeFormatMenu() {
      formatMenu.classList.remove("is-open");
      exportBtn.setAttribute("aria-expanded", "false");
    }

    function toggleFormatMenu() {
      const open = formatMenu.classList.toggle("is-open");
      exportBtn.setAttribute("aria-expanded", String(open));
    }

    if (historyBtn) {
      historyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        closeFormatMenu();
        if (dotHistory && typeof dotHistory.toggleHistory === "function") {
          dotHistory.toggleHistory();
        } else if (dotHistory && typeof dotHistory.toggleRail === "function") {
          dotHistory.toggleRail();
        }
      });
    }

    exportBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (exportBtn.disabled) return;
      toggleFormatMenu();
    });

    async function triggerExportWithFormat(format) {
      if (exportBtn.disabled) return;
      currentFormat = format;
      chrome.storage.local.set({ exportFormat: format });
      syncFormatSelection(format);
      closeFormatMenu();
      exportBtn.disabled = true;
      const prevText = label.textContent;
      label.textContent = "导出中…";
      try {
        const result = await exportCurrent();
        if (result && result.ok) {
          label.textContent = "已导出 ✓";
          setTimeout(() => {
            label.textContent = prevText;
            updatePanel();
          }, 1500);
        } else {
          label.textContent = "导出失败";
          exportBtn.title = (result && result.error) || "导出失败";
          setTimeout(() => {
            label.textContent = prevText;
            updatePanel();
          }, 2000);
        }
      } catch (err) {
        label.textContent = "导出失败";
        exportBtn.title = (err && err.message) || String(err);
        setTimeout(() => {
          label.textContent = prevText;
          updatePanel();
        }, 2000);
      }
    }

    formatItems.forEach((item) => {
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        const nextFmt = item.dataset.format;
        triggerExportWithFormat(nextFmt);
      });
    });

    document.addEventListener("click", (e) => {
      if (!host.contains(e.target)) closeFormatMenu();
    });

    quickExport = {
      root,
      btn: exportBtn,
      label,
      historyBtn,
      setHistoryActive: (active) => {
        if (historyBtn) historyBtn.classList.toggle("is-active", !!active);
      },
      update: (snapshot) => {
        const ready = snapshot.captured && snapshot.incompleteReasons.length === 0 && snapshot.activePathMessages > 0;
        exportBtn.disabled = !ready;
        exportBtn.title = ready ? "导出当前会话" : (lastError || snapshot.readyReason || "等待捕获会话数据…");
      }
    };

    document.documentElement.appendChild(host);
    applyThemeToRoots();
  }

  // --- Dot History & Voyage History Window UI (ChatGPT only) ---
  function buildDotHistoryUI() {
    if (dotHistory || platformId !== "chatgpt" || !navigatorBackend || !document.documentElement) return;

    const host = document.createElement("div");
    host.id = "cce-dot-history-host";
    host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483646;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; -webkit-font-smoothing: antialiased; }
        * { box-sizing: border-box; }
        .cce-theme-light {
          --cce-bg: #ffffff;
          --cce-bg-secondary: #f4f4f4;
          --cce-border: rgba(0, 0, 0, 0.1);
          --cce-border-subtle: rgba(0, 0, 0, 0.06);
          --cce-text-primary: #0d0d0d;
          --cce-text-secondary: #5d5d5d;
          --cce-text-tertiary: #8e8e8e;
          --cce-surface-hover: rgba(0, 0, 0, 0.05);
          --cce-active-item-bg: rgba(0, 0, 0, 0.08);
          --cce-dot-muted: rgba(0, 0, 0, 0.25);
          --cce-dot-active: #0d0d0d;
          --cce-shadow-pill: 0 2px 8px rgba(0, 0, 0, 0.08);
          --cce-shadow-popover: 0 4px 16px rgba(0, 0, 0, 0.1);
          --cce-shadow-window: 0 16px 48px rgba(0, 0, 0, 0.18), 0 0 0 1px rgba(0, 0, 0, 0.08);
        }
        .cce-theme-dark {
          --cce-bg: #212121;
          --cce-bg-secondary: #2c2c2c;
          --cce-border: rgba(255, 255, 255, 0.12);
          --cce-border-subtle: rgba(255, 255, 255, 0.08);
          --cce-text-primary: #ececec;
          --cce-text-secondary: #b4b4b4;
          --cce-text-tertiary: #737373;
          --cce-surface-hover: rgba(255, 255, 255, 0.08);
          --cce-active-item-bg: rgba(255, 255, 255, 0.12);
          --cce-dot-muted: rgba(255, 255, 255, 0.28);
          --cce-dot-active: #ececec;
          --cce-shadow-pill: 0 2px 10px rgba(0, 0, 0, 0.35);
          --cce-shadow-popover: 0 6px 20px rgba(0, 0, 0, 0.4);
          --cce-shadow-window: 0 16px 48px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.1);
        }
        .cce-dot-shell { pointer-events: none; width: 100%; height: 100%; position: relative; }

        /* [ · · · ] Handle: Native icon button launcher for History Window */
        .cce-dot-handle {
          position: fixed;
          width: 28px;
          height: 28px;
          padding: 0;
          border: 1px solid var(--cce-border-subtle);
          border-radius: 7px;
          background: var(--cce-bg);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          color: var(--cce-text-secondary);
          cursor: pointer;
          z-index: 2147483646;
          display: flex;
          align-items: center;
          justify-content: center;
          touch-action: none;
          pointer-events: auto;
          user-select: none;
          box-shadow: var(--cce-shadow-pill);
          transition: background-color 150ms ease, color 150ms ease, border-color 150ms ease;
        }
        .cce-dot-handle:hover {
          background: var(--cce-surface-hover);
          color: var(--cce-text-primary);
          border-color: var(--cce-text-tertiary);
        }
        .cce-dot-handle:focus-visible { outline: 1px solid var(--cce-text-secondary); outline-offset: 1px; }
        .cce-dot-handle.is-hidden { display: none !important; }
        .cce-dot-handle-mark { display: flex; gap: 3.5px; align-items: center; }
        .cce-dot-handle-mark i { width: 3px; height: 3px; border-radius: 50%; background: currentColor; display: block; }

        /* Dot History Rail: Pure dots without connection line or card background */
        .cce-dot-timeline {
          position: fixed;
          right: 12px;
          top: 50%;
          transform: translateY(-50%);
          width: 20px;
          max-height: min(440px, calc(100vh - 140px));
          z-index: 2147483645;
          pointer-events: auto;
          user-select: none;
          background: transparent;
          border: none;
          box-shadow: none;
          transition: opacity 150ms ease;
        }
        .cce-dot-timeline.is-hidden { display: none; }
        .cce-dot-track {
          height: 100%;
          width: 100%;
          overflow-y: auto;
          overflow-x: hidden;
          overscroll-behavior: contain;
          scrollbar-width: none;
          background: transparent;
          border: none;
        }
        .cce-dot-track::-webkit-scrollbar { display: none; }
        .cce-dot-content { position: relative; width: 100%; }
        .cce-dot-node {
          position: absolute;
          left: 50%;
          width: 20px;
          height: 20px;
          transform: translate(-50%, -50%);
          padding: 0;
          border: 0;
          border-radius: 50%;
          background: transparent;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .cce-dot {
          width: 4px;
          height: 4px;
          border-radius: 50%;
          background: var(--cce-dot-muted);
          transition: transform 120ms ease, background-color 120ms ease;
          pointer-events: none;
        }
        .cce-dot-node:hover .cce-dot,
        .cce-dot-node:focus-visible .cce-dot {
          background: var(--cce-dot-active);
          transform: scale(1.35);
        }
        .cce-dot-node.is-active .cce-dot {
          width: 6px;
          height: 6px;
          background: var(--cce-dot-active);
          transform: none;
        }
        .cce-dot-node:focus-visible { outline: 1px solid var(--cce-text-secondary); outline-offset: 1px; }
        .cce-dot-node.is-seeking .cce-dot {
          animation: cce-dot-pulse 0.75s ease-in-out infinite alternate;
          background: var(--cce-dot-active);
        }
        @keyframes cce-dot-pulse {
          0% { opacity: 0.35; transform: scale(0.85); }
          100% { opacity: 1; transform: scale(1.35); }
        }
        .cce-history-item.is-seeking {
          opacity: 0.6;
        }

        /* Dot Hover Preview Tooltip: Anchored next to hovered dot */
        .cce-dot-preview {
          position: fixed;
          width: max-content;
          max-width: min(280px, calc(100vw - 80px));
          box-sizing: border-box;
          border: 1px solid var(--cce-border);
          border-radius: 8px;
          padding: 8px 10px;
          font-size: 12px;
          line-height: 1.45;
          overflow-wrap: anywhere;
          color: var(--cce-text-primary);
          background: var(--cce-bg);
          box-shadow: var(--cce-shadow-popover);
          opacity: 0;
          visibility: hidden;
          pointer-events: none;
          transition: opacity 100ms ease;
          z-index: 2147483647;
          display: none;
        }
        .cce-dot-preview.is-visible { display: block; opacity: 1; visibility: visible; }

        /* Voyage-style Anchored History Window Popover */
        .cce-history-window {
          position: fixed;
          width: 380px;
          max-width: calc(100vw - 24px);
          max-height: min(480px, calc(100vh - 32px));
          background: var(--cce-bg);
          border: 1px solid var(--cce-border);
          border-radius: 12px;
          box-shadow: var(--cce-shadow-window);
          display: flex;
          flex-direction: column;
          overflow: hidden;
          z-index: 2147483647;
          pointer-events: auto;
          user-select: none;
          animation: cce-appear 140ms cubic-bezier(0.16, 1, 0.3, 1);
        }
        .cce-history-window.is-hidden { display: none; }
        @keyframes cce-appear {
          from { opacity: 0; transform: scale(0.97); }
          to { opacity: 1; transform: scale(1); }
        }
        .cce-history-header {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 12px;
          border-bottom: 1px solid var(--cce-border-subtle);
        }
        .cce-history-search-wrap {
          display: flex;
          align-items: center;
          gap: 8px;
          flex: 1;
          background: var(--cce-surface-hover);
          border: 1px solid var(--cce-border-subtle);
          border-radius: 8px;
          padding: 6px 10px;
          transition: border-color 150ms ease;
        }
        .cce-history-search-wrap:focus-within {
          border-color: var(--cce-text-tertiary);
        }
        .cce-history-search-icon {
          width: 14px;
          height: 14px;
          color: var(--cce-text-tertiary);
          flex-shrink: 0;
        }
        .cce-history-search-input {
          flex: 1;
          border: 0;
          background: transparent;
          color: var(--cce-text-primary);
          font-size: 13px;
          outline: none;
          padding: 0;
          font-family: inherit;
        }
        .cce-history-search-input::placeholder {
          color: var(--cce-text-tertiary);
        }
        .cce-history-close-btn {
          width: 28px;
          height: 28px;
          display: flex;
          align-items: center;
          justify-content: center;
          border: 0;
          border-radius: 6px;
          background: transparent;
          color: var(--cce-text-secondary);
          cursor: pointer;
          transition: background-color 120ms ease, color 120ms ease;
        }
        .cce-history-close-btn:hover {
          background: var(--cce-surface-hover);
          color: var(--cce-text-primary);
        }
        .cce-history-close-btn svg { width: 13px; height: 13px; }
        .cce-history-body {
          flex: 1;
          overflow-y: auto;
          padding: 6px;
          overscroll-behavior: contain;
        }
        .cce-history-list {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .cce-history-item {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 10px;
          border-radius: 8px;
          cursor: pointer;
          font-size: 12.5px;
          line-height: 1.4;
          color: var(--cce-text-primary);
          transition: background-color 100ms ease;
        }
        .cce-history-item:hover {
          background: var(--cce-surface-hover);
        }
        .cce-history-item.is-active {
          background: var(--cce-active-item-bg);
          font-weight: 500;
        }
        .cce-history-item-order {
          font-size: 11px;
          font-weight: 600;
          color: var(--cce-text-tertiary);
          min-width: 24px;
          flex-shrink: 0;
        }
        .cce-history-item.is-active .cce-history-item-order {
          color: var(--cce-text-primary);
        }
        .cce-history-item-preview {
          flex: 1;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .cce-history-item-time {
          font-size: 11px;
          color: var(--cce-text-tertiary);
          flex-shrink: 0;
          margin-left: 6px;
        }
        .cce-history-empty {
          padding: 36px 16px;
          text-align: center;
          color: var(--cce-text-tertiary);
          font-size: 13px;
        }
        .cce-history-empty.is-hidden { display: none; }
      </style>
      <div class="cce-dot-shell cce-theme-light">
        <button class="cce-dot-handle is-hidden" type="button" aria-label="Open prompt history" title="Prompt History">
          <span class="cce-dot-handle-mark" aria-hidden="true">
            <i></i><i></i><i></i>
          </span>
        </button>
        <div class="cce-dot-timeline is-hidden" aria-label="Prompt Dots Timeline">
          <div class="cce-dot-track">
            <div class="cce-dot-content"></div>
          </div>
        </div>
        <div class="cce-dot-preview" role="tooltip"></div>
        <div class="cce-history-window cce-history-overlay is-hidden" role="dialog" aria-label="Prompt History Window">
          <div class="cce-history-header">
            <div class="cce-history-search-wrap">
              <svg class="cce-history-search-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
                <circle cx="7" cy="7" r="4.5"></circle>
                <path d="M10.5 10.5L14 14" stroke-linecap="round"></path>
              </svg>
              <input type="text" class="cce-history-search-input" placeholder="搜索提示词 (Search prompts)..." autocomplete="off" spellcheck="false" />
            </div>
            <button class="cce-history-close-btn" type="button" aria-label="Close" title="关闭 (Esc)">
              <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round">
                <path d="M3 3l8 8M11 3l-8 8"></path>
              </svg>
            </button>
          </div>
          <div class="cce-history-body">
            <div class="cce-history-list" role="listbox"></div>
            <div class="cce-history-empty is-hidden">未找到匹配的提示词</div>
          </div>
        </div>
      </div>`;

    const root = shadow.querySelector(".cce-dot-shell");
    const handle = shadow.querySelector(".cce-dot-handle");
    const timeline = shadow.querySelector(".cce-dot-timeline");
    const track = shadow.querySelector(".cce-dot-track");
    const content = shadow.querySelector(".cce-dot-content");
    const preview = shadow.querySelector(".cce-dot-preview");

    const historyWindow = shadow.querySelector(".cce-history-window");
    const overlay = historyWindow;
    const closeBtn = shadow.querySelector(".cce-history-close-btn");
    const searchInput = shadow.querySelector(".cce-history-search-input");
    const historyList = shadow.querySelector(".cce-history-list");
    const historyEmpty = shadow.querySelector(".cce-history-empty");

    let isHistoryActive = false;
    let isHistoryWindowOpen = false;
    let initializedForCurrent = false;
    let currentItems = [];
    let activeIndex = -1;

    function clampPosition(left, top) {
      const maxLeft = Math.max(8, window.innerWidth - 28 - 8);
      const maxTop = Math.max(8, window.innerHeight - 28 - 8);
      return {
        left: Math.max(8, Math.min(maxLeft, left)),
        top: Math.max(8, Math.min(maxTop, top))
      };
    }

    function updateHistoryWindowPosition() {
      if (!isHistoryWindowOpen) return;
      const handleRect = handle.getBoundingClientRect();
      const winWidth = Math.min(380, window.innerWidth - 24);
      const winHeight = Math.min(480, window.innerHeight - 32);
      const gap = 8;

      // 1. Horizontal: Preferred to the left of handle
      let left = handleRect.left - winWidth - gap;
      if (left < 8) {
        if (handleRect.right + gap + winWidth <= window.innerWidth - 8) {
          left = handleRect.right + gap;
        } else {
          left = Math.max(8, window.innerWidth - winWidth - 8);
        }
      }

      // 2. Vertical: Preferred to align near handle top or left-bottom
      let top = handleRect.top - 16;
      top = Math.max(12, Math.min(window.innerHeight - winHeight - 12, top));

      historyWindow.style.left = `${Math.round(left)}px`;
      historyWindow.style.top = `${Math.round(top)}px`;
      historyWindow.style.width = `${Math.round(winWidth)}px`;
      historyWindow.style.maxHeight = `${Math.round(winHeight)}px`;
    }

    function applyHandlePosition(left, top) {
      const clamped = clampPosition(left, top);
      handle.style.left = `${clamped.left}px`;
      handle.style.top = `${clamped.top}px`;
      handle.style.right = "auto";
      if (isHistoryWindowOpen) {
        updateHistoryWindowPosition();
      }
    }

    const defaultLeft = window.innerWidth - 28 - 14;
    const defaultTop = Math.round(window.innerHeight / 2 - 140);
    applyHandlePosition(defaultLeft, defaultTop);

    chrome.storage.local.get({ cce_dot_position: null }).then(({ cce_dot_position }) => {
      if (cce_dot_position && typeof cce_dot_position.left === "number" && typeof cce_dot_position.top === "number") {
        applyHandlePosition(cce_dot_position.left, cce_dot_position.top);
      }
    }).catch(() => {});

    let isDragging = false;
    let hasMoved = false;
    let startX = 0, startY = 0;
    let startLeft = 0, startTop = 0;
    let curLeft = 0, curTop = 0;

    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      startX = e.clientX;
      startY = e.clientY;
      const rect = handle.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      curLeft = startLeft;
      curTop = startTop;
      isDragging = true;
      hasMoved = false;
      handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener("pointermove", (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!hasMoved) {
        if (dx * dx + dy * dy < 25) return;
        hasMoved = true;
      }
      const nextPos = clampPosition(startLeft + dx, startTop + dy);
      curLeft = nextPos.left;
      curTop = nextPos.top;
      handle.style.left = `${curLeft}px`;
      handle.style.top = `${curTop}px`;
      handle.style.right = "auto";
      if (isHistoryWindowOpen) {
        updateHistoryWindowPosition();
      }
    });

    function finishDrag() {
      if (!isDragging) return;
      isDragging = false;
      if (hasMoved) {
        chrome.storage.local.set({ cce_dot_position: { left: curLeft, top: curTop } });
      }
    }

    handle.addEventListener("pointerup", finishDrag);
    handle.addEventListener("pointercancel", finishDrag);

    window.addEventListener("resize", () => {
      const rect = handle.getBoundingClientRect();
      applyHandlePosition(rect.left, rect.top);
      if (isHistoryWindowOpen) {
        updateHistoryWindowPosition();
      }
      hidePreview();
    });

    function showPreview(index, node) {
      const item = currentItems[index];
      if (!item || !preview || !node) return;
      const text = item.previewText || item.preview || item.text || "";
      const timeStr = formatTimestamp(item.createTime);
      const orderStr = `#${item.userOrder || index + 1}`;

      preview.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;font-size:10.5px;font-weight:600;color:var(--cce-text-tertiary);">
          <span>${orderStr}</span>
          ${timeStr ? `<span>${timeStr}</span>` : ""}
        </div>
        <div style="color:var(--cce-text-primary);word-break:break-word;max-height:140px;overflow:hidden;text-overflow:ellipsis;">
          ${escapeHtml(text)}
        </div>
      `;

      preview.style.display = "block";
      preview.style.left = "0px";
      preview.style.top = "0px";
      preview.style.right = "auto";
      preview.style.bottom = "auto";

      const dotRect = node.getBoundingClientRect();
      const pw = preview.offsetWidth || 240;
      const ph = preview.offsetHeight || 36;
      const gap = 12;

      // 1. Calculate preferred left position (to the left of dot)
      let left = dotRect.left - pw - gap;
      if (left < 8) {
        if (dotRect.right + gap + pw <= window.innerWidth - 8) {
          left = dotRect.right + gap;
        } else {
          left = Math.max(8, window.innerWidth - pw - 8);
        }
      }

      // 2. Vertical center align with dot
      const dotCenterY = (dotRect.top + dotRect.bottom) / 2;
      let top = dotCenterY - ph / 2;

      // 3. Viewport clamp near top/bottom edges
      top = Math.max(8, Math.min(window.innerHeight - ph - 8, top));

      preview.style.left = `${Math.round(left)}px`;
      preview.style.top = `${Math.round(top)}px`;
      preview.classList.add("is-visible");
    }

    function hidePreview() {
      if (preview) {
        preview.classList.remove("is-visible");
        preview.style.display = "none";
      }
    }

    track.addEventListener("wheel", (e) => {
      if (content.scrollHeight > track.clientHeight) {
        e.preventDefault();
        e.stopPropagation();
        track.scrollTop += e.deltaY;
        hidePreview();
      }
    }, { passive: false });

    function setActiveDot(index) {
      activeIndex = index;
      const buttons = content.querySelectorAll(".cce-dot-node");
      buttons.forEach((btn, idx) => {
        btn.classList.toggle("is-active", idx === index);
      });
      if (isHistoryWindowOpen) {
        const listItems = historyList.querySelectorAll(".cce-history-item");
        listItems.forEach((it) => {
          it.classList.toggle("is-active", Number(it.dataset.index) === index);
        });
      }
    }

    function renderDots(items) {
      currentItems = Array.isArray(items) ? items : [];
      content.innerHTML = "";
      if (currentItems.length === 0) return;

      const count = currentItems.length;
      const trackHeight = track.clientHeight || 320;
      const pitch = count <= 1 ? 24 : Math.min(24, Math.max(8, (trackHeight - 20) / (count - 1)));
      const contentHeight = Math.max(trackHeight, count * pitch + 16);
      content.style.height = `${contentHeight}px`;

      const fragment = document.createDocumentFragment();
      currentItems.forEach((item, index) => {
        const node = document.createElement("button");
        node.type = "button";
        node.className = "cce-dot-node";
        node.dataset.index = String(index);
        node.setAttribute("aria-label", `Jump to prompt ${item.userOrder || item.order || index + 1}`);

        const dot = document.createElement("span");
        dot.className = "cce-dot";
        node.appendChild(dot);

        const topPx = 10 + index * pitch;
        node.style.top = `${topPx}px`;

        node.addEventListener("mouseenter", () => showPreview(index, node));
        node.addEventListener("mouseleave", hidePreview);
        node.addEventListener("focus", () => showPreview(index, node));
        node.addEventListener("blur", hidePreview);
        node.addEventListener("click", async () => {
          node.classList.add("is-seeking");
          try {
            const res = await navigatorBackend.jumpToPrompt(item);
            if (res && res.ok) {
              setActiveDot(index);
            }
          } finally {
            node.classList.remove("is-seeking");
          }
        });

        fragment.appendChild(node);
      });
      content.appendChild(fragment);

      if (activeIndex >= 0 && activeIndex < count) {
        setActiveDot(activeIndex);
      } else {
        setActiveDot(count - 1);
      }
    }

    function setHistoryActive(active) {
      isHistoryActive = Boolean(active);
      handle.classList.toggle("is-hidden", !isHistoryActive);
      timeline.classList.toggle("is-hidden", !isHistoryActive);
      if (quickExport && typeof quickExport.setHistoryActive === "function") {
        quickExport.setHistoryActive(isHistoryActive);
      }
      if (isHistoryActive) {
        if (!initializedForCurrent) {
          initializedForCurrent = true;
          globalThis.CCEHistoryNavigator.open();
        }
        renderDots(navigatorBackend.getState().items);
      } else {
        hidePreview();
        closeHistoryWindow();
      }
    }

    // --- Voyage-style History Window ---
    function renderHistoryList(query = "") {
      historyList.innerHTML = "";
      const q = (query || "").trim().toLowerCase();
      const filtered = q
        ? currentItems.filter((it) => (it.previewText || it.preview || it.text || "").toLowerCase().includes(q))
        : currentItems;

      if (filtered.length === 0) {
        historyEmpty.classList.remove("is-hidden");
        return;
      }
      historyEmpty.classList.add("is-hidden");

      const fragment = document.createDocumentFragment();
      filtered.forEach((item) => {
        const itemIdx = currentItems.indexOf(item);
        const el = document.createElement("div");
        el.className = "cce-history-item";
        el.setAttribute("role", "option");
        el.dataset.index = String(itemIdx);
        if (itemIdx === activeIndex) {
          el.classList.add("is-active");
        }

        const orderSpan = document.createElement("span");
        orderSpan.className = "cce-history-item-order";
        orderSpan.textContent = `#${item.userOrder || itemIdx + 1}`;
        el.appendChild(orderSpan);

        const previewSpan = document.createElement("span");
        previewSpan.className = "cce-history-item-preview";
        previewSpan.textContent = item.previewText || item.preview || item.text || "（空提示词）";
        el.appendChild(previewSpan);

        const timeStr = formatTimestamp(item.createTime);
        if (timeStr) {
          const timeSpan = document.createElement("span");
          timeSpan.className = "cce-history-item-time";
          timeSpan.textContent = timeStr;
          el.appendChild(timeSpan);
        }

        el.addEventListener("click", async () => {
          el.classList.add("is-seeking");
          const dotBtn = content.querySelector(`.cce-dot-node[data-index="${itemIdx}"]`);
          if (dotBtn) dotBtn.classList.add("is-seeking");
          closeHistoryWindow();
          try {
            const res = await navigatorBackend.jumpToPrompt(item);
            if (res && res.ok) {
              setActiveDot(itemIdx);
            }
          } finally {
            el.classList.remove("is-seeking");
            if (dotBtn) dotBtn.classList.remove("is-seeking");
          }
        });

        fragment.appendChild(el);
      });
      historyList.appendChild(fragment);
    }

    function openHistoryWindow() {
      isHistoryWindowOpen = true;
      historyWindow.classList.remove("is-hidden");
      updateHistoryWindowPosition();
      if (!initializedForCurrent) {
        initializedForCurrent = true;
        globalThis.CCEHistoryNavigator.open();
      }
      currentItems = navigatorBackend.getState().items || [];
      searchInput.value = "";
      renderHistoryList("");
      updateHistoryWindowPosition();
      setTimeout(() => {
        searchInput.focus();
        const activeItemEl = historyList.querySelector(".cce-history-item.is-active");
        if (activeItemEl) {
          activeItemEl.scrollIntoView({ block: "center", behavior: "instant" });
        }
      }, 50);
    }

    function closeHistoryWindow() {
      isHistoryWindowOpen = false;
      historyWindow.classList.add("is-hidden");
      searchInput.value = "";
    }

    searchInput.addEventListener("input", () => {
      renderHistoryList(searchInput.value);
    });

    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeHistoryWindow();
    });

    // Close on outside pointerdown (no modal backdrop)
    document.addEventListener("pointerdown", (e) => {
      if (!isHistoryWindowOpen) return;
      const path = e.composedPath ? e.composedPath() : [];
      if (!path.includes(historyWindow) && !path.includes(handle)) {
        closeHistoryWindow();
      }
    });

    // Handle button ONLY launches History Window
    handle.addEventListener("click", (e) => {
      e.stopPropagation();
      if (hasMoved) {
        hasMoved = false;
        return;
      }
      if (isHistoryWindowOpen) {
        closeHistoryWindow();
      } else {
        openHistoryWindow();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (isHistoryWindowOpen) {
          closeHistoryWindow();
          handle.focus();
        } else if (isHistoryActive) {
          setHistoryActive(false);
        }
      }
    });

    navigatorBackend.subscribe((state) => {
      if (state.items) {
        currentItems = state.items;
        if (isHistoryActive) {
          renderDots(state.items);
        }
        if (isHistoryWindowOpen) {
          renderHistoryList(searchInput.value);
        }
      }
    });

    let scrollThrottle = null;
    function syncActiveFromViewport() {
      if ((!isHistoryActive && !isHistoryWindowOpen) || currentItems.length === 0) return;
      const viewportCenter = window.innerHeight / 2;
      let closestIdx = -1;
      let minDistance = Infinity;

      for (let i = 0; i < currentItems.length; i++) {
        const item = currentItems[i];
        let el = item.node;
        if (!el || !el.isConnected) {
          if (item.messageId) {
            el = document.querySelector(`[data-message-id="${item.messageId}"], [data-turn-id="${item.messageId}"]`);
            if (el) item.node = el;
          }
        }
        if (el && el.isConnected) {
          const rect = el.getBoundingClientRect();
          const center = (rect.top + rect.bottom) / 2;
          const dist = Math.abs(center - viewportCenter);
          if (dist < minDistance) {
            minDistance = dist;
            closestIdx = i;
          }
        }
      }

      if (closestIdx >= 0 && closestIdx !== activeIndex) {
        setActiveDot(closestIdx);
      }
    }

    window.addEventListener("scroll", () => {
      if (scrollThrottle) return;
      scrollThrottle = requestAnimationFrame(() => {
        scrollThrottle = null;
        syncActiveFromViewport();
      });
    }, { passive: true });

    dotHistory = {
      root,
      isHistoryActive: () => isHistoryActive,
      toggleHistory: () => setHistoryActive(!isHistoryActive),
      setHistoryActive,
      toggleRail: () => setHistoryActive(!isHistoryActive),
      openRail: () => setHistoryActive(true),
      closeRail: () => setHistoryActive(false),
      openWindow: openHistoryWindow,
      closeWindow: closeHistoryWindow,
      reset: () => {
        initializedForCurrent = false;
        currentItems = [];
        activeIndex = -1;
        if (isHistoryActive) {
          setHistoryActive(false);
        }
        closeHistoryWindow();
      }
    };

    document.documentElement.appendChild(host);
    applyThemeToRoots();
  }

  function buildUI() {
    buildQuickExportUI();
    if (platformId === "chatgpt") {
      buildDotHistoryUI();
    }
    initThemeSync();
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

  const navigatorBackend =
    platformId === "chatgpt" && globalThis.CCEChatGPTNavigator && typeof globalThis.CCEChatGPTNavigator.createChatGPTNavigatorBackend === "function"
      ? globalThis.CCEChatGPTNavigator.createChatGPTNavigatorBackend({ converter })
      : null;

  if (navigatorBackend) {
    globalThis.CCEHistoryNavigator = {
      ...navigatorBackend,
      open: (opt) => navigatorBackend.open(currentId, basePayloads.get(currentId), opt),
      init: (opt) => navigatorBackend.init(currentId, basePayloads.get(currentId), opt)
    };
  }

  injectObserver();
  // If the MAIN-world declaration ran before this isolated listener, ask it
  // to replay its bounded in-memory candidate cache after the listener exists.
  window.setTimeout(requestRescan, 0);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      injectObserver();
      buildUI();
    }, { once: true });
  }
  else buildUI();
  window.setInterval(() => {
    const nextId = currentConversationId();
    if (nextId !== currentId) {
      currentId = nextId;
      if (navigatorBackend) {
        navigatorBackend.resetForConversation(nextId);
        if (dotHistory && typeof dotHistory.reset === "function") {
          dotHistory.reset();
        }
      }
      lastError = "";
      updatePanel();
    }
  }, 750);
})();
