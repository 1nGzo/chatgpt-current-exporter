/* Page-world request observer. It returns every original request result intact. */
(function () {
  "use strict";
  if (window.__CCE_REQUEST_OBSERVER__) return;
  window.__CCE_REQUEST_OBSERVER__ = true;
  const SOURCE = "chatgpt-current-exporter";
  const platformCore = globalThis.CCEPlatformCore;
  const platform = platformCore && typeof platformCore.detectPlatform === "function"
    ? platformCore.detectPlatform(window.location.href)
    : "chatgpt";
  const geminiAdapter = globalThis.CCEGeminiAdapter;
  const diagnostics = {
    platform,
    platformLabel: platformCore && typeof platformCore.definition === "function" ? platformCore.definition(platform).label : platform,
    injected: true,
    fetchHooked: false,
    xhrHooked: false,
    fetchObserved: 0,
    xhrObserved: 0,
    jsonCandidates: 0,
    conversationCandidates: 0,
    jsonParseErrors: 0,
    streamResponses: 0,
    webSocketHooked: false,
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
    messagePagePreviousTrue: 0,
    messagePagePreviousFalse: 0,
    messagePagePreviousUnknown: 0,
    messagePageNextTrue: 0,
    messagePageNextFalse: 0,
    messagePageNextUnknown: 0,
    cachedMessagePages: 0,
    lastMessagePageKeys: [],
    lastDetectedKeys: [],
    lastEndpointKeys: [],
    lastEndpointSchema: { mapping: false, currentNode: false, title: false, conversationId: null },
    lastCandidatePath: "",
    lastCandidateContentType: "",
    lastSchema: { mapping: false, messages: false, currentNode: false, title: false, conversationId: null, schemaType: "none" },
    lastContentType: "",
    lastResponsePath: "",
    observedResponsePaths: [],
    cacheSize: 0,
    candidateResponses: 0,
    candidateUserTurns: 0,
    candidateAssistantTurns: 0,
    normalizedUserTurns: 0,
    normalizedAssistantTurns: 0,
    possibleTotalTurns: 0,
    topLevelShape: "unknown",
    structuralSignature: "",
    paginationDetected: false,
    truncationDetected: false,
    branchSelection: "NONE_DETECTED",
    completeness: "WAITING",
    readyReason: "等待 Gemini 结构化 response",
    batchResponses: 0,
    batchFrames: 0,
    batchInnerPayloads: 0,
    batchParseFailures: 0,
    batchRpcIds: []
  };
  const cache = new Map();
  const cacheOrder = [];
  const pageCache = [];
  const geminiPayloadCache = [];
  const geminiPayloadKeys = new Set();
  let originalFetch = null;

  const SENSITIVE_KEY = /^(?:authorization|cookie|setcookie|accesstoken|access_token|refreshtoken|refresh_token|idtoken|id_token|sessiontoken|session_token|csrftoken|csrf_token|xsrftoken|xsrf_token|apikey|api_key|clientsecret|client_secret|password|secret|credential|credentials|token)$/i;

  function redactSensitiveFields(value, depth = 0, seen = new WeakSet()) {
    if (value === null || value === undefined || typeof value !== "object" || depth > 14) return value;
    if (seen.has(value)) return "[cycle omitted]";
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => redactSensitiveFields(item, depth + 1, seen));
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) continue;
      result[key] = redactSensitiveFields(child, depth + 1, seen);
    }
    return result;
  }

  function payloadFingerprint(value) {
    try {
      const text = JSON.stringify(value);
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

  function publishStatus() {
    window.postMessage({ source: SOURCE, type: "observer-status", diagnostics: {
      ...diagnostics,
      lastDetectedKeys: diagnostics.lastDetectedKeys.slice(),
      lastSchema: { ...diagnostics.lastSchema }
    } }, "*");
  }

  function safeKeys(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    return Object.keys(value).slice(0, 80);
  }

  function safePath(value) {
    try {
      const url = new URL(String(value));
      return `${url.origin}${url.pathname}`;
    } catch (_) {
      return "(unavailable)";
    }
  }

  function endpointConversationId(value) {
    try {
      const config = globalThis.CCEFallbackConfig;
      return config && typeof config.extractConversationId === "function" ? config.extractConversationId(value) : null;
    } catch (_) {
      return null;
    }
  }

  function endpointKind(value) {
    try {
      const config = globalThis.CCEFallbackConfig;
      return config && typeof config.classifyPath === "function" ? config.classifyPath(value) : "unknown";
    } catch (_) {
      return "unknown";
    }
  }

  function currentPageConversationId() {
    if (platform === "gemini" && platformCore && typeof platformCore.conversationIdHint === "function") {
      return platformCore.conversationIdHint(window.location.href, platform);
    }
    try {
      const parts = new URL(window.location.href).pathname.split("/").filter(Boolean);
      const index = parts.lastIndexOf("c");
      return index >= 0 && parts[index + 1] ? decodeURIComponent(parts[index + 1]) : null;
    } catch (_) {
      return null;
    }
  }

  function rememberPath(value) {
    const path = safePath(value);
    diagnostics.lastResponsePath = path;
    if (path !== "(unavailable)" && !diagnostics.observedResponsePaths.includes(path)) {
      diagnostics.observedResponsePaths = diagnostics.observedResponsePaths.concat(path).slice(-12);
    }
    return path;
  }

  function findCandidate(value) {
    const queue = [{ value, path: "$", depth: 0 }];
    const seen = new Set();
    while (queue.length) {
      const current = queue.shift();
      const item = current.value;
      if (!item || typeof item !== "object" || seen.has(item)) continue;
      seen.add(item);
      const hasMapping = item.mapping && typeof item.mapping === "object" && !Array.isArray(item.mapping);
      const hasMessageList = Array.isArray(item.messages) && item.messages.length > 0 && item.current_node !== undefined && item.current_node !== null && item.current_node !== "" && (item.conversation_id || item.id);
      if (hasMapping || hasMessageList) return current;
      if (current.depth >= 4) continue;
      if (Array.isArray(item)) {
        item.slice(0, 8).forEach((child, index) => queue.push({ value: child, path: `${current.path}[${index}]`, depth: current.depth + 1 }));
      } else {
        Object.keys(item).slice(0, 80).forEach((key) => {
          const child = item[key];
          if (child && typeof child === "object") queue.push({ value: child, path: `${current.path}.${key}`, depth: current.depth + 1 });
        });
      }
    }
    return null;
  }

  function directCandidate(value) {
    const found = findCandidate(value);
    return found ? found.value : null;
  }

  function schema(value) {
    const found = findCandidate(value);
    const candidate = found ? found.value : null;
    const mapping = Boolean(candidate && candidate.mapping && typeof candidate.mapping === "object" && !Array.isArray(candidate.mapping));
    const messages = Boolean(candidate && Array.isArray(candidate.messages) && candidate.messages.length > 0);
    return {
      mapping,
      messages,
      currentNode: Boolean(candidate && candidate.current_node !== undefined && candidate.current_node !== null && candidate.current_node !== ""),
      title: Boolean(candidate && typeof candidate.title === "string" && candidate.title.length > 0),
      conversationId: candidate && (candidate.conversation_id || candidate.id) ? String(candidate.conversation_id || candidate.id) : null,
      candidatePath: found ? found.path : "",
      schemaType: mapping ? "mapping" : messages ? "messages" : "none"
    };
  }

  function messageItems(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const candidates = [
      value.messages,
      value.items,
      value.data && value.data.messages,
      value.data && value.data.items
    ];
    for (const items of candidates) {
      if (!Array.isArray(items) || items.length === 0) continue;
      const messageLike = items.some((item) => item && typeof item === "object" && !Array.isArray(item) && (
        item.id || item.message || item.author || item.content || item.parent || item.parent_message_id
      ));
      if (messageLike) return items;
    }
    if (value.mapping && typeof value.mapping === "object" && !Array.isArray(value.mapping)) {
      const nodes = Object.entries(value.mapping).map(([id, node]) => node && typeof node === "object" && !node.id ? { id, ...node } : node);
      if (nodes.some((item) => item && typeof item === "object" && (item.message || item.author || item.content))) return nodes;
    }
    return null;
  }

  function isMessagePage(value, responsePath) {
    return endpointKind(responsePath) === "conversation-messages" && Boolean(messageItems(value));
  }

  function isConversation(value) {
    return Boolean(directCandidate(value));
  }

  function isCandidate(value) {
    return isConversation(value);
  }

  function post(payload, transport, countCandidate) {
    if (!isCandidate(payload)) return;
    if (countCandidate) {
      const shape = schema(payload);
      diagnostics.conversationCandidates += 1;
      diagnostics.lastSchema = shape;
      cacheConversation(payload, shape);
      publishStatus();
    }
    // Deliberately send no request headers, credentials, cookies, or tokens.
    window.postMessage({ source: SOURCE, type: "conversation-response", payload, transport: String(transport || "unknown") }, "*");
  }

  function pageKey(payload, responsePath) {
    const pageInfo = payload && payload.page_info;
    const start = pageInfo && pageInfo.start_cursor ? String(pageInfo.start_cursor) : "";
    const end = pageInfo && pageInfo.end_cursor ? String(pageInfo.end_cursor) : "";
    const items = messageItems(payload) || [];
    const first = items[0] && (items[0].id || (items[0].message && items[0].message.id)) || "";
    const last = items[items.length - 1] && (items[items.length - 1].id || (items[items.length - 1].message && items[items.length - 1].message.id)) || "";
    return `${safePath(responsePath)}|${start}|${end}|${String(first)}|${String(last)}|${items.length}`;
  }

  function postMessagePage(payload, transport, responsePath, conversationId) {
    const items = messageItems(payload);
    if (!items || !conversationId) return;
    const key = pageKey(payload, responsePath);
    if (!pageCache.some((page) => page.key === key)) {
      pageCache.push({ key, conversationId: String(conversationId), payload });
    }
    diagnostics.messagePageCandidates += 1;
    diagnostics.cachedMessagePages = pageCache.length;
    diagnostics.lastMessagePageKeys = safeKeys(payload);
    publishStatus();
    window.postMessage({
      source: SOURCE,
      type: "conversation-message-page",
      conversationId: String(conversationId),
      pageKey: key,
      payload,
      transport: String(transport || "unknown"),
      responsePath: safePath(responsePath)
    }, "*");
  }

  function recordMessagePageFlags(payload) {
    const pageInfo = payload && payload.page_info;
    const previous = pageInfo && pageInfo.has_previous_page;
    const next = pageInfo && pageInfo.has_next_page;
    if (previous === true) diagnostics.messagePagePreviousTrue += 1;
    else if (previous === false) diagnostics.messagePagePreviousFalse += 1;
    else diagnostics.messagePagePreviousUnknown += 1;
    if (next === true) diagnostics.messagePageNextTrue += 1;
    else if (next === false) diagnostics.messagePageNextFalse += 1;
    else diagnostics.messagePageNextUnknown += 1;
  }

  function cacheConversation(payload, shape) {
    const key = shape.conversationId || "__unknown__";
    if (!cache.has(key)) cacheOrder.push(key);
    cache.set(key, payload);
    while (cacheOrder.length > 5) cache.delete(cacheOrder.shift());
    diagnostics.cacheSize = cache.size;
  }

  function isGeminiBatchPath(responsePath) {
    return platform === "gemini" && /\/batchexecute(?:$|[?#])/.test(String(responsePath || ""));
  }

  function postGeminiStructure(payload, transport, contentType, responsePath, rpcId, topLevelShape) {
    if (!geminiAdapter || typeof geminiAdapter.inspectResponse !== "function") return;
    const report = geminiAdapter.inspectResponse(
      payload,
      safePath(responsePath),
      currentPageConversationId(),
      topLevelShape ? { topLevelShape } : {}
    );
    diagnostics.candidateResponses += report.possibleCandidate ? 1 : 0;
    diagnostics.geminiConversationCandidates = diagnostics.candidateResponses;
    diagnostics.candidateUserTurns = report.possibleUserMessages || 0;
    diagnostics.candidateAssistantTurns = report.possibleAssistantMessages || 0;
    diagnostics.possibleTotalTurns = report.possibleTurnCount || 0;
    diagnostics.normalizedUserTurns = 0;
    diagnostics.normalizedAssistantTurns = 0;
    diagnostics.topLevelShape = report.topLevelShape || topLevelShape || "unknown";
    diagnostics.structuralSignature = report.structuralSignature || "";
    diagnostics.geminiLastTopLevelKeys = Array.isArray(report.topLevelKeys) ? report.topLevelKeys.slice(0, 80) : [];
    diagnostics.geminiLastWrapperDepth = report.wrapperDepth === undefined ? null : report.wrapperDepth;
    diagnostics.geminiLastTurnCount = report.possibleTurnCount || 0;
    diagnostics.geminiLastUserMessages = report.possibleUserMessages || 0;
    diagnostics.geminiLastAssistantMessages = report.possibleAssistantMessages || 0;
    diagnostics.geminiPaginationDetected = Boolean(report.paginationDetected);
    diagnostics.geminiPaginationSignals = Array.isArray(report.paginationSignals) ? report.paginationSignals.slice(0, 20) : [];
    diagnostics.geminiPaginationPossible = Boolean(report.paginationPossible);
    diagnostics.geminiTruncationDetected = Boolean(report.truncationDetected);
    diagnostics.geminiTruncationSignals = Array.isArray(report.truncationSignals) ? report.truncationSignals.slice(0, 20) : [];
    diagnostics.geminiCompleteness = report.completeness || "WAITING";
    diagnostics.completeness = diagnostics.geminiCompleteness;
    diagnostics.geminiSchemaVerified = Boolean(report.schemaVerified);
    diagnostics.geminiOrderingValidated = Boolean(report.orderingValidated);
    diagnostics.geminiBranchSelection = report.branchSelection || "NONE_DETECTED";
    diagnostics.branchSelection = diagnostics.geminiBranchSelection;
    diagnostics.geminiLastFieldHints = Array.isArray(report.fieldHints) ? report.fieldHints.slice(0, 40) : [];
    diagnostics.geminiLastConversationId = report.conversationId || currentPageConversationId() || null;
    diagnostics.readyReason = report.readyReason || "Gemini schema、历史聚合、顺序、candidate 和完整性尚未经过 live 验证";
    diagnostics.lastDetectedKeys = Array.isArray(report.topLevelKeys) ? report.topLevelKeys.slice(0, 80) : [];
    diagnostics.lastContentType = String(contentType || "");
    diagnostics.lastResponsePath = safePath(responsePath);
    if (report.possibleCandidate) {
      diagnostics.lastCandidatePath = safePath(responsePath);
      diagnostics.lastCandidateContentType = String(contentType || "");
    }
    const conversationRelated = Boolean(
      report.possibleCandidate ||
      (Array.isArray(report.fieldHints) && report.fieldHints.length) ||
      report.paginationDetected ||
      report.truncationDetected ||
      (Array.isArray(report.branchSignals) && report.branchSignals.length)
    );
    if (!conversationRelated) {
      publishStatus();
      return;
    }
    const storedPayload = redactSensitiveFields(payload);
    const cacheKey = `${diagnostics.lastResponsePath}|${rpcId || ""}|${report.structuralSignature || ""}|${report.possibleTurnCount || 0}|${payloadFingerprint(storedPayload)}`;
    if (!geminiPayloadKeys.has(cacheKey)) {
      geminiPayloadKeys.add(cacheKey);
      geminiPayloadCache.push({
        payload: storedPayload,
        report,
        conversationId: report.conversationId || currentPageConversationId(),
        transport: String(transport || "unknown"),
        contentType: String(contentType || ""),
        responsePath: safePath(responsePath),
        rpcId: rpcId || null,
        capturedAt: new Date().toISOString()
      });
      while (geminiPayloadCache.length > 160) geminiPayloadCache.shift();
    }
    window.postMessage({
      source: SOURCE,
      type: "gemini-structure",
      report: { ...report, platform, transport: String(transport || "unknown"), rpcId: rpcId || null },
      payload: storedPayload,
      contentType: String(contentType || ""),
      responsePath: safePath(responsePath),
      rpcId: rpcId || null
    }, "*");
    publishStatus();
  }

  function observePayload(payload, transport, contentType, responsePath, rpcId, topLevelShape) {
    diagnostics.jsonCandidates += 1;
    diagnostics.lastDetectedKeys = safeKeys(payload);
    diagnostics.lastContentType = String(contentType || "");
    if (responsePath) diagnostics.lastResponsePath = responsePath;
    if (platform === "gemini") {
      postGeminiStructure(payload, transport, contentType, responsePath, rpcId, topLevelShape);
      return;
    }
    const payloadSchema = schema(payload);
    if (payloadSchema.schemaType !== "none") {
      diagnostics.lastSchema = payloadSchema;
      diagnostics.lastCandidatePath = payloadSchema.candidatePath || "";
    }
    const endpointId = endpointConversationId(responsePath);
    const messageEndpoint = endpointKind(responsePath) === "conversation-messages";
    if (endpointId) {
      diagnostics.conversationEndpointObserved += 1;
      if (endpointId === currentPageConversationId()) {
        diagnostics.currentConversationEndpointResponses += 1;
        diagnostics.lastEndpointKeys = safeKeys(payload);
        diagnostics.lastEndpointSchema = { ...payloadSchema };
        if (messageEndpoint) {
          diagnostics.messagePageResponses += 1;
          diagnostics.lastMessagePageKeys = safeKeys(payload);
          recordMessagePageFlags(payload);
        }
      }
    }
    publishStatus();
    if (isMessagePage(payload, responsePath)) {
      postMessagePage(payload, transport, responsePath, endpointId || currentPageConversationId());
    }
    if (isConversation(payload)) post(payload, transport, true);
  }

  function observeJsonText(text, transport, contentType, responsePath) {
    try {
      observePayload(JSON.parse(text), transport, contentType, responsePath);
    } catch (_) {
      diagnostics.jsonParseErrors += 1;
      publishStatus();
    }
  }

  function observeStructuredText(text, transport, contentType, responsePath) {
    if (platform !== "gemini" || !geminiAdapter || typeof geminiAdapter.parseStructuredTextReport !== "function") {
      observeJsonText(text, transport, contentType, responsePath);
      return;
    }
    const report = geminiAdapter.parseStructuredTextReport(text);
    diagnostics.batchResponses += isGeminiBatchPath(responsePath) || report.recognizedEnvelope || report.lengthPrefixed ? 1 : 0;
    diagnostics.batchFrames += Number(report.frameCount) || 0;
    diagnostics.batchInnerPayloads += Number(report.innerPayloads) || 0;
    diagnostics.batchParseFailures += Number(report.parseFailures) || 0;
    if (Array.isArray(report.rpcIds)) diagnostics.batchRpcIds = Array.from(new Set(diagnostics.batchRpcIds.concat(report.rpcIds))).slice(-40);
    const records = Array.isArray(report.payloadRecords) ? report.payloadRecords : [];
    records.forEach((record) => postGeminiStructure(record.payload, transport, contentType, responsePath, record.rpcId, report.topLevelShape));
    if (!records.length) {
      diagnostics.jsonParseErrors += 1;
      publishStatus();
    }
  }

  function observeStreamText(text, transport, contentType, responsePath) {
    const raw = String(text || "");
    if (platform === "gemini") {
      let frameCount = 0;
      for (const line of raw.split(/\r?\n/)) {
        const match = /^data:\s*(.+)$/.exec(line);
        if (!match || match[1] === "[DONE]") continue;
        frameCount += 1;
        observeStructuredText(match[1], transport, contentType, responsePath);
      }
      if (!frameCount) observeStructuredText(raw, transport, contentType, responsePath);
      return;
    }
    for (const line of raw.split(/\r?\n/)) {
      const match = /^data:\s*(.+)$/.exec(line);
      if (!match || match[1] === "[DONE]") continue;
      observeJsonText(match[1], transport, contentType, responsePath);
    }
  }

  function isJsonResponse(response) {
    const contentType = response && response.headers && response.headers.get("content-type");
    return typeof contentType === "string" && (contentType.includes("application/json") || contentType.includes("+json"));
  }

  function isJsonContentType(contentType) {
    return typeof contentType === "string" && (contentType.includes("application/json") || contentType.includes("+json"));
  }

  function isStreamContentType(contentType) {
    return typeof contentType === "string" && (contentType.includes("text/event-stream") || contentType.includes("ndjson"));
  }

  function isInspectableGeminiResponse(contentType, responsePath) {
    if (isGeminiBatchPath(responsePath) || !contentType) return true;
    return isJsonContentType(contentType) || /^text\//i.test(String(contentType));
  }

  if (typeof window.fetch === "function") {
    originalFetch = window.fetch;
    diagnostics.fetchHooked = true;
    window.fetch = function () {
      captureAuthHeader(arguments[0], arguments[1]);
      diagnostics.fetchObserved += 1;
      publishStatus();
      return originalFetch.apply(this, arguments).then(function (response) {
        try {
          const contentType = response.headers && response.headers.get("content-type");
          const responsePath = rememberPath(response.url);
          diagnostics.lastContentType = String(contentType || "");
          if (platform === "gemini" && !isStreamContentType(contentType) && isInspectableGeminiResponse(contentType, responsePath)) {
            response.clone().text().then((text) => observeStructuredText(text, "fetch", contentType, responsePath)).catch(() => {
              diagnostics.jsonParseErrors += 1;
              publishStatus();
            });
          } else if (isJsonContentType(contentType) || !contentType) {
            response.clone().json().then((payload) => observePayload(payload, "fetch", contentType, responsePath)).catch(() => {
              diagnostics.jsonParseErrors += 1;
              publishStatus();
            });
          } else if (isStreamContentType(contentType)) {
            diagnostics.streamResponses += 1;
            publishStatus();
            response.clone().text().then((text) => observeStreamText(text, "fetch-stream", contentType, responsePath)).catch(() => {});
          }
        } catch (_) {
          // Observation must never alter the site's request result.
        }
        return response;
      }, function (error) {
        diagnostics.jsonParseErrors += 1;
        publishStatus();
        throw error;
      });
    };
  }

  if (window.XMLHttpRequest && window.XMLHttpRequest.prototype) {
    const prototype = window.XMLHttpRequest.prototype;
    const originalOpen = prototype.open;
    const originalSend = prototype.send;
    diagnostics.xhrHooked = true;
    prototype.open = function (method, url) {
      this.__CCE_REQUEST_URL__ = url;
      return originalOpen.apply(this, arguments);
    };
    prototype.send = function () {
      diagnostics.xhrObserved += 1;
      publishStatus();
      this.addEventListener("load", function () {
        try {
          if (this.status < 200 || this.status >= 300) return;
          const contentType = this.getResponseHeader("content-type") || "";
          const responsePath = rememberPath(this.responseURL || this.__CCE_REQUEST_URL__);
          diagnostics.lastContentType = String(contentType);
          if (platform === "gemini" && !isStreamContentType(contentType) && isInspectableGeminiResponse(contentType, responsePath)) {
            const responseText = this.responseType === "json" ? JSON.stringify(this.response) : this.responseText;
            observeStructuredText(responseText, "xhr", contentType, responsePath);
          } else if (this.responseType === "json") {
            observePayload(this.response, "xhr", contentType, responsePath);
          } else if (isStreamContentType(contentType)) {
            diagnostics.streamResponses += 1;
            observeStreamText(this.responseText, "xhr-stream", contentType, responsePath);
          } else if (isJsonContentType(contentType) || !contentType) {
            observeJsonText(this.responseText, "xhr", contentType, responsePath);
          }
        } catch (_) {
          diagnostics.jsonParseErrors += 1;
          publishStatus();
        }
      });
      return originalSend.apply(this, arguments);
    };
  }

  function observeWebSocketData(data) {
    diagnostics.webSocketMessages += 1;
    const responsePath = "(WebSocket)";
    if (typeof data === "string") {
      if (platform === "gemini") {
        observeStructuredText(data, "websocket", "", responsePath);
        return;
      }
      try {
        observePayload(JSON.parse(data), "websocket", "", responsePath);
      } catch (_) {
        observeStreamText(data, "websocket-stream", "", responsePath);
      }
      publishStatus();
      return;
    }
    if (data && typeof data.text === "function") {
      data.text().then((text) => observeWebSocketData(text)).catch(() => {});
      return;
    }
    if (data instanceof ArrayBuffer && typeof TextDecoder === "function") {
      observeWebSocketData(new TextDecoder().decode(data));
    }
  }

  if (typeof window.WebSocket === "function") {
    const OriginalWebSocket = window.WebSocket;
    diagnostics.webSocketHooked = true;
    const observeSocket = (socket) => {
      diagnostics.webSocketObserved += 1;
      socket.addEventListener("message", (event) => observeWebSocketData(event.data));
      publishStatus();
      return socket;
    };
    window.WebSocket = new Proxy(OriginalWebSocket, {
      construct(target, args, newTarget) {
        return observeSocket(Reflect.construct(target, args, newTarget));
      },
      apply(target, thisArg, args) {
        return observeSocket(Reflect.apply(target, thisArg, args));
      }
    });
  }

  function fallbackConfig() {
    const config = globalThis.CCEFallbackConfig;
    const valid = config && config.enabled && typeof config.buildPaths === "function";
    diagnostics.fallbackConfigured = Boolean(valid);
    return valid ? config : null;
  }

  function attemptVerifiedFallback() {
    if (platform !== "chatgpt") {
      diagnostics.fallbackSkipReason = "platform-not-configured";
      publishStatus();
      return;
    }
    const config = fallbackConfig();
    const conversationId = currentPageConversationId();
    if (!config) {
      diagnostics.fallbackSkipReason = "config-not-loaded";
      publishStatus();
      return;
    }
    if (!conversationId) {
      diagnostics.fallbackSkipReason = "current-id-not-found-in-page-world";
      publishStatus();
      return;
    }
    if (typeof originalFetch !== "function") {
      diagnostics.fallbackSkipReason = "original-fetch-not-available";
      publishStatus();
      return;
    }
    const endpoints = config.buildPaths(conversationId);
    if (!Array.isArray(endpoints) || endpoints.length === 0) {
      diagnostics.fallbackSkipReason = "no-configured-endpoints";
      publishStatus();
      return;
    }

    diagnostics.fallbackAttempts += 1;
    diagnostics.fallbackSkipReason = "";
    diagnostics.fallbackLastResult = "requested";
    publishStatus();

    function requestEndpoint(index) {
      const endpoint = endpoints[index];
      if (!endpoint || !endpoint.path) {
        diagnostics.fallbackLastResult = "json-without-mapping";
        publishStatus();
        return;
      }
      diagnostics.fallbackLastEndpoint = String(endpoint.name || "configured-endpoint");
      const requestUrl = new URL(endpoint.path, window.location.origin).toString();
      originalFetch.call(window, requestUrl, {
        method: config.method || "GET",
        credentials: "include",
        headers: { Accept: "application/json" }
      }).then((response) => {
        const responsePath = rememberPath(response.url || requestUrl);
        if (!response.ok) {
          if (index + 1 < endpoints.length) return requestEndpoint(index + 1);
          diagnostics.fallbackLastResult = `http-${response.status}`;
          publishStatus();
          return null;
        }
        return response.clone().text().then((text) => {
          let payload;
          try {
            payload = JSON.parse(text);
          } catch (_) {
            if (index + 1 < endpoints.length) return requestEndpoint(index + 1);
            diagnostics.fallbackLastResult = "response-not-json";
            diagnostics.jsonParseErrors += 1;
            publishStatus();
            return null;
          }
          diagnostics.fallbackResponses += 1;
          observePayload(payload, "verified-fallback", "application/json", responsePath);
          if (isConversation(payload)) {
            diagnostics.fallbackConversationCandidates += 1;
            diagnostics.fallbackLastResult = "conversation-candidate";
            publishStatus();
            return null;
          }
          if (index + 1 < endpoints.length) return requestEndpoint(index + 1);
          diagnostics.fallbackLastResult = "json-without-mapping";
          publishStatus();
          return null;
        });
      }).catch(() => {
        if (index + 1 < endpoints.length) return requestEndpoint(index + 1);
        diagnostics.fallbackLastResult = "request-failed";
        publishStatus();
        return null;
      });
    }

    requestEndpoint(0);
  }

  let latestAuthToken = "";

  function captureAuthHeader(input, init) {
    try {
      let auth = "";
      if (init && init.headers) {
        if (typeof init.headers.get === "function") auth = init.headers.get("authorization") || init.headers.get("Authorization");
        else if (typeof init.headers === "object") auth = init.headers.authorization || init.headers.Authorization;
      }
      if (!auth && input && typeof input === "object" && input.headers && typeof input.headers.get === "function") {
        auth = input.headers.get("authorization") || input.headers.get("Authorization");
      }
      if (typeof auth === "string" && auth.trim().toLowerCase().startsWith("bearer ")) {
        latestAuthToken = auth.trim();
      }
    } catch (_) {}
  }

  /*
   * Virtualizer bridge page scanner (Ported from GPT-Conversation-Toolkit under MIT License)
   */
  const REACT_PROPERTY_PREFIXES = [
    "__reactFiber$",
    "__reactProps$",
    "__reactContainer$",
    "__reactInternalInstance$",
  ];

  const PRIORITY_FIELDS = [
    "stateNode",
    "memoizedProps",
    "memoizedState",
    "ref",
    "updateQueue",
    "return",
    "child",
    "sibling",
    "alternate",
    "dependencies",
  ];

  const VIRTUALIZER_HINTS = [
    "scrollToIndex",
    "scrollToItem",
    "scrollToOffset",
    "getVirtualItems",
    "getTotalSize",
    "measureElement",
    "followOutput",
    "rangeChanged",
    "firstItemIndex",
    "atBottom",
  ];

  const VIRTUALIZER_START_SELECTOR = [
    "#thread",
    "main",
    "[data-scroll-root]",
    "section[data-turn]",
    '[data-testid^="conversation-turn-"]',
  ].join(", ");

  let cachedVirtualizerApi = null;
  let cachedVirtualizerAt = 0;
  const VIRTUALIZER_CACHE_TTL_MS = 5000;
  const MAX_SCAN_OBJECTS = 4200;
  const MAX_SCAN_DEPTH = 8;
  const MAX_GENERIC_KEYS_PER_OBJECT = 90;

  function isObjectLike(value) {
    return (typeof value === "object" || typeof value === "function") && value !== null;
  }

  function safeGet(object, key) {
    try {
      return object?.[key];
    } catch (_) {
      return undefined;
    }
  }

  function hasOwnFunction(object, key) {
    return typeof safeGet(object, key) === "function";
  }

  function hasVirtualizerHint(object) {
    return VIRTUALIZER_HINTS.some((key) => {
      const value = safeGet(object, key);
      return typeof value === "function" || typeof value === "boolean" || Number.isFinite(value);
    });
  }

  function getPreferredMethod(object) {
    if (hasOwnFunction(object, "scrollToIndex")) return "scrollToIndex";
    if (hasOwnFunction(object, "scrollToItem")) return "scrollToItem";
    if (hasOwnFunction(object, "scrollToOffset")) return "scrollToOffset";
    return "";
  }

  function getVirtualizerScore(object) {
    const method = getPreferredMethod(object);
    if (!method) return 0;
    const methodScore = method === "scrollToIndex" ? 300 : method === "scrollToItem" ? 200 : 100;
    const hintScore = VIRTUALIZER_HINTS.reduce((score, key) => {
      const value = safeGet(object, key);
      return score + (typeof value === "function" || value !== undefined ? 1 : 0);
    }, 0);
    return methodScore + hintScore;
  }

  function getOwnKeys(object) {
    try {
      return [...Object.getOwnPropertyNames(object), ...Object.getOwnPropertySymbols(object)];
    } catch (_) {
      return [];
    }
  }

  function isReactPropertyKey(key) {
    return typeof key === "string" && REACT_PROPERTY_PREFIXES.some((prefix) => key.startsWith(prefix));
  }

  function getReactObjectsFromElement(element) {
    if (!(element instanceof Element)) return [];
    return getOwnKeys(element)
      .filter(isReactPropertyKey)
      .map((key) => safeGet(element, key))
      .filter(isObjectLike);
  }

  function collectStartObjects() {
    const starts = [];
    const seenElements = new Set();
    const addElement = (element) => {
      if (!(element instanceof Element) || seenElements.has(element)) return;
      seenElements.add(element);
      getReactObjectsFromElement(element).forEach((value) => starts.push(value));
    };

    if (typeof document !== "undefined" && document.querySelectorAll) {
      document.querySelectorAll(VIRTUALIZER_START_SELECTOR).forEach((element) => {
        addElement(element);
        let parent = element.parentElement;
        let depth = 0;
        while (parent instanceof Element && depth < 4) {
          addElement(parent);
          parent = parent.parentElement;
          depth += 1;
        }
      });
      if (document.documentElement) addElement(document.documentElement);
      if (document.body) addElement(document.body);
    }
    return starts;
  }

  function shouldSkipGenericKey(key) {
    const text = typeof key === "symbol" ? key.description || "" : String(key);
    return (
      text === "__proto__" ||
      text === "constructor" ||
      text === "prototype" ||
      text === "ownerDocument" ||
      text === "parentNode" ||
      text === "children" ||
      text === "childNodes" ||
      text === "firstChild" ||
      text === "lastChild" ||
      text === "nextSibling" ||
      text === "previousSibling" ||
      text === "style" ||
      text === "classList"
    );
  }

  function isRelevantKey(key) {
    const text = (typeof key === "symbol" ? key.description || "" : String(key)).toLowerCase();
    return (
      text.includes("virtual") ||
      text.includes("scroll") ||
      text.includes("list") ||
      text.includes("range") ||
      text.includes("index") ||
      text.includes("item") ||
      text.includes("ref") ||
      text.includes("state") ||
      text.includes("props")
    );
  }

  function enqueueScanObject(queue, value, depth) {
    if (isObjectLike(value) && depth <= MAX_SCAN_DEPTH) {
      queue.push({ value, depth });
    }
  }

  function scanObjectGraph(starts) {
    const seen = new WeakSet();
    const queue = [];
    let best = null;
    let bestScore = 0;
    let scanned = 0;

    starts.forEach((value) => enqueueScanObject(queue, value, 0));

    while (queue.length > 0 && scanned < MAX_SCAN_OBJECTS) {
      const { value, depth } = queue.shift();
      if (!isObjectLike(value) || seen.has(value)) continue;
      seen.add(value);
      scanned += 1;

      const score = getVirtualizerScore(value);
      if (score > bestScore) {
        bestScore = score;
        best = {
          api: value,
          method: getPreferredMethod(value),
          score,
        };
        if (best.method === "scrollToIndex" && score >= 305) {
          break;
        }
      }

      if (depth >= MAX_SCAN_DEPTH) continue;

      PRIORITY_FIELDS.forEach((key) => {
        const child = safeGet(value, key);
        enqueueScanObject(queue, child, depth + 1);
        if (key === "ref") {
          enqueueScanObject(queue, safeGet(child, "current"), depth + 1);
        }
      });

      const keys = getOwnKeys(value).slice(0, MAX_GENERIC_KEYS_PER_OBJECT);
      keys.forEach((key) => {
        if (shouldSkipGenericKey(key)) return;
        const child = safeGet(value, key);
        if (!isObjectLike(child)) return;
        if (depth <= 2 || isRelevantKey(key) || hasVirtualizerHint(child)) {
          enqueueScanObject(queue, child, depth + 1);
        }
      });
    }

    return best;
  }

  function clearCachedVirtualizerApi() {
    cachedVirtualizerApi = null;
    cachedVirtualizerAt = 0;
  }

  function findVirtualizerApi() {
    const now = Date.now();
    if (cachedVirtualizerApi && now - cachedVirtualizerAt < VIRTUALIZER_CACHE_TTL_MS) {
      return cachedVirtualizerApi;
    }
    const starts = collectStartObjects();
    const found = scanObjectGraph(starts);
    cachedVirtualizerApi = found || null;
    cachedVirtualizerAt = found ? now : 0;
    return cachedVirtualizerApi;
  }

  async function tryCall(callback) {
    const result = callback();
    if (result && typeof result.then === "function") {
      await result;
    }
  }

  async function callScrollToIndex(api, index, options) {
    const method = safeGet(api, "scrollToIndex");
    const attempts = [
      () => method.call(api, { index, ...options }),
      () => method.call(api, index, options),
      () => method.call(api, index)
    ];
    let lastError = null;
    for (const attempt of attempts) {
      try {
        await tryCall(attempt);
        return { ok: true, method: "scrollToIndex", attemptedIndex: index };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("scrollToIndex_failed");
  }

  async function callScrollToItem(api, index) {
    const method = safeGet(api, "scrollToItem");
    const attempts = [
      () => method.call(api, index, "center"),
      () => method.call(api, index)
    ];
    let lastError = null;
    for (const attempt of attempts) {
      try {
        await tryCall(attempt);
        return { ok: true, method: "scrollToItem", attemptedIndex: index };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("scrollToItem_failed");
  }

  async function callScrollToOffset(api, offset) {
    const method = safeGet(api, "scrollToOffset");
    await tryCall(() => method.call(api, offset));
    return { ok: true, method: "scrollToOffset", attemptedIndex: null };
  }

  async function callVirtualizerApi(apiInfo, index, options) {
    const api = apiInfo && apiInfo.api;
    if (!api) return { ok: false, reason: "virtualizer_api_not_found" };
    if (hasOwnFunction(api, "scrollToIndex")) {
      return await callScrollToIndex(api, index, options);
    }
    if (hasOwnFunction(api, "scrollToItem")) {
      return await callScrollToItem(api, index);
    }
    if (hasOwnFunction(api, "scrollToOffset") && Number.isFinite(options.offset)) {
      return await callScrollToOffset(api, options.offset);
    }
    return { ok: false, reason: "virtualizer_api_not_found" };
  }

  async function fetchConversationMessagesPage(conversationId, cursor) {
    const encodedId = encodeURIComponent(conversationId);
    const path = cursor
      ? `/backend-api/conversations/${encodedId}/messages?before=${encodeURIComponent(cursor)}&include_has_versions=true&num_turns=25`
      : `/backend-api/conversations/${encodedId}/messages?include_has_versions=true&num_turns=25`;
    const url = new URL(path, window.location.origin).toString();
    const headers = { Accept: "application/json" };
    if (latestAuthToken) {
      headers.Authorization = latestAuthToken;
    } else {
      try {
        const sessionRes = await (originalFetch || window.fetch).call(window, "/api/auth/session", {
          credentials: "include",
          headers: { Accept: "application/json" }
        });
        if (sessionRes && sessionRes.ok) {
          const session = await sessionRes.json();
          const token = session && (session.accessToken || session.access_token);
          if (typeof token === "string" && token) {
            latestAuthToken = `Bearer ${token}`;
            headers.Authorization = latestAuthToken;
          }
        }
      } catch (_) {}
    }

    const response = await (originalFetch || window.fetch).call(window, url, {
      method: "GET",
      credentials: "include",
      headers
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window || !event.data || event.data.source !== SOURCE) return;
    const type = event.data.type;

    if (type === "rescan") {
      publishStatus();
      for (const key of cacheOrder) {
        if (cache.has(key)) post(cache.get(key), "cache-rescan", false);
      }
      for (const page of pageCache) {
        if (page.conversationId === currentPageConversationId()) {
          window.postMessage({
            source: SOURCE,
            type: "conversation-message-page",
            conversationId: page.conversationId,
            pageKey: page.key,
            payload: page.payload,
            transport: "cache-rescan",
            responsePath: "(cache)"
          }, "*");
        }
      }
      if (platform === "gemini") {
        const currentId = currentPageConversationId();
        for (const record of geminiPayloadCache) {
          if (record.conversationId && currentId && record.conversationId !== currentId) continue;
          postGeminiStructure(record.payload, "cache-rescan", record.contentType, record.responsePath, record.rpcId, record.report && record.report.topLevelShape);
        }
        publishStatus();
        return;
      }
      const currentId = currentPageConversationId();
      if (currentId && cache.has(currentId)) {
        diagnostics.fallbackSkipReason = "captured-cache";
        diagnostics.fallbackLastResult = "";
        publishStatus();
        return;
      }
      // A rescan is an explicit request to refresh the current conversation.
      // If the page response was already captured, prefer that original payload;
      // otherwise try the verified adapter.
      attemptVerifiedFallback();
      return;
    }

    if (type === "navigator-virtualizer-scroll") {
      const requestId = event.data.requestId || "";
      const rawCandidates = Array.isArray(event.data.candidates) ? event.data.candidates : [event.data.index];
      const candidates = [];
      rawCandidates.forEach((c) => {
        const num = Number(c);
        if (Number.isFinite(num) && num >= 0 && !candidates.includes(Math.trunc(num))) {
          candidates.push(Math.trunc(num));
        }
      });

      if (!requestId || candidates.length === 0) {
        window.postMessage({ source: SOURCE, type: "navigator-virtualizer-scroll-result", requestId, ok: false, reason: "invalid_index" }, "*");
        return;
      }

      let apiInfo = findVirtualizerApi();
      if (!apiInfo) {
        window.postMessage({ source: SOURCE, type: "navigator-virtualizer-scroll-result", requestId, ok: false, reason: "virtualizer_api_not_found" }, "*");
        return;
      }

      const options = { align: event.data.options?.align || "center", behavior: "auto" };
      let lastReason = "";
      for (const index of candidates) {
        try {
          const result = await callVirtualizerApi(apiInfo, index, options);
          if (result && result.ok) {
            window.postMessage({
              source: SOURCE,
              type: "navigator-virtualizer-scroll-result",
              requestId,
              ok: true,
              method: result.method || "",
              attemptedIndex: result.attemptedIndex,
              reason: ""
            }, "*");
            return;
          }
          lastReason = result ? result.reason : "call_failed";
        } catch (err) {
          lastReason = err && err.message ? err.message : "call_failed";
          clearCachedVirtualizerApi();
          apiInfo = findVirtualizerApi();
          if (!apiInfo) break;
        }
      }

      window.postMessage({ source: SOURCE, type: "navigator-virtualizer-scroll-result", requestId, ok: false, reason: lastReason || "virtualizer_scroll_failed" }, "*");
      return;
    }

    if (type === "navigator-fetch-messages-page") {
      const requestId = event.data.requestId || "";
      const conversationId = event.data.conversationId || "";
      const cursor = event.data.cursor || "";
      if (!requestId || !conversationId) {
        window.postMessage({ source: SOURCE, type: "navigator-fetch-messages-page-result", requestId, ok: false, error: "missing_parameters" }, "*");
        return;
      }
      try {
        const payload = await fetchConversationMessagesPage(conversationId, cursor);
        window.postMessage({ source: SOURCE, type: "navigator-fetch-messages-page-result", requestId, ok: true, payload }, "*");
      } catch (err) {
        window.postMessage({ source: SOURCE, type: "navigator-fetch-messages-page-result", requestId, ok: false, error: err && err.message ? err.message : String(err) }, "*");
      }
      return;
    }
  });

  publishStatus();
})();
