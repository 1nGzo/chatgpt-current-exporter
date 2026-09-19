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

  function applyTransientHighlight(element) {
    if (!element || typeof element.style === "undefined") return;
    try {
      const prevOutline = element.style.outline;
      const prevOutlineOffset = element.style.outlineOffset;
      const prevTransition = element.style.transition;
      element.style.outline = "2px solid rgba(16, 163, 127, 0.55)";
      element.style.outlineOffset = "2px";
      element.style.transition = "outline 0.8s ease-out";
      const t = setTimeout(() => {
        try {
          element.style.outline = prevOutline || "";
          element.style.outlineOffset = prevOutlineOffset || "";
          element.style.transition = prevTransition || "";
        } catch (_) {}
      }, 1200);
      if (t && typeof t.unref === "function") t.unref();
    } catch (_) {}
  }

  function findDomNodeForTarget(target, doc = root.document) {
    if (!doc) return null;
    const targetMessageId = target?.messageId;

    if (target?.node instanceof (root.HTMLElement || Object) && target.node.isConnected) {
      if (targetMessageId) {
        const nodeId = getDomMessageId(target.node);
        if (!nodeId || nodeId === targetMessageId) return target.node;
      } else {
        return target.node;
      }
    }

    if (targetMessageId && doc.querySelectorAll) {
      const candidates = Array.from(
        doc.querySelectorAll(`[data-message-id="${targetMessageId}"], [data-turn-id="${targetMessageId}"]`)
      );
      for (const el of candidates) {
        const rootNode =
          el.closest("article") ||
          el.closest('[data-testid^="conversation-turn-"]') ||
          el.closest("section[data-turn]") ||
          el;
        if (rootNode && rootNode.isConnected) return rootNode;
      }
    }

    // Text matching fallback (only when messageId is unknown or candidate does not contradict targetMessageId)
    const previewText = target?.previewText || target?.text;
    if (previewText && doc.querySelectorAll) {
      const turns = Array.from(
        doc.querySelectorAll('[data-message-author-role="user"], [data-testid="user-message"], section[data-turn="user"]')
      );
      for (const turn of turns) {
        const rootNode = turn.closest("article") || turn.closest('[data-testid^="conversation-turn-"]') || turn;
        if (!rootNode || !rootNode.isConnected) continue;
        const nodeMsgId = getDomMessageId(rootNode);
        if (targetMessageId && nodeMsgId && nodeMsgId !== targetMessageId) continue;
        const text = extractNodeText(rootNode);
        if (getTextMatchScore(previewText, text) >= TEXT_MATCH_THRESHOLD) {
          return rootNode;
        }
      }
    }

    return null;
  }

  function waitForDomTarget(target, doc = root.document, options = {}) {
    const timeoutMs = options.timeoutMs || 400;
    const pollIntervalMs = options.pollIntervalMs || 40;
    const signal = options.signal;
    const safeSetTimeout = root.setTimeout || (typeof setTimeout !== "undefined" ? setTimeout : null);
    const safeClearTimeout = root.clearTimeout || (typeof clearTimeout !== "undefined" ? clearTimeout : null);

    return new Promise((resolve) => {
      const immediate = findDomNodeForTarget(target, doc);
      if (immediate) return resolve(immediate);
      if (signal?.aborted) return resolve(null);

      let timer = null;
      let pollTimer = null;
      let observer = null;
      let done = false;

      const finish = (result) => {
        if (done) return;
        done = true;
        if (timer && safeClearTimeout) safeClearTimeout(timer);
        if (pollTimer && safeClearTimeout) safeClearTimeout(pollTimer);
        if (observer) {
          try { observer.disconnect(); } catch (_) {}
          observer = null;
        }
        if (signal && onAbort) {
          signal.removeEventListener("abort", onAbort);
        }
        resolve(result);
      };

      const check = () => {
        if (done) return;
        if (signal?.aborted) {
          return finish(null);
        }
        const node = findDomNodeForTarget(target, doc);
        if (node) {
          return finish(node);
        }
        if (safeSetTimeout) {
          pollTimer = safeSetTimeout(check, pollIntervalMs);
        }
      };

      const onAbort = () => {
        finish(null);
      };

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      const MutationObserverClass = root.MutationObserver || (typeof MutationObserver !== "undefined" ? MutationObserver : null);
      if (MutationObserverClass && doc && (doc.body || doc.documentElement)) {
        try {
          observer = new MutationObserverClass(() => {
            check();
          });
          observer.observe(doc.body || doc.documentElement, {
            childList: true,
            subtree: true
          });
        } catch (_) {}
      }

      if (safeSetTimeout) {
        pollTimer = safeSetTimeout(check, pollIntervalMs);
        timer = safeSetTimeout(() => {
          finish(findDomNodeForTarget(target, doc));
        }, timeoutMs);
      } else {
        finish(findDomNodeForTarget(target, doc));
      }
    });
  }

  function getRenderedPromptWindow(doc = root.document, promptIndex = []) {
    if (!doc || !doc.querySelectorAll) {
      return { minUserOrder: null, maxUserOrder: null, minIndex: null, maxIndex: null, items: [] };
    }

    const promptByMsgId = new Map();
    if (Array.isArray(promptIndex)) {
      promptIndex.forEach((p) => {
        if (p.messageId) promptByMsgId.set(p.messageId, p);
      });
    }

    const elements = Array.from(
      doc.querySelectorAll('[data-message-author-role="user"], [data-testid="user-message"], section[data-turn="user"], article')
    );
    const seenNodes = new Set();
    const renderedItems = [];
    const renderedOrders = [];
    const renderedIndices = [];

    elements.forEach((el) => {
      const rootNode =
        el.closest("article") ||
        el.closest('[data-testid^="conversation-turn-"]') ||
        el.closest("section[data-turn]") ||
        el;
      if (!rootNode || !rootNode.isConnected || seenNodes.has(rootNode)) return;
      seenNodes.add(rootNode);

      const msgId = getDomMessageId(rootNode);
      let matchedPrompt = msgId ? promptByMsgId.get(msgId) : null;

      const testId = rootNode.getAttribute?.("data-testid") || "";
      const match = testId.match(/conversation-turn-(\d+)/i);
      const turnIndex = match ? Number(match[1]) + 1 : null;
      if (Number.isFinite(turnIndex)) renderedIndices.push(turnIndex);

      if (!matchedPrompt && promptIndex.length > 0) {
        const text = extractNodeText(rootNode);
        if (text) {
          for (const p of promptIndex) {
            const preview = p.previewText || p.text;
            if (preview && getTextMatchScore(preview, text) >= TEXT_MATCH_THRESHOLD) {
              matchedPrompt = p;
              break;
            }
          }
        }
      }

      if (matchedPrompt && Number.isFinite(matchedPrompt.userOrder)) {
        renderedOrders.push(matchedPrompt.userOrder);
        renderedItems.push({
          node: rootNode,
          messageId: msgId || matchedPrompt.messageId,
          userOrder: matchedPrompt.userOrder,
          prompt: matchedPrompt,
          index: turnIndex
        });
      } else if (Number.isFinite(turnIndex)) {
        renderedItems.push({
          node: rootNode,
          messageId: msgId,
          userOrder: null,
          index: turnIndex
        });
      }
    });

    renderedOrders.sort((a, b) => a - b);
    renderedIndices.sort((a, b) => a - b);

    return {
      minUserOrder: renderedOrders.length ? renderedOrders[0] : null,
      maxUserOrder: renderedOrders.length ? renderedOrders[renderedOrders.length - 1] : null,
      minIndex: renderedIndices.length ? renderedIndices[0] : null,
      maxIndex: renderedIndices.length ? renderedIndices[renderedIndices.length - 1] : null,
      items: renderedItems
    };
  }

  function findNearestRenderedPrompt(target, renderedItems = []) {
    if (!Array.isArray(renderedItems) || renderedItems.length === 0) return null;
    const targetOrder = target?.userOrder;
    if (!Number.isFinite(targetOrder)) return renderedItems[0];
    let closest = null;
    let minDiff = Infinity;
    for (const item of renderedItems) {
      if (Number.isFinite(item.userOrder)) {
        const diff = Math.abs(item.userOrder - targetOrder);
        if (diff < minDiff) {
          minDiff = diff;
          closest = item;
        }
      }
    }
    return closest || renderedItems[0];
  }

  function arriveAtTargetNode(node, target, options = {}, method = "direct") {
    if (!node || !node.isConnected) return { ok: false, reason: "node_not_connected" };
    scrollElementIntoView(node, { ...options, block: "center" });

    // Confirm target still matches messageId if available
    const confirmedId = getDomMessageId(node);
    if (target.messageId && confirmedId && confirmedId !== target.messageId) {
      const rechecked = findDomNodeForTarget(target, options.document || root.document);
      if (rechecked && rechecked !== node) {
        scrollElementIntoView(rechecked, { ...options, block: "center" });
        applyTransientHighlight(rechecked);
        if (target) target.node = rechecked;
        return { ok: true, node: rechecked, method };
      }
      return { ok: false, reason: "message_id_mismatch" };
    }

    applyTransientHighlight(node);
    if (target) target.node = node;
    return { ok: true, node, method };
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
   * Guaranteed History Seek State Machine:
   * Stage 1: Direct DOM (find mounted target by messageId, center, highlight, success)
   * Stage 2: Virtualizer Bridge (request jump, bounded wait with MutationObserver, success on node appearance)
   * Stage 3: Progressive Seek (directional step-by-step approach based on rendered window & nearest prompt)
   * Stage 4: Precise Arrival (scrollIntoView center, verify messageId, subtle highlight)
   * Fallback: Boundary Fallback (target-directed boundary trigger without full DOM upfront cost)
   */
  async function jumpToPrompt(target, options = {}) {
    if (!target) return { ok: false, reason: "invalid_target" };
    const doc = options.document || root.document;
    const signal = options.signal;

    if (signal?.aborted) {
      return { ok: false, reason: signal.reason || "aborted" };
    }

    // Stage 1: Direct DOM
    const directNode = findDomNodeForTarget(target, doc);
    if (directNode) {
      return arriveAtTargetNode(directNode, target, options, "direct");
    }

    if (signal?.aborted) {
      return { ok: false, reason: signal.reason || "aborted" };
    }

    // Default Local Mode: direct DOM only. Guaranteed Seek (virtualizer & progressive seek)
    // is only activated on explicit request.
    const isGuaranteed = Boolean(
      options.mode === "guaranteed" ||
      options.guaranteed === true ||
      options.scrollContainer ||
      (options.requestVirtualizer && options.mode !== "local")
    );
    if (!isGuaranteed) {
      return { ok: false, reason: "target_not_mounted" };
    }

    const targetIndex = Number.isFinite(target.targetIndex)
      ? target.targetIndex
      : Number.isFinite(target.index)
      ? target.index
      : Number.isFinite(target.userOrder)
      ? target.userOrder * 2 - 1
      : null;
    const totalMessages = Number.isFinite(options.totalMessages) ? options.totalMessages : 0;
    const promptIndex = Array.isArray(options.promptIndex) ? options.promptIndex : [];

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
      try {
        const bridgeResult = await bridgeFn(candidates, options);
        if (bridgeResult && bridgeResult.ok) {
          const resolvedAfterBridge = await waitForDomTarget(target, doc, {
            timeoutMs: options.settleMs ? Math.max(options.settleMs, 120) : 400,
            signal
          });
          if (resolvedAfterBridge) {
            return arriveAtTargetNode(resolvedAfterBridge, target, options, "virtualizer");
          }
        }
      } catch (_) {}
    }

    if (signal?.aborted) {
      return { ok: false, reason: signal.reason || "aborted" };
    }

    const container = options.scrollContainer || resolveScrollContainer(doc);

    // Stage 3: Progressive Seek
    if (container) {
      const maxIterations = options.maxIterations || VIRTUAL_JUMP_MAX_ATTEMPTS;
      let boundaryHitCount = 0;

      for (let attempt = 1; attempt <= maxIterations; attempt++) {
        if (signal?.aborted) {
          return { ok: false, reason: signal.reason || "aborted" };
        }

        const rendered = getRenderedPromptWindow(doc, promptIndex);

        // Determine seek direction toward target
        let direction = -1;
        if (Number.isFinite(target.userOrder) && (rendered.minUserOrder !== null || rendered.maxUserOrder !== null)) {
          if (rendered.minUserOrder !== null && target.userOrder < rendered.minUserOrder) {
            direction = -1;
          } else if (rendered.maxUserOrder !== null && target.userOrder > rendered.maxUserOrder) {
            direction = 1;
          } else {
            const nearest = findNearestRenderedPrompt(target, rendered.items);
            if (nearest && Number.isFinite(nearest.userOrder)) {
              direction = target.userOrder < nearest.userOrder ? -1 : 1;
            } else {
              direction = attempt % 2 === 0 ? -1 : 1;
            }
          }
        } else if (Number.isFinite(targetIndex) && (rendered.minIndex !== null || rendered.maxIndex !== null)) {
          if (rendered.minIndex !== null && targetIndex < rendered.minIndex) {
            direction = -1;
          } else if (rendered.maxIndex !== null && targetIndex > rendered.maxIndex) {
            direction = 1;
          } else {
            direction = attempt % 2 === 0 ? -1 : 1;
          }
        } else {
          if (Number.isFinite(target.userOrder) && target.userOrder <= 2) {
            direction = -1;
          } else if (totalMessages > 1 && Number.isFinite(targetIndex)) {
            const ratio = (targetIndex - 1) / Math.max(1, totalMessages - 1);
            const currentRatio = container.scrollHeight > container.clientHeight
              ? container.scrollTop / (container.scrollHeight - container.clientHeight)
              : 0.5;
            direction = ratio < currentRatio ? -1 : 1;
          } else {
            direction = container.scrollTop > 100 ? -1 : 1;
          }
        }

        let isInitialRatio = false;
        if (attempt === 1 && totalMessages > 1 && Number.isFinite(targetIndex)) {
          isInitialRatio = true;
          const ratio = (targetIndex - 1) / Math.max(1, totalMessages - 1);
          const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
          container.scrollTop = maxScroll * Math.min(1, Math.max(0, ratio));
          if (typeof options.onApproximateScroll === "function") {
            try { options.onApproximateScroll(container.scrollTop); } catch (_) {}
          }
        } else {
          const clientH = container.clientHeight || 500;
          let step = Math.max(clientH * 0.85, 450);
          if (Number.isFinite(target.userOrder)) {
            const currentOrder = direction < 0
              ? (rendered.minUserOrder ?? target.userOrder + 5)
              : (rendered.maxUserOrder ?? target.userOrder - 5);
            const promptDiff = Math.abs(currentOrder - target.userOrder);
            if (target.userOrder <= 2 && direction < 0) {
              step = Math.max(step * 5, container.scrollTop);
            } else if (promptDiff > 2) {
              step = Math.min(promptDiff * step, step * 6);
            }
          }
          const oldTop = container.scrollTop;
          const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);

          if (direction < 0) {
            container.scrollTop = Math.max(0, oldTop - step);
          } else {
            container.scrollTop = Math.min(maxScroll, oldTop + step);
          }

          if (container.scrollTop === oldTop) {
            boundaryHitCount++;
          } else {
            boundaryHitCount = 0;
          }
        }

        try {
          container.dispatchEvent(new (root.Event || Event)("scroll", { bubbles: true }));
        } catch (_) {}

        if (container.scrollTop === 0 && direction < 0) {
          try {
            container.dispatchEvent(new (root.WheelEvent || root.Event)("wheel", { deltaY: -100, bubbles: true }));
          } catch (_) {}
        }

        const waitTime = container.scrollTop === 0 && direction < 0
          ? Math.max(options.settleMs || 100, 200)
          : (options.settleMs || 100);

        const resolved = await waitForDomTarget(target, doc, { timeoutMs: waitTime, signal });
        if (resolved) {
          return arriveAtTargetNode(resolved, target, options, isInitialRatio ? "ratio" : "progressive");
        }

        if (boundaryHitCount >= 3) {
          break;
        }
      }

      if (signal?.aborted) {
        return { ok: false, reason: signal.reason || "aborted" };
      }

      // Stage 4 / Fallback: User-jump triggered boundary fallback
      const isEarly = (Number.isFinite(target.userOrder) && target.userOrder <= 2) ||
                      (Number.isFinite(targetIndex) && targetIndex <= 3);
      if (isEarly) {
        container.scrollTop = 0;
        try {
          container.dispatchEvent(new (root.Event || Event)("scroll", { bubbles: true }));
          container.dispatchEvent(new (root.WheelEvent || root.Event)("wheel", { deltaY: -200, bubbles: true }));
        } catch (_) {}

        if (!options.disableVirtualizer) {
          const bridgeFn = options.requestVirtualizer || requestVirtualizerScroll;
          try {
            await bridgeFn([0], { ...options, align: "start" });
          } catch (_) {}
        }

        const fallbackNode = await waitForDomTarget(target, doc, {
          timeoutMs: options.fallbackTimeoutMs || 600,
          signal
        });
        if (fallbackNode) {
          return arriveAtTargetNode(fallbackNode, target, options, "fallback");
        }
      } else if (Number.isFinite(target.userOrder) && promptIndex.length > 0 && target.userOrder >= promptIndex.length) {
        container.scrollTop = container.scrollHeight;
        try {
          container.dispatchEvent(new (root.Event || Event)("scroll", { bubbles: true }));
        } catch (_) {}
        const fallbackNode = await waitForDomTarget(target, doc, {
          timeoutMs: options.fallbackTimeoutMs || 600,
          signal
        });
        if (fallbackNode) {
          return arriveAtTargetNode(fallbackNode, target, options, "fallback");
        }
      }
    }

    return { ok: false, reason: "target_not_materialized" };
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

    let activeSeekController = null;
    const listeners = new Set();

    function cancelActiveSeek(reason = "aborted") {
      if (activeSeekController) {
        try {
          activeSeekController.abort(reason);
        } catch (_) {}
        activeSeekController = null;
      }
    }

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
        cancelActiveSeek("conversation_changed");
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
     * Passive Local Mode initialization:
     * 1. Immediate local DOM prompt index.
     * 2. If basePayload exists, extract active path prompts from it.
     * 3. Merge by messageId and mark ready (NO background API pagination).
     */
    async function init(conversationId, basePayload, options = {}) {
      const activeId = conversationId || state.conversationId;
      if (activeId !== state.conversationId) {
        resetForConversation(activeId);
      }

      // If already ready for current conversation and has items, reuse
      if (state.status === "ready" && state.items.length > 0) {
        return getState();
      }

      // 1. Immediate local DOM prompt index
      const localItems = buildLocalPromptIndexFromDom(options.document || root.document);

      // 2. If basePayload is provided, inspect it for active path prompt items
      let payloadItems = [];
      if (basePayload) {
        try {
          const converter = deps.converter || root.CCEConversationConverter;
          if (converter && typeof converter.inspect === "function") {
            const document = converter.inspect(basePayload);
            payloadItems = buildPromptIndexFromDocument(document);
          }
        } catch (_) {}
      }

      // 3. Merge: if payloadItems exists, match DOM nodes into it; otherwise use localItems
      let mergedItems = [];
      if (payloadItems.length > 0) {
        const nodeMap = new Map();
        localItems.forEach((it) => {
          if (it.node && it.messageId) nodeMap.set(it.messageId, it.node);
        });
        payloadItems.forEach((it) => {
          if (nodeMap.has(it.messageId)) {
            it.node = nodeMap.get(it.messageId);
            it.isDomNode = true;
          }
        });
        mergedItems = payloadItems;
      } else {
        mergedItems = localItems;
      }

      state = {
        status: "ready",
        conversationId: activeId,
        items: mergedItems,
        isPartial: true,
        error: null
      };
      notify();

      // Only perform background cursor pagination if explicitly opted-in via options.paginate === true
      if (options.paginate && basePayload) {
        try {
          const document = await loadFullConversationHistory(activeId, basePayload, { ...deps, ...options });
          const fullItems = buildPromptIndexFromDocument(document);
          const nodeMap = new Map();
          mergedItems.forEach((it) => {
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
          // Keep passive items on error
        }
      }

      return getState();
    }

    /**
     * Incremental scroll-end scanner:
     * When user manually scrolls up and ChatGPT loads earlier messages in the DOM,
     * detect newly mounted user prompts and merge into state.items by messageId.
     */
    function scanAndMergeDomPrompts(doc = root.document) {
      const newlySeen = buildLocalPromptIndexFromDom(doc);
      if (!newlySeen.length) return false;

      const existingById = new Map();
      state.items.forEach((it) => {
        if (it.messageId) existingById.set(it.messageId, it);
      });

      let changed = false;
      const unindexed = [];

      newlySeen.forEach((item) => {
        if (existingById.has(item.messageId)) {
          const existing = existingById.get(item.messageId);
          if (item.node && existing.node !== item.node) {
            existing.node = item.node;
            existing.isDomNode = true;
          }
        } else {
          unindexed.push(item);
          changed = true;
        }
      });

      if (!changed) return false;

      // Newly revealed items from scrolling up are earlier in conversation order
      const combined = [...unindexed, ...state.items];
      combined.forEach((item, idx) => {
        item.userOrder = idx + 1;
      });

      state = {
        ...state,
        items: combined
      };
      notify();
      return true;
    }

    return {
      getState,
      subscribe,
      init,
      open: init,
      scanAndMergeDomPrompts,
      resetForConversation,
      cancelActiveSeek,
      jumpToPrompt: (target, opt = {}) => {
        cancelActiveSeek("superseded");
        const AbortCtrl = root.AbortController || (typeof AbortController !== "undefined" ? AbortController : null);
        let controller = null;
        if (AbortCtrl) {
          try {
            controller = new AbortCtrl();
            activeSeekController = controller;
          } catch (_) {}
        }

        const timeoutMs = opt.timeoutMs || 10000;
        let timeoutTimer = null;
        if (controller && typeof controller.abort === "function") {
          timeoutTimer = setTimeout(() => {
            if (activeSeekController === controller) {
              controller.abort("timeout");
            }
          }, timeoutMs);
          if (timeoutTimer && typeof timeoutTimer.unref === "function") {
            timeoutTimer.unref();
          }
        }

        const combinedOptions = {
          mode: "local",
          ...deps,
          promptIndex: state.items,
          totalMessages: state.items.length * 2,
          signal: controller ? controller.signal : undefined,
          ...opt
        };

        const promise = jumpToPrompt(target, combinedOptions);

        promise.finally(() => {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          if (activeSeekController === controller) {
            activeSeekController = null;
          }
        });

        return promise;
      },
      seekGuaranteed: (target, opt = {}) => {
        return jumpToPrompt(target, { mode: "guaranteed", guaranteed: true, ...opt });
      },
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
