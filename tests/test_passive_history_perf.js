const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

console.log("Running Passive History & Performance Trim Verification Suite...");

// Mock DOM elements
class MockElement {
  constructor(tagName, attributes = {}, text = "") {
    this.tagName = (tagName || "div").toUpperCase();
    this.attributes = { ...attributes };
    this.dataset = {};
    this._textContent = text;
    this.children = [];
    this.parentElement = null;
    this.isConnected = true;
    this.scrollIntoViewCalled = false;
    this.classList = {
      _classes: new Set(String(attributes.class || "").split(/\s+/).filter(Boolean)),
      contains(cls) { return this._classes.has(cls); },
      add(cls) { this._classes.add(cls); },
      remove(cls) { this._classes.delete(cls); }
    };
  }

  get textContent() {
    if (this.children.length > 0) return this.children.map((c) => c.textContent).join("");
    return this._textContent || "";
  }

  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }

  appendChild(child) {
    if (child instanceof MockElement) {
      child.parentElement = this;
      this.children.push(child);
    }
    return child;
  }

  closest(selector) {
    let curr = this;
    while (curr) {
      if (curr.matches(selector)) return curr;
      curr = curr.parentElement;
    }
    return null;
  }

  matches(selector) {
    const parts = selector.split(",").map((s) => s.trim());
    for (const part of parts) {
      if (part.startsWith("[")) {
        const [key, val] = part.slice(1, -1).split("=");
        if (!val) {
          if (this.attributes[key] !== undefined) return true;
        } else {
          const clean = val.replace(/['"]/g, "");
          if (this.attributes[key] === clean) return true;
        }
      } else if (part.toLowerCase() === this.tagName.toLowerCase()) {
        return true;
      }
    }
    return false;
  }

  querySelectorAll(selector) {
    const matched = [];
    const traverse = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) matched.push(child);
        traverse(child);
      }
    };
    traverse(this);
    return matched;
  }

  querySelector(selector) {
    const res = this.querySelectorAll(selector);
    return res.length > 0 ? res[0] : null;
  }

  cloneNode(deep = true) {
    const clone = new MockElement(this.tagName, this.attributes, this.textContent);
    if (deep) {
      for (const c of this.children) {
        clone.appendChild(c.cloneNode(true));
      }
    }
    return clone;
  }

  scrollIntoView() { this.scrollIntoViewCalled = true; }
  getBoundingClientRect() { return { top: 100, bottom: 200, left: 0, right: 800 }; }
}

class MockDocument extends MockElement {
  constructor() {
    super("#document");
    this.body = new MockElement("body");
    this.documentElement = new MockElement("html");
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
  }
}

// Set up VM Context
const mockDoc = new MockDocument();
const context = {
  console,
  URL,
  URLSearchParams,
  document: mockDoc,
  HTMLElement: MockElement,
  Element: MockElement,
  setTimeout,
  clearTimeout,
  AbortController: typeof AbortController !== "undefined" ? AbortController : undefined,
  Event: class Event { constructor(type) { this.type = type; } },
  postMessage: () => {}
};
context.window = context;
context.globalThis = context;
vm.createContext(context);

// Load scripts
for (const file of [
  "extension/converter.js",
  "extension/adapters/chatgpt.js",
  "extension/adapters/chatgpt-navigator.js"
]) {
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
}

const converter = context.CCEConversationConverter;
const navigator = context.CCEChatGPTNavigator;

async function runPassiveHistoryTests() {
  // Test 1: Passive Local Mode (No API pagination on open even with has_previous_page: true)
  {
    console.log("Test 1: History ON uses Passive Local Mode (Zero background pagination)");
    let fetchPageCalls = 0;
    const mockDeps = {
      converter,
      fetchPage: async () => {
        fetchPageCalls++;
        return { messages: [] };
      }
    };

    const backend = navigator.createChatGPTNavigatorBackend(mockDeps);
    const multiPagePayload = {
      conversation_id: "conv-multipage",
      current_node: "u2",
      page_info: {
        has_previous_page: true,
        start_cursor: "cursor-older-page"
      },
      messages: [
        { id: "u2", author: { role: "user" }, content: { content_type: "text", parts: ["Second Prompt"] }, parent: "a1" }
      ]
    };

    const testDoc = new MockDocument();
    const domArticle = new MockElement("article", { "data-message-id": "u2" });
    domArticle.appendChild(new MockElement("div", { "data-message-author-role": "user" }, "Second Prompt"));
    testDoc.body.appendChild(domArticle);

    await backend.open("conv-multipage", multiPagePayload, { document: testDoc });

    assert.equal(backend.getState().status, "ready", "Status must become ready immediately");
    assert.equal(fetchPageCalls, 0, "Passive Local Mode must NOT trigger background fetchPage pagination");
    assert.equal(backend.getState().items.length, 1, "Should index available prompt");
    assert.equal(backend.getState().items[0].messageId, "u2");
    assert.equal(backend.getState().items[0].isDomNode, true, "Should link to mounted DOM node");
    console.log("PASS: Test 1 passed");
  }

  // Test 2: Incremental Scroll-End Merge
  {
    console.log("Test 2: Incremental Scroll-End Merge on Manual User Scroll");
    const backend = navigator.createChatGPTNavigatorBackend({ converter });
    const testDoc = new MockDocument();

    // Initial state: only prompt 2 is mounted
    const art2 = new MockElement("article", { "data-message-id": "prompt-2", "data-testid": "conversation-turn-3" });
    art2.appendChild(new MockElement("div", { "data-message-author-role": "user" }, "Prompt 2 content"));
    testDoc.body.appendChild(art2);

    await backend.open("conv-scroll", null, { document: testDoc });
    assert.equal(backend.getState().items.length, 1);
    assert.equal(backend.getState().items[0].messageId, "prompt-2");
    assert.equal(backend.getState().items[0].userOrder, 1);

    // Simulate user scrolling up and ChatGPT mounting prompt 1 earlier in the DOM
    const art1 = new MockElement("article", { "data-message-id": "prompt-1", "data-testid": "conversation-turn-1" });
    art1.appendChild(new MockElement("div", { "data-message-author-role": "user" }, "Prompt 1 content"));
    // Insert at beginning of body
    testDoc.body.children.unshift(art1);
    art1.parentElement = testDoc.body;

    // Call incremental scroll-end scan
    const changed = backend.scanAndMergeDomPrompts(testDoc);
    assert.equal(changed, true, "Must report changes when earlier prompt is discovered");
    assert.equal(backend.getState().items.length, 2, "Items list must expand to 2");
    assert.equal(backend.getState().items[0].messageId, "prompt-1", "Earlier prompt must be first");
    assert.equal(backend.getState().items[0].userOrder, 1, "Order must be re-normalized");
    assert.equal(backend.getState().items[1].messageId, "prompt-2");
    assert.equal(backend.getState().items[1].userOrder, 2);

    // Call again with no new prompts mounted
    const changedAgain = backend.scanAndMergeDomPrompts(testDoc);
    assert.equal(changedAgain, false, "Must return false and do no work when no new prompts exist");
    console.log("PASS: Test 2 passed");
  }

  // DOM-only state invariants: stale API paths, append, edits, reorder, remount, empty.
  {
    const testDoc = new MockDocument();
    const makePrompt = (id, text) => {
      const article = new MockElement("article", { "data-message-id": id });
      article.appendChild(new MockElement("div", { "data-message-author-role": "user" }, text));
      return article;
    };
    const first = makePrompt("first", "First");
    testDoc.body.appendChild(first);
    let inspectCalls = 0;
    let fetchCalls = 0;
    const backend = navigator.createChatGPTNavigatorBackend({
      converter: { inspect() {
        inspectCalls++;
        return { messages: [{ role: "user", messageId: "stale", body: "Old snapshot" }] };
      } },
      fetchPage() { fetchCalls++; throw new Error("History must not paginate"); }
    });
    await backend.open("local", { conversation_id: "old", messages: [{ id: "stale" }] },
      { document: testDoc, paginate: true });
    assert.deepEqual(Array.from(backend.getState().items, it => it.messageId), ["first"]);
    assert.equal(inspectCalls, 0, "Captured active path must never enter local initialization");
    assert.equal(fetchCalls, 0);

    const middle = makePrompt("middle", "Middle");
    const last = makePrompt("last", "Last");
    testDoc.body.appendChild(middle);
    testDoc.body.appendChild(last);
    backend.scanAndMergeDomPrompts(testDoc);
    assert.deepEqual(Array.from(backend.getState().items, it => it.messageId), ["first", "middle", "last"]);
    assert.equal(backend.getState().items.at(-1).previewText, "Last");
    for (const item of backend.getState().items) {
      const result = await backend.jumpToPrompt(item, { document: testDoc });
      assert.equal(result.ok, true);
      assert.equal(result.method, "direct");
      assert.equal(result.node, item.node);
      assert.equal(item.node.scrollIntoViewCalled, true);
    }

    middle.children[0]._textContent = "Edited middle";
    middle.setAttribute("data-message-id", "middle-edited");
    testDoc.body.children = [last, middle, first];
    assert.equal(backend.scanAndMergeDomPrompts(testDoc), true);
    assert.deepEqual(Array.from(backend.getState().items, it => [it.messageId, it.previewText, it.userOrder]),
      [["last", "Last", 1], ["middle-edited", "Edited middle", 2], ["first", "First", 3]]);
    const replacement = makePrompt("first", "Updated first");
    first.isConnected = false;
    testDoc.body.children = [replacement];
    replacement.parentElement = testDoc.body;
    // Reopen must refresh even when the backend is already ready.
    await backend.open("local", null, { document: testDoc });
    assert.equal(backend.getState().items.length, 1);
    assert.equal(backend.getState().items[0].node, replacement);
    assert.equal(backend.getState().items[0].previewText, "Updated first");
    testDoc.body.children = [];
    assert.equal(backend.scanAndMergeDomPrompts(testDoc), true);
    assert.equal(backend.getState().items.length, 0);
    console.log("PASS: DOM-only index tracks append/edit/reorder/remount/empty and direct jumps");
  }

  // Epoch isolation, including retained outgoing DOM and delayed work after A -> B -> A.
  {
    const testDoc = new MockDocument();
    let conversationId = "A";
    const backend = navigator.createChatGPTNavigatorBackend({ getConversationId: () => conversationId });
    const article = new MockElement("article", { "data-message-id": "a" });
    article.appendChild(new MockElement("div", { "data-message-author-role": "user" }, "A prompt"));
    testDoc.body.appendChild(article);
    await backend.open("A", null, { document: testDoc });
    const old = backend.getState();
    conversationId = "B";
    assert.equal(backend.scanAndMergeDomPrompts(testDoc, old.epoch), false, "URL mismatch blocks work before route delivery");
    backend.resetForConversation("B", { discardMounted: true, document: testDoc });
    await backend.open("B", null, { document: testDoc });
    assert.equal(backend.getState().items.length, 0, "Outgoing DOM cannot become B's index");
    assert.equal((await backend.jumpToPrompt(old.items[0], { document: testDoc })).reason, "conversation_changed");
    await backend.open("A", { messages: [] }, { document: testDoc });
    assert.equal(backend.getState().conversationId, "B", "Late A init must not restore A");
    article.setAttribute("data-message-id", "b");
    article.children[0]._textContent = "B prompt";
    backend.scanAndMergeDomPrompts(testDoc);
    assert.equal(backend.getState().items[0].messageId, "b", "Recycled node with new identity can enter B");
    conversationId = "A";
    backend.resetForConversation("A");
    assert.equal(backend.scanAndMergeDomPrompts(testDoc, old.epoch), false, "Same conversation ID cannot revive an old epoch");
    await backend.open("A", null, { document: testDoc, epoch: old.epoch });
    assert.equal(backend.getState().status, "idle", "Late same-ID init must not publish");
    console.log("PASS: Conversation epoch rejects delayed scans, opens and clicks");
  }

  // Execute both real scripts in separate worlds; only DOM events/messages are shared.
  {
    const testDoc = new MockDocument();
    testDoc.readyState = "loading"; // Route/backend integration; UI rendering is not simulated here.
    testDoc.addEventListener = () => {};
    testDoc.createElement = tag => new MockElement(tag);
    testDoc.documentElement.appendChild(new MockElement("script", { "data-cce-observer": "true" }));
    const location = { href: "https://chatgpt.com/c/A" };
    const worlds = [];
    const queued = [];
    const timers = new Map();
    let timerId = 0;
    function makeWorld() {
      const listeners = new Map();
      const world = { console, URL, URLSearchParams, document: testDoc, location,
        HTMLElement: MockElement, AbortController,
        chrome: { runtime: { getURL: path => `chrome-extension://test/${path}` } },
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
        setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
        clearTimeout(id) { timers.delete(id); },
        addEventListener(type, fn) {
          if (!listeners.has(type)) listeners.set(type, []);
          listeners.get(type).push(fn);
        },
        dispatchEvent(event) { for (const other of worlds) other.deliver(event); },
        postMessage(data) { queued.push(data); },
        history: {
          pushState(_state, _title, url) { location.href = new URL(url, location.href).href; return "native-result"; },
          replaceState(_state, _title, url) { location.href = new URL(url, location.href).href; }
        }
      };
      world.window = world;
      world.globalThis = world;
      vm.createContext(world);
      // event.source must be the receiver's Window proxy, as in the real bridge.
      const proxy = vm.runInContext("window", world);
      world.deliver = event => {
        const received = event.type === "message" ? { ...event, source: proxy } : event;
        for (const fn of listeners.get(event.type) || []) fn(received);
      };
      worlds.push(world);
      return world;
    }
    const main = makeWorld();
    const isolated = makeWorld();
    const isolatedPush = isolated.history.pushState;
    vm.runInContext(fs.readFileSync("extension/injected.js", "utf8"), main);
    vm.runInContext(fs.readFileSync("extension/adapters/chatgpt-navigator.js", "utf8"), isolated);
    vm.runInContext(fs.readFileSync("extension/content.js", "utf8"), isolated);
    function flushMessages() {
      while (queued.length) {
        const data = queued.shift();
        for (const world of worlds) world.deliver({ type: "message", data });
      }
    }
    flushMessages();
    assert.equal(isolated.history.pushState, isolatedPush, "ISOLATED must not wrap route methods");
    const nav = isolated.CCEHistoryNavigator;
    const a = new MockElement("article", { "data-message-id": "a" });
    a.appendChild(new MockElement("div", { "data-message-author-role": "user" }, "A prompt"));
    testDoc.body.appendChild(a);
    await nav.open();
    const old = nav.getState();
    assert.equal(old.items[0].messageId, "a");
    assert.equal(main.history.pushState({}, "", "/c/B"), "native-result");
    assert.equal(nav.getState().conversationId, "B", "MAIN hook must synchronously reset ISOLATED");
    assert(nav.getState().epoch > old.epoch);
    await nav.open();
    assert.equal(nav.getState().items.length, 0, "Still mounted A DOM must not enter B");
    const b = new MockElement("article", { "data-message-id": "b" });
    b.appendChild(new MockElement("div", { "data-message-author-role": "user" }, "B prompt"));
    a.isConnected = false;
    testDoc.body.children = [b];
    b.parentElement = testDoc.body;
    await nav.open();
    assert.equal(nav.getState().items[0].messageId, "b");
    const beforeFlush = nav.getState().epoch;
    flushMessages();
    assert.equal(nav.getState().epoch, beforeFlush, "Duplicate asynchronous route notification must not reset B");
    main.history.replaceState({}, "", "/c/A");
    assert.equal(nav.getState().conversationId, "A");
    assert.equal(nav.scanAndMergeDomPrompts(testDoc, old.epoch), false);
    assert.equal((await nav.jumpToPrompt(old.items[0])).reason, "conversation_changed");
    // Late B notification cannot reset the current A epoch.
    isolated.deliver({ type: "message", data: { source: "chatgpt-current-exporter",
      type: "conversation-route", conversationId: "B", epoch: 1 } });
    assert.equal(nav.getState().conversationId, "A");
    location.href = "https://chatgpt.com/c/C";
    main.dispatchEvent({ type: "popstate" });
    assert.equal(nav.getState().conversationId, "C");
    flushMessages();
    // A draft keeps its live DOM when ChatGPT assigns the new conversation ID.
    b.setAttribute("data-message-id", "c");
    await nav.open();
    main.history.pushState({}, "", "/");
    const draft = new MockElement("article");
    draft.appendChild(new MockElement("div", { "data-message-author-role": "user" }, "Draft prompt"));
    testDoc.body.appendChild(draft);
    await nav.open();
    assert.equal(nav.getState().items.length, 1, "Previous conversation DOM is still excluded");
    assert.equal(nav.getState().items[0].messageId, "", "Do not invent an API message ID for local DOM");
    main.history.replaceState({}, "", "/c/new");
    draft.setAttribute("data-message-id", "new-user");
    await nav.open();
    assert.equal(nav.getState().items.length, 1, "Draft adoption must not revive outgoing DOM");
    assert.equal(nav.getState().items[0].messageId, "new-user");
    assert.equal((await nav.jumpToPrompt(nav.getState().items[0])).method, "direct");
    flushMessages();
    console.log("PASS: Separate MAIN/ISOLATED worlds route via pushState/replaceState/popstate with epoch deduplication");
  }

  // Test 3: Default Local Jump vs Guaranteed Seek
  {
    console.log("Test 3: Default Local Jump uses Direct DOM without Virtualizer/Progressive overhead");
    const testDoc = new MockDocument();
    let virtualizerCalled = false;

    // A. Target NOT in DOM with default local jump via backend
    const backend = navigator.createChatGPTNavigatorBackend({ converter });
    const resUnmounted = await backend.jumpToPrompt(
      { messageId: "not-in-dom", targetIndex: 2 },
      {
        document: testDoc,
        requestVirtualizer: async () => {
          virtualizerCalled = true;
          return { ok: true };
        }
      }
    );

    assert.equal(resUnmounted.ok, false, "Default local jump should not succeed for unmounted target");
    assert.equal(resUnmounted.reason, "target_not_mounted");
    assert.equal(virtualizerCalled, false, "Default local jump must NEVER call virtualizer");

    // B. Explicit Guaranteed Seek via backend.seekGuaranteed DOES engage virtualizer
    const resGuaranteed = await backend.seekGuaranteed(
      { messageId: "not-in-dom-guaranteed", targetIndex: 2 },
      {
        document: testDoc,
        settleMs: 10,
        requestVirtualizer: async () => {
          virtualizerCalled = true;
          const node = new MockElement("article", { "data-message-id": "not-in-dom-guaranteed" });
          testDoc.body.appendChild(node);
          return { ok: true };
        }
      }
    );

    assert.equal(virtualizerCalled, true, "Guaranteed seek must call virtualizer when requested");
    assert.equal(resGuaranteed.ok, true);
    assert.equal(resGuaranteed.method, "virtualizer");
    console.log("PASS: Test 3 passed");
  }

  // Test 4: Fast-path Network Filtering in injected.js
  {
    console.log("Test 4: Injected script fast-path network filtering & WebSocket check");
    const injectedSrc = fs.readFileSync("extension/injected.js", "utf8");

    // Verify WebSocket proxy is disabled
    assert(!injectedSrc.includes("window.WebSocket = new Proxy"), "WebSocket proxy must be disabled");
    assert(injectedSrc.includes("diagnostics.webSocketHooked = false"), "diagnostics.webSocketHooked must be false");

    // Verify URL filtering in fetch and XHR
    assert(injectedSrc.includes("function isLikelyConversationUrl"), "isLikelyConversationUrl helper must exist");
    assert(injectedSrc.includes("if (!isLikelyConversationUrl(targetUrl))"), "fetch must bypass non-conversation URLs");
    assert(injectedSrc.includes("if (!isLikelyConversationUrl(this.__CCE_REQUEST_URL__))"), "xhr must bypass non-conversation URLs");
    console.log("PASS: Test 4 passed");
  }

  // Test 5: History OFF Zero-Cost Contracts in content.js
  {
    console.log("Test 5: History OFF Zero-Cost Contracts in content.js");
    const contentSrc = fs.readFileSync("extension/content.js", "utf8");

    // Theme sync must not observe style or body
    assert(!contentSrc.includes('attributeFilter: ["class", "data-theme", "style"]'), "Theme sync must not observe style attribute");
    assert(!contentSrc.includes('observer.observe(document.body'), "Theme sync must not observe document.body");

    // detectTheme must not call getComputedStyle
    assert(!contentSrc.includes("getComputedStyle(body || html)"), "detectTheme must not force reflow via getComputedStyle");

    // Scroll listener must not be unconditional window.addEventListener("scroll")
    assert(!contentSrc.includes('window.addEventListener("scroll", () => {\n      if (scrollThrottle) return;'), "Global unconditional scroll listener must be removed");
    assert(contentSrc.includes("function syncScrollListener()"), "syncScrollListener must dynamically manage scroll listener");

    // No 750ms polling interval
    assert(!contentSrc.includes("}, 750);"), "750ms interval must be removed");
    assert(contentSrc.includes('window.addEventListener("popstate", checkConversationChange)'), "SPA route changes must use popstate listener");

    // No startup automatic requestRescan
    assert(!contentSrc.includes("window.setTimeout(requestRescan, 0);"), "Startup automatic requestRescan must be removed");
    console.log("PASS: Test 5 passed");
  }

  console.log("\nALL PASSIVE HISTORY & PERFORMANCE TRIM TESTS PASSED SUCCESSFULLY!");
}

runPassiveHistoryTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
