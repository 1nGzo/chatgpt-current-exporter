/* Page-world request observer. It returns every original request result intact. */
(function () {
  "use strict";
  if (window.__CCE_REQUEST_OBSERVER__) return;
  window.__CCE_REQUEST_OBSERVER__ = true;
  const SOURCE = "chatgpt-current-exporter";
  const diagnostics = {
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
    lastSchema: { mapping: false, messages: false, currentNode: false, title: false, conversationId: null, schemaType: "none" },
    lastContentType: "",
    lastResponsePath: "",
    observedResponsePaths: [],
    cacheSize: 0
  };
  const cache = new Map();
  const cacheOrder = [];
  const pageCache = [];
  let originalFetch = null;

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

  function observePayload(payload, transport, contentType, responsePath) {
    diagnostics.jsonCandidates += 1;
    diagnostics.lastDetectedKeys = safeKeys(payload);
    diagnostics.lastContentType = String(contentType || "");
    if (responsePath) diagnostics.lastResponsePath = responsePath;
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

  function observeStreamText(text, transport, contentType, responsePath) {
    for (const line of String(text || "").split(/\r?\n/)) {
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

  if (typeof window.fetch === "function") {
    originalFetch = window.fetch;
    diagnostics.fetchHooked = true;
    window.fetch = function () {
      diagnostics.fetchObserved += 1;
      publishStatus();
      return originalFetch.apply(this, arguments).then(function (response) {
        try {
          const contentType = response.headers && response.headers.get("content-type");
          const responsePath = rememberPath(response.url);
          diagnostics.lastContentType = String(contentType || "");
          if (isJsonContentType(contentType) || !contentType) {
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
          if (this.responseType === "json") {
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

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.source !== SOURCE || event.data.type !== "rescan") return;
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
  });

  publishStatus();
})();
