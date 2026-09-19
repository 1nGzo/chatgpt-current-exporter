/*
 * ChatGPT History Navigator Backend Adapter
 *
 * Implements cursor pagination, active-path prompt indexing,
 * and 4-stage virtualized message jump.
 *
 * Portions adapted from GPT-Conversation-Toolkit under MIT License:
 * Copyright (c) 2024-2026 GPT-Conversation-Toolkit contributors
 */
(function (root) {
  "use strict";

  const SOURCE = "chatgpt-current-exporter";
  const VIRTUALIZER_REQUEST_TYPE = "navigator-virtualizer-scroll";
  const VIRTUALIZER_RESULT_TYPE = "navigator-virtualizer-scroll-result";
  const FETCH_PAGE_REQUEST_TYPE = "navigator-fetch-messages-page";
  const FETCH_PAGE_RESULT_TYPE = "navigator-fetch-messages-page-result";
  const BRIDGE_TIMEOUT_MS = 1500;
  const VIRTUAL_JUMP_MAX_ATTEMPTS = 12;
  const TEXT_NEEDLE_LIMIT = 120;
  const TEXT_MATCH_THRESHOLD = 0.72;

  // --- Helper Utilities ---

  function normalizeText(value) {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  }

  function truncatePreview(value, maxLength = 140) {
    const text = normalizeText(value);
    return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
  }

  function getTextMatchScore(leftValue, rightValue) {
    const left = normalizeText(leftValue).toLowerCase().slice(0, TEXT_NEEDLE_LIMIT);
    const right = normalizeText(rightValue).toLowerCase().slice(0, TEXT_NEEDLE_LIMIT);
    if (!left || !right) return 0;
    if (left === right) return 1.0;
    if (left.includes(right) || right.includes(left)) {
      const minLen = Math.min(left.length, right.length);
      const maxLen = Math.max(left.length, right.length);
      return Math.max(0.75, minLen / maxLen);
    }
    // Simple bigram Jaccard similarity for resilient matching
    if (left.length < 4 || right.length < 4) return 0;
    const getBigrams = (str) => {
      const set = new Set();
      for (let i = 0; i < str.length - 1; i++) set.add(str.slice(i, i + 2));
      return set;
    };
    const b1 = getBigrams(left);
    const b2 = getBigrams(right);
    let intersection = 0;
    b1.forEach((bg) => {
      if (b2.has(bg)) intersection++;
    });
    const union = b1.size + b2.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  function extractNodeText(element) {
    if (!element || !(element instanceof (root.HTMLElement || Object))) return "";
    const clone = element.cloneNode(true);
    if (clone.querySelectorAll) {
      clone.querySelectorAll("button, script, style, textarea, input, select, .sr-only, [aria-hidden='true']").forEach((child) => child.remove());
    }
    return (clone.textContent || "").trim();
  }

  function getDomMessageId(element) {
    if (!element || !element.getAttribute) return "";
    return (
      element.getAttribute("data-message-id") ||
      (element.querySelector && element.querySelector("[data-message-id]")?.getAttribute("data-message-id")) ||
      element.getAttribute("data-turn-id") ||
      (element.querySelector && element.querySelector("[data-turn-id]")?.getAttribute("data-turn-id")) ||
      ""
    );
  }

  // --- Scroll Container Detection ---

  function resolveScrollContainer(doc = root.document) {
    if (!doc) return null;
    const main =
      doc.querySelector("#thread") ||
      doc.querySelector("main#main") ||
      doc.querySelector("[data-scroll-root] main") ||
      doc.querySelector("main") ||
      doc.querySelector('[role="main"]');

    if (main instanceof (root.HTMLElement || Object)) {
      const mainRoot = main.closest && main.closest("[data-scroll-root]");
      if (mainRoot instanceof (root.HTMLElement || Object)) return mainRoot;

      let current = main.parentElement;
      while (current instanceof (root.HTMLElement || Object) && current !== doc.body) {
        if (root.getComputedStyle) {
          const style = root.getComputedStyle(current);
          const overflowY = style?.overflowY || "";
          if ((overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") && current.scrollHeight > current.clientHeight + 24) {
            return current;
          }
        }
        current = current.parentElement;
      }
    }

    const explicitRoot = doc.querySelector && doc.querySelector("[data-scroll-root]");
    if (explicitRoot instanceof (root.HTMLElement || Object)) return explicitRoot;

    return doc.scrollingElement || doc.documentElement || null;
  }

  function scrollElementIntoView(element, options = {}) {
    if (!element || typeof element.scrollIntoView !== "function") return;
    const { behavior = "auto", block = "center" } = options;
    const doc = options.document || element.ownerDocument || root.document;
    const container = resolveScrollContainer(doc);
    if (!container || container === doc?.scrollingElement || container === doc?.documentElement) {
      element.scrollIntoView({ behavior, block });
      return;
    }

    try {
      const rootRect = container.getBoundingClientRect();
      const elemRect = element.getBoundingClientRect();
      let top = container.scrollTop + (elemRect.top - rootRect.top);
      if (block === "center") {
        top -= Math.max(0, (container.clientHeight - elemRect.height) / 2);
      } else if (block === "end") {
        top -= Math.max(0, container.clientHeight - elemRect.height);
      }
      const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
      container.scrollTo({ top: Math.min(Math.max(0, top), maxTop), behavior });
      element.scrollIntoView({ behavior, block });
    } catch (_) {
      element.scrollIntoView({ behavior, block });
    }
  }

  // --- Prompt Index Construction ---

  /**
   * Build full prompt index from active path in converter document.
   * Only active-path user messages are indexed.
   */
  function buildPromptIndexFromDocument(document) {
    if (!document || !Array.isArray(document.messages)) return [];
    const allMessages = document.messages;
    const promptItems = [];
    let userOrder = 1;

    allMessages.forEach((message, index) => {
      if (message.role !== "user") return;
      const messageId = message.messageId || `msg-${index}`;
      const previewText = truncatePreview(message.body || "");
      // targetIndex is 1-based index in the active path (among all visible turns)
      const targetIndex = index + 1;

      promptItems.push({
        messageId,
        userOrder: userOrder++,
        previewText,
        targetIndex,
        createTime: message.createTime || null,
        nodeId: message.nodeId || messageId,
        role: "user"
      });
    });

    return promptItems;
  }

  /**
   * Build immediate prompt index from currently mounted DOM nodes.
   */
  function buildLocalPromptIndexFromDom(doc = root.document) {
    if (!doc || !doc.querySelectorAll) return [];
    const main =
      doc.querySelector("#thread") ||
      doc.querySelector("main") ||
      doc.body ||
      doc.documentElement;
    if (!main) return [];

    const candidates = Array.from(
      main.querySelectorAll(
        '[data-message-author-role="user"], [data-testid="user-message"], [data-testid^="user-message"], section[data-turn="user"]'
      )
    );

    const seenNodes = new Set();
    const promptItems = [];
    let userOrder = 1;

    candidates.forEach((candidate) => {
      const rootNode =
        candidate.closest("article") ||
        candidate.closest('[data-testid^="conversation-turn-"]') ||
        candidate.closest("section[data-turn]") ||
        candidate;

      if (seenNodes.has(rootNode)) return;
      seenNodes.add(rootNode);

      const messageId = getDomMessageId(rootNode) || `dom-user-${userOrder}`;
      const fullText = extractNodeText(rootNode);
      const previewText = truncatePreview(fullText);

      // Attempt to extract turn index from testid e.g. conversation-turn-3
      let targetIndex = null;
      const testId = rootNode.getAttribute?.("data-testid") || "";
      const match = testId.match(/conversation-turn-(\d+)/i);
      if (match) {
        targetIndex = Number(match[1]) + 1;
      }
      if (!Number.isFinite(targetIndex)) {
        targetIndex = userOrder * 2 - 1; // sensible estimate for turn position
      }

      promptItems.push({
        messageId,
        userOrder: userOrder++,
        previewText,
        targetIndex,
        node: rootNode,
        isDomNode: true,
        role: "user"
      });
    });

    return promptItems;
  }

  // --- Virtualizer Bridge (ISOLATED World Client) ---

  const bridgePending = new Map();
  let bridgeReqSeq = 0;
  let bridgeListenerBound = false;

  function ensureBridgeListener() {
    if (bridgeListenerBound || typeof root.addEventListener !== "function") return;
    root.addEventListener("message", (event) => {
      if (event.source !== root || !event.data || event.data.source !== SOURCE) return;
      if (event.data.type === VIRTUALIZER_RESULT_TYPE) {
        const req = bridgePending.get(event.data.requestId);
        if (req) {
          clearTimeout(req.timer);
          bridgePending.delete(event.data.requestId);
          req.resolve({
            ok: Boolean(event.data.ok),
            method: event.data.method || "",
            attemptedIndex: event.data.attemptedIndex,
            reason: event.data.reason || ""
          });
        }
      }
    });
    bridgeListenerBound = true;
  }

  function requestVirtualizerScroll(candidates, options = {}) {
    ensureBridgeListener();
    return new Promise((resolve) => {
      const requestId = `vscroll-${++bridgeReqSeq}-${Date.now()}`;
      const timeoutMs = options.timeoutMs || BRIDGE_TIMEOUT_MS;
      const timer = setTimeout(() => {
        bridgePending.delete(requestId);
        resolve({ ok: false, reason: "bridge_timeout" });
      }, timeoutMs);

      bridgePending.set(requestId, { resolve, timer });

      root.postMessage(
        {
          source: SOURCE,
          type: VIRTUALIZER_REQUEST_TYPE,
          requestId,
          candidates,
          options: { align: options.align || "center" }
        },
        "*"
      );
    });
  }

  // --- Message Page Fetcher (via MAIN World Bridge) ---

  const fetchPending = new Map();
  let fetchReqSeq = 0;
  let fetchListenerBound = false;

  function ensureFetchListener() {
    if (fetchListenerBound || typeof root.addEventListener !== "function") return;
    root.addEventListener("message", (event) => {
      if (event.source !== root || !event.data || event.data.source !== SOURCE) return;
      if (event.data.type === FETCH_PAGE_RESULT_TYPE) {
        const req = fetchPending.get(event.data.requestId);
        if (req) {
          clearTimeout(req.timer);
          fetchPending.delete(event.data.requestId);
          if (event.data.ok) {
            req.resolve(event.data.payload);
          } else {
            req.reject(new Error(event.data.error || "fetch_page_failed"));
          }
        }
      }
    });
    fetchListenerBound = true;
  }

  function fetchMessagesPageViaBridge(conversationId, cursor, options = {}) {
    ensureFetchListener();
    return new Promise((resolve, reject) => {
      const requestId = `fpage-${++fetchReqSeq}-${Date.now()}`;
      const timeoutMs = options.timeoutMs || 10000;
      const timer = setTimeout(() => {
        fetchPending.delete(requestId);
        reject(new Error("fetch_messages_page_timeout"));
      }, timeoutMs);

      fetchPending.set(requestId, { resolve, reject, timer });

      root.postMessage(
        {
          source: SOURCE,
          type: FETCH_PAGE_REQUEST_TYPE,
          requestId,
          conversationId,
          cursor
        },
        "*"
      );
    });
  }

  // --- Cursor Pagination History Loader ---

  async function loadFullConversationHistory(conversationId, basePayload, options = {}) {
    const converter = options.converter || root.CCEConversationConverter;
    if (!converter || typeof converter.inspect !== "function") {
      throw new Error("CCEConversationConverter not available");
    }

    if (!basePayload) {
      throw new Error("basePayload is required for history loading");
    }

    const pageInfo = basePayload.page_info;
    const hasPrevious = Boolean(pageInfo && pageInfo.has_previous_page === true);
    const startCursor = pageInfo && pageInfo.start_cursor;

    // If there is no previous page according to page_info, basePayload is already complete
    if (!hasPrevious || !startCursor) {
      return converter.inspect(basePayload);
    }

    const fetchPageFn = options.fetchPage || fetchMessagesPageViaBridge;
    const pages = [];
    let currentCursor = startCursor;
    let keepPaging = true;
    let pageCount = 0;
    const maxPages = options.maxPages || 50;

    while (keepPaging && currentCursor && pageCount < maxPages) {
      pageCount++;
      try {
        const pageData = await fetchPageFn(conversationId, currentCursor, options);
        if (!pageData || !Array.isArray(pageData.messages)) break;
        pages.push(pageData);

        const nextPageInfo = pageData.page_info;
        if (!nextPageInfo || nextPageInfo.has_previous_page === false || !nextPageInfo.start_cursor) {
          keepPaging = false;
        } else {
          currentCursor = nextPageInfo.start_cursor;
        }
      } catch (error) {
        // Stop pagination gracefully on error, merge what we have
        break;
      }
    }

    const mergedPayload =
      typeof converter.mergeMessagePages === "function"
        ? converter.mergeMessagePages(basePayload, pages, { olderComplete: !keepPaging })
        : basePayload;

    return converter.inspect(mergedPayload);
  }

  // --- Virtualized Jump Pipeline ---

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function findDomNodeForTarget(target, doc = root.document) {
    if (!doc) return null;
    if (target?.node instanceof (root.HTMLElement || Object) && target.node.isConnected) {
      return target.node;
    }

    const messageId = target?.messageId;
    if (messageId && doc.querySelectorAll) {
      const candidates = Array.from(
        doc.querySelectorAll(`[data-message-id="${messageId}"], [data-turn-id="${messageId}"]`)
      );
      for (const el of candidates) {
        const rootNode =
          el.closest("article") ||
          el.closest('[data-testid^="conversation-turn-"]') ||
          el.closest("section[data-turn]") ||
          el;
        if (rootNode.isConnected) return rootNode;
      }
    }

    // Text matching fallback
    const previewText = target?.previewText || target?.text;
    if (previewText && doc.querySelectorAll) {
      const turns = Array.from(
        doc.querySelectorAll('[data-message-author-role="user"], [data-testid="user-message"], section[data-turn="user"]')
      );
      for (const turn of turns) {
        const rootNode = turn.closest("article") || turn.closest('[data-testid^="conversation-turn-"]') || turn;
        const text = extractNodeText(rootNode);
        if (getTextMatchScore(previewText, text) >= TEXT_MATCH_THRESHOLD) {
          return rootNode;
        }
      }
    }

    return null;
  }

  function getRenderedMessageWindow(doc = root.document) {
    if (!doc || !doc.querySelectorAll) return { minIndex: null, maxIndex: null, items: [] };
    const elements = Array.from(
      doc.querySelectorAll('[data-message-author-role="user"], [data-testid="user-message"], section[data-turn="user"]')
    );
    const items = [];
    const indexes = [];

    elements.forEach((el) => {
      const rootNode = el.closest("article") || el.closest('[data-testid^="conversation-turn-"]') || el;
      if (!rootNode.isConnected) return;
      const testId = rootNode.getAttribute?.("data-testid") || "";
      const match = testId.match(/conversation-turn-(\d+)/i);
      const index = match ? Number(match[1]) + 1 : null;
      if (Number.isFinite(index)) {
        indexes.push(index);
        items.push({ node: rootNode, index });
      }
    });

    items.sort((a, b) => a.index - b.index);
    return {
      minIndex: indexes.length ? Math.min(...indexes) : null,
      maxIndex: indexes.length ? Math.max(...indexes) : null,
      items
    };
  }

  async function boundaryProbe(direction, container, options = {}) {
    if (!container) return false;
    const step = (container.clientHeight || 500) * 0.85;
    const oldTop = container.scrollTop;
    container.scrollTop = oldTop + direction * step;
    await sleep(options.settleMs || 100);
    return container.scrollTop !== oldTop;
  }

  /**
   * 4-Stage Virtualized Jump Engine:
   * 1. DOM direct hit
   * 2. React/TanStack virtualizer bridge
   * 3. Proportional fallback
   * 4. Boundary probe
   */
  async function jumpToPrompt(target, options = {}) {
    if (!target) return { ok: false, reason: "invalid_target" };
    const doc = options.document || root.document;

    // Stage 1: DOM direct hit
    const directNode = findDomNodeForTarget(target, doc);
    if (directNode) {
      scrollElementIntoView(directNode, options);
      return { ok: true, node: directNode, method: "direct" };
    }

    const targetIndex = Number.isFinite(target.targetIndex)
      ? target.targetIndex
      : Number.isFinite(target.index) ? target.index : null;
    const totalMessages = Number.isFinite(options.totalMessages) ? options.totalMessages : 0;

    // Stage 2: React/TanStack virtualizer bridge
    if (!options.disableVirtualizer && Number.isFinite(targetIndex)) {
      const baseZeroIndex = Math.max(0, targetIndex - 1);
      const candidateDeltas = [0, -1, 1, -2, 2];
      const candidates = [];
      candidateDeltas.forEach((delta) => {
        const c = baseZeroIndex + delta;
        if (c >= 0 && !candidates.includes(c)) candidates.push(c);
      });

      const bridgeFn = options.requestVirtualizer || requestVirtualizerScroll;
      const bridgeResult = await bridgeFn(candidates, options);
      if (bridgeResult && bridgeResult.ok) {
        await sleep(options.settleMs || 120);
        const resolvedAfterBridge = findDomNodeForTarget(target, doc);
        if (resolvedAfterBridge) {
          scrollElementIntoView(resolvedAfterBridge, options);
          return { ok: true, node: resolvedAfterBridge, method: "virtualizer" };
        }
      }
    }

    const container = options.scrollContainer || resolveScrollContainer(doc);

    // Stage 3: Proportional fallback
    if (container && Number.isFinite(targetIndex) && totalMessages > 1) {
      const ratio = (targetIndex - 1) / Math.max(1, totalMessages - 1);
      const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
      container.scrollTop = maxScroll * Math.min(1, Math.max(0, ratio));
      await sleep(options.settleMs || 150);

      const resolvedAfterRatio = findDomNodeForTarget(target, doc);
      if (resolvedAfterRatio) {
        scrollElementIntoView(resolvedAfterRatio, options);
        return { ok: true, node: resolvedAfterRatio, method: "ratio" };
      }
    }

    // Stage 4: Boundary probe
    if (container) {
      const maxAttempts = options.maxAttempts || VIRTUAL_JUMP_MAX_ATTEMPTS;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const rendered = getRenderedMessageWindow(doc);
        let direction = 1;
        if (Number.isFinite(targetIndex) && Number.isFinite(rendered.minIndex) && Number.isFinite(rendered.maxIndex)) {
          if (targetIndex < rendered.minIndex) direction = -1;
          else if (targetIndex > rendered.maxIndex) direction = 1;
          else direction = attempt % 2 === 0 ? -1 : 1;
        }

        await boundaryProbe(direction, container, options);
        const resolvedAfterProbe = findDomNodeForTarget(target, doc);
        if (resolvedAfterProbe) {
          scrollElementIntoView(resolvedAfterProbe, options);
          return { ok: true, node: resolvedAfterProbe, method: "probe", attempt };
        }
      }
    }

    return { ok: false, reason: "target_not_mounted_after_probe" };
  }

  // --- Navigator Backend State & Cache Controller ---

  function createChatGPTNavigatorBackend(deps = {}) {
    let state = {
      status: "idle", // "idle" | "loading" | "ready" | "error"
      conversationId: "",
      items: [],
      isPartial: true,
      error: null
    };

    const listeners = new Set();

    function notify() {
      const snapshot = { ...state, items: state.items.slice() };
      listeners.forEach((listener) => {
        try {
          listener(snapshot);
        } catch (_) {}
      });
    }

    function getState() {
      return { ...state, items: state.items.slice() };
    }

    function subscribe(listener) {
      if (typeof listener === "function") {
        listeners.add(listener);
        listener(getState());
      }
      return () => listeners.delete(listener);
    }

    function resetForConversation(nextConversationId) {
      if (nextConversationId !== state.conversationId) {
        state = {
          status: "idle",
          conversationId: nextConversationId || "",
          items: [],
          isPartial: true,
          error: null
        };
        notify();
      }
    }

    /**
     * Lazy initialization:
     * 1. Immediate local DOM prompt index.
     * 2. Background cursor pagination.
     * 3. Complete index update.
     */
    async function init(conversationId, basePayload, options = {}) {
      const activeId = conversationId || state.conversationId;
      if (activeId !== state.conversationId) {
        resetForConversation(activeId);
      }

      // If already ready and complete for current conversation, reuse cache
      if (state.status === "ready" && !state.isPartial && state.items.length > 0) {
        return getState();
      }

      // 1. Immediate local DOM prompt index
      const localItems = buildLocalPromptIndexFromDom(options.document || root.document);
      state = {
        status: "loading",
        conversationId: activeId,
        items: localItems,
        isPartial: true,
        error: null
      };
      notify();

      // 2. Background cursor pagination
      if (basePayload) {
        try {
          const document = await loadFullConversationHistory(activeId, basePayload, { ...deps, ...options });
          const fullItems = buildPromptIndexFromDocument(document);

          // Preserve any live DOM node references already found in local items
          const nodeMap = new Map();
          localItems.forEach((it) => {
            if (it.node && it.messageId) nodeMap.set(it.messageId, it.node);
          });
          fullItems.forEach((it) => {
            if (nodeMap.has(it.messageId)) it.node = nodeMap.get(it.messageId);
          });

          state = {
            status: "ready",
            conversationId: activeId,
            items: fullItems,
            isPartial: false,
            error: null
          };
          notify();
        } catch (error) {
          state = {
            status: localItems.length > 0 ? "ready" : "error",
            conversationId: activeId,
            items: localItems,
            isPartial: true,
            error: error?.message || String(error)
          };
          notify();
        }
      }

      return getState();
    }

    return {
      getState,
      subscribe,
      init,
      open: init,
      resetForConversation,
      jumpToPrompt: (target, opt) =>
        jumpToPrompt(target, { ...deps, totalMessages: state.items.length * 2, ...opt }),
      buildLocalPromptIndexFromDom,
      buildPromptIndexFromDocument
    };
  }

  // Export module to global root
  root.CCEChatGPTNavigator = {
    buildPromptIndexFromDocument,
    buildLocalPromptIndexFromDom,
    loadFullConversationHistory,
    jumpToPrompt,
    createChatGPTNavigatorBackend,
    getTextMatchScore
  };

  if (root.CCEChatGPTAdapter) {
    try {
      root.CCEChatGPTAdapter.navigator = root.CCEChatGPTNavigator;
    } catch (_) {}
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
