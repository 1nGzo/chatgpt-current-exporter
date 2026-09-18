/* Grok's private web API is best-effort; never combine it with a partial DOM. */
(function (root) {
  "use strict";
  const domSelectors = ['[data-testid="user-message"]', '[data-testid="assistant-message"]',
    '[data-message-author-role="user"]', '[data-message-author-role="assistant"]'];
  const messageSelector = domSelectors.join(", ");
  function conversationId(url) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !["grok.com", "www.grok.com"].includes(parsed.hostname)) return null;
    const match = parsed.pathname.match(/^\/(?:c|chat|conversation)\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }
  function normalize(metadata, messages, url, pageTitle, source) {
    return { platform: "grok", conversationId: conversationId(url),
      title: [metadata.title, pageTitle, messages.find(m => m.role === "user")?.text, "Untitled Conversation"].find(value => typeof value === "string" && value.trim()).trim(),
      sourceUrl: url, capturedAt: new Date().toISOString(), messages,
      metadata: { source, createTime: metadata.createTime, model: metadata.modelName || metadata.model,
        warning: source === "dom" ? "DOM fallback：仅当前已加载内容；长会话可能不完整" : "" } };
  }
  function parseApi(detail, nodes, payload, url, pageTitle) {
    const meta = detail.conversation || detail;
    const id = conversationId(url);
    if ((meta.conversationId || meta.id) && (meta.conversationId || meta.id) !== id) throw Error("Conversation ID mismatch");
    if (!Array.isArray(nodes.responseNodes) || !Array.isArray(payload.responses)) throw Error("Unknown Grok schema");
    if (nodes.hasMore || nodes.nextPageToken || payload.hasMore || payload.nextPageToken) throw Error("Incomplete API pagination");
    const ids = [...new Set(nodes.responseNodes.map(n => n.responseId))];
    if (!ids.length || ids.some(id => typeof id !== "string" || !id)) throw Error("Invalid response IDs");
    const records = new Map(payload.responses.map(r => [r.responseId, r]));
    const messages = [];
    for (const id of ids) {
      const record = records.get(id);
      if (!record) throw Error("Missing response body");
      const sender = String(record.sender || record.role || "").toLowerCase();
      const role = ["human", "user"].includes(sender) ? "user" : ["assistant", "bot", "grok"].includes(sender) ? "assistant" : null;
      if (!role) continue;
      if (typeof record.message !== "string" || !record.message.trim()) throw Error("Missing visible message");
      // Preserve unknown XML and literal code. Only known UI wrapper tags are removed.
      const text = record.message.split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((part, i) => i % 2 ? part : part.replace(/<\/?(?:grok:render|grok:card)\b[^>]*>/g, "")).join("");
      messages.push({ sequence: messages.length, role, text, timestamp: record.createTime || null, platformMessageId: id, metadata: {} });
    }
    if (!messages.length) throw Error("No visible messages");
    return normalize(meta, messages, url, pageTitle, "api");
  }
  function parseDom(doc, url) {
    const seen = new Set();
    const messages = [];
    for (const element of doc.querySelectorAll(messageSelector)) {
      if (element.parentElement?.closest(messageSelector)) continue;
      if (element.closest('[hidden], [aria-hidden="true"]')) continue;
      // Current Grok marks system-origin bubbles with data-origin as well.
      if (element.hasAttribute("data-origin")) continue;
      const id = element.getAttribute("data-message-id") || element.id || element.closest('[data-scroll-anchor-root][id]')?.id || null;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      const text = root.CCEConversationConverter.domMarkdown(element).trim();
      const role = element.getAttribute("data-testid") === "user-message" ? "user"
        : element.getAttribute("data-testid") === "assistant-message" ? "assistant" : element.getAttribute("data-message-author-role");
      if (text) messages.push({ sequence: messages.length, role, text,
        timestamp: null, platformMessageId: id, metadata: {} });
    }
    if (!messages.length) throw Error("Grok API 不可用，当前 DOM 也没有可识别的会话消息");
    return normalize({}, messages, url, doc.title.trim(), "dom");
  }
  async function capture({ url, document: doc, fetch: fetchFn, currentUrl = () => url }) {
    const id = conversationId(url);
    const diagnostics = { conversationId: id, injected: true, currentUrl: new URL(url).origin + new URL(url).pathname,
      apiRequests: [], domCandidates: [], fallbackReason: "" };
    const guard = () => { if (currentUrl() !== url) throw Error("会话已切换，请重新导出"); };
    const request = async (path, body) => {
      guard();
      const entry = { path, method: body ? "POST" : "GET", credentials: "include", status: null, contentType: "", keys: [] };
      diagnostics.apiRequests.push(entry);
      let response;
      try { response = await fetchFn(new URL(path, url).href, { credentials: "include", signal: AbortSignal.timeout(15000),
        method: body ? "POST" : "GET", headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      } catch (_) { entry.error = "Network error or timeout"; throw Error(`${entry.method} ${path}: ${entry.error}`); }
      entry.status = response.status;
      entry.contentType = response.headers?.get("content-type") || "";
      guard();
      let payload;
      try {
        payload = await response.json();
        entry.keys = payload && typeof payload === "object" ? Object.keys(payload).slice(0, 30) : [];
      } catch (_) { entry.error = "Non-JSON response"; }
      if (!response.ok) throw Error(`${entry.method} ${path}: HTTP ${response.status}`);
      if (entry.error) throw Error(`${entry.method} ${path}: ${entry.error}`);
      return payload;
    };
    let result;
    let apiTitle = "";
    try {
      if (!id) throw Error("No conversation ID");
      const encoded = encodeURIComponent(id);
      // A title/metadata outage must not prevent fetching the transcript.
      let detail = {};
      try { detail = await request(`/rest/app-chat/conversations_v2/${encoded}`); }
      catch (_) { guard(); }
      if (!detail || typeof detail !== "object") detail = {};
      const meta = detail.conversation || detail;
      if ((meta.conversationId || meta.id) === id && typeof meta.title === "string") apiTitle = meta.title.trim();
      const nodes = await request(`/rest/app-chat/conversations/${encoded}/response-node`);
      if (!Array.isArray(nodes.responseNodes)) throw Error("Unknown response-node schema");
      const responseIds = [...new Set(nodes.responseNodes.map(n => n.responseId))];
      if (!responseIds.length || responseIds.some(id => typeof id !== "string" || !id)) throw Error("Invalid response IDs");
      const payload = await request(`/rest/app-chat/conversations/${encoded}/load-responses`, { responseIds });
      result = parseApi(detail, nodes, payload, url, doc.title.trim());
    } catch (error) {
      guard();
      diagnostics.fallbackReason = error.message;
      diagnostics.domCandidates = domSelectors.map(selector => ({ selector, count: doc.querySelectorAll(selector).length }));
      diagnostics.iframeCount = doc.querySelectorAll("iframe").length;
      try { result = parseDom(doc, url); }
      catch (domError) { domError.diagnostics = diagnostics; throw domError; }
      if (apiTitle) result.title = apiTitle;
    }
    guard();
    result.metadata.diagnostics = diagnostics;
    return result;
  }
  root.CCEGrokAdapter = Object.freeze({ conversationId, parseApi, parseDom, capture });
})(globalThis);
