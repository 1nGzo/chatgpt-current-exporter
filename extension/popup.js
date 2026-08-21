(function () {
  "use strict";

  const state = document.getElementById("state");
  const id = document.getElementById("conversation-id");
  const title = document.getElementById("conversation-title");
  const captured = document.getElementById("captured");
  const stats = document.getElementById("stats");
  const diagnostics = document.getElementById("diagnostics");
  const button = document.getElementById("export");
  const rescan = document.getElementById("rescan");
  let tabId = null;

  function safeUrl(value) {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname}`;
    } catch (_) {
      return "(unavailable)";
    }
  }

  function formatDiagnostics(snapshot) {
    const d = snapshot && snapshot.diagnostics ? snapshot.diagnostics : {};
    return [
      `Extension: ${snapshot && snapshot.extension ? "YES" : "NO"}`,
      `Injected: ${d.injected ? "YES" : "NO"}`,
      `Current URL: ${d.currentUrl || "—"}`,
      `Fetch observed: ${d.fetchObserved || 0}`,
      `XHR observed: ${d.xhrObserved || 0}`,
      `JSON candidates: ${d.jsonCandidates || 0}`,
      `Conversation candidates: ${d.conversationCandidates || 0}`,
      `Last detected keys: ${Array.isArray(d.lastDetectedKeys) && d.lastDetectedKeys.length ? d.lastDetectedKeys.join(", ") : "—"}`,
      `Last candidate path: ${d.lastCandidatePath || "—"}`,
      `Conversation endpoint responses: ${d.currentConversationEndpointResponses || 0}`,
      `Endpoint keys: ${Array.isArray(d.lastEndpointKeys) && d.lastEndpointKeys.length ? d.lastEndpointKeys.join(", ") : "—"}`,
      `Fallback: ${d.fallbackAttempts || 0} attempts / ${d.fallbackResponses || 0} JSON / ${d.fallbackConversationCandidates || 0} candidates`,
      `Fallback configured: ${d.fallbackConfigured ? "YES" : "NO"}`,
      `Fallback endpoint: ${d.fallbackLastEndpoint || "—"}`,
      `Fallback skip reason: ${d.fallbackSkipReason || "—"}`,
      `Fallback result: ${d.fallbackLastResult || "—"}`,
      `Message page responses: ${d.messagePageResponses || 0}`,
      `Message page candidates: ${d.messagePageCandidates || 0}`,
      `Page flags: previous true=${d.messagePagePreviousTrue || 0} false=${d.messagePagePreviousFalse || 0} unknown=${d.messagePagePreviousUnknown || 0} · next true=${d.messagePageNextTrue || 0} false=${d.messagePageNextFalse || 0} unknown=${d.messagePageNextUnknown || 0}`,
      `Message page keys: ${Array.isArray(d.lastMessagePageKeys) && d.lastMessagePageKeys.length ? d.lastMessagePageKeys.join(", ") : "—"}`,
      `Captured pages: ${snapshot && snapshot.pagesCaptured ? snapshot.pagesCaptured : 0} · pagination=${d.paginationState || (snapshot && snapshot.paginationState) || "—"}`,
      `Conversation id: ${d.conversationId || "—"}`,
      `Schema: ${d.lastParsedSchemaVariant || (d.lastSchema && d.lastSchema.schemaType) || "—"}`,
      `Parsed: mapping ${d.lastParsedStats ? d.lastParsedStats.mappingNodes : 0} / active path ${d.lastParsedStats ? d.lastParsedStats.activePathNodes : 0} / excluded branch ${d.lastParsedStats ? d.lastParsedStats.excludedBranchNodes : 0} / messages ${d.lastParsedStats ? d.lastParsedStats.visibleMessages : 0}`,
      `Page info: ${d.lastPageInfo && Array.isArray(d.lastPageInfo.keys) && d.lastPageInfo.keys.length ? d.lastPageInfo.keys.join(", ") : "—"} · has_previous_page=${d.lastPageInfo && d.lastPageInfo.hasPreviousPage !== null ? d.lastPageInfo.hasPreviousPage : "—"} · has_next_page=${d.lastPageInfo && d.lastPageInfo.hasNextPage !== null ? d.lastPageInfo.hasNextPage : "—"} · has_more=${d.lastPageInfo && d.lastPageInfo.hasMore !== null ? d.lastPageInfo.hasMore : "—"} · end_cursor=${d.lastPageInfo && d.lastPageInfo.endCursorPresent ? "YES" : "NO"}`,
      `mapping: ${d.mapping ? "YES" : "NO"}`,
      `current_node: ${d.currentNode ? "YES" : "NO"}`,
      `Ready reason: ${d.readyReason || (snapshot && snapshot.readyReason) || "—"}`,
      snapshot && snapshot.warningSummary ? `Warnings: ${snapshot.warningSummary}` : "",
      `Stream responses: ${d.streamResponses || 0}`,
      `WebSocket observed: ${d.webSocketObserved || 0}`,
      `WebSocket messages: ${d.webSocketMessages || 0}`,
      `JSON parse errors: ${d.jsonParseErrors || 0}`,
      `ID mismatches: ${d.rejectedIdMismatches || 0}`,
      d.lastContentType ? `Last content-type: ${d.lastContentType}` : "",
      d.lastResponsePath ? `Last response path: ${d.lastResponsePath}` : "",
      Array.isArray(d.observedResponsePaths) && d.observedResponsePaths.length ? `Response paths: ${d.observedResponsePaths.join(" | ")}` : "",
      d.injectionError ? `Injection error: ${d.injectionError}` : "",
      d.lastSchemaError ? `Schema error: ${d.lastSchemaError}` : ""
    ].filter(Boolean).join("\n");
  }

  function showError(message, url) {
    state.textContent = message;
    state.style.color = "#a33";
    button.disabled = true;
    diagnostics.textContent = [
      "Extension: NO",
      `Current URL: ${url || "(unavailable)"}`,
      `Ready reason: ${message}`
    ].join("\n");
  }

  function show(snapshot) {
    state.style.color = snapshot.state === "Ready" ? "#146c43" : snapshot.state === "Error" ? "#a33" : "#865b00";
    state.textContent = snapshot.state === "Ready" ? "Ready（完整性仍需实际验证）" : snapshot.state === "Review" ? "Review（有未识别字段，请检查诊断）" : snapshot.state;
    id.textContent = snapshot.conversationId || "—";
    title.textContent = snapshot.title || "—";
    captured.textContent = snapshot.capturedAt || "—";
    stats.textContent = snapshot.captured ? `mapping ${snapshot.mappingNodes} · active path ${snapshot.activePathNodes} · messages ${snapshot.activePathMessages} · raw ${snapshot.rawJsonSize} bytes` : "—";
    diagnostics.textContent = formatDiagnostics(snapshot);
    button.disabled = !snapshot.captured || snapshot.incompleteReasons.length > 0 || snapshot.activePathMessages === 0;
    rescan.disabled = false;
  }

  function refreshStatus() {
    if (tabId === null) return;
    chrome.tabs.sendMessage(tabId, { type: "GET_STATUS" }, (snapshot) => {
      if (chrome.runtime.lastError || !snapshot) return showError("请在 ChatGPT 会话页刷新后重试");
      show(snapshot);
    });
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || tab.id === undefined) return showError("没有找到当前标签页", tab && tab.url ? safeUrl(tab.url) : null);
    tabId = tab.id;
    chrome.tabs.sendMessage(tabId, { type: "GET_STATUS" }, (snapshot) => {
      if (chrome.runtime.lastError || !snapshot) return showError("请在 ChatGPT 会话页刷新后重试", tab.url ? safeUrl(tab.url) : null);
      show(snapshot);
    });
  });

  rescan.addEventListener("click", () => {
    if (tabId === null) return;
    state.textContent = "正在重新扫描当前页面…";
    chrome.tabs.sendMessage(tabId, { type: "RESCAN_CURRENT" }, (snapshot) => {
      if (chrome.runtime.lastError || !snapshot) return showError("重新扫描失败，请刷新 ChatGPT 会话页");
      show(snapshot);
      window.setTimeout(refreshStatus, 800);
    });
  });

  button.addEventListener("click", () => {
    if (tabId === null) return;
    state.textContent = "正在准备本地文件…";
    chrome.tabs.sendMessage(tabId, { type: "EXPORT_CURRENT" }, (result) => {
      if (chrome.runtime.lastError || !result || !result.ok) return showError((result && result.error) || "导出失败，请查看会话页状态");
      state.style.color = "#146c43";
      state.textContent = `已开始下载：${result.files.join("、")}`;
    });
  });
})();
