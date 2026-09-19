const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

// Create minimal browser environment for testing
class MockElement {
  constructor(tagName, attributes = {}, text = "") {
    this.tagName = (tagName || "div").toUpperCase();
    this.attributes = { ...attributes };
    this._textContent = text;
    this.children = [];
    this.parentElement = null;
    this.isConnected = true;
    this.scrollTop = 0;
    this.scrollHeight = 1000;
    this.clientHeight = 500;
    this.scrollIntoViewCalled = false;
    this.lastScrollOptions = null;
  }

  get textContent() {
    if (this.children.length > 0) {
      return this.children.map((c) => c.textContent).join("");
    }
    return this._textContent || "";
  }

  set textContent(val) {
    this._textContent = val;
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name);
  }

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
      if (part.startsWith(".")) {
        // class check
        const cls = part.slice(1);
        if ((this.getAttribute("class") || "").split(/\s+/).includes(cls)) return true;
      } else if (part.startsWith("[") && part.endsWith("]")) {
        const inner = part.slice(1, -1);
        if (inner.includes("=")) {
          const [key, val] = inner.split("=");
          const cleanVal = val.replace(/['"]/g, "");
          if (key.endsWith("^")) {
            const attrKey = key.slice(0, -1);
            if ((this.getAttribute(attrKey) || "").startsWith(cleanVal)) return true;
          } else if (key.endsWith("$")) {
            const attrKey = key.slice(0, -1);
            if ((this.getAttribute(attrKey) || "").endsWith(cleanVal)) return true;
          } else if (key.endsWith("*")) {
            const attrKey = key.slice(0, -1);
            if ((this.getAttribute(attrKey) || "").includes(cleanVal)) return true;
          } else {
            if (this.getAttribute(key) === cleanVal) return true;
          }
        } else {
          if (this.hasAttribute(inner)) return true;
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
        if (child.matches(selector)) {
          matched.push(child);
        }
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

  remove() {
    if (this.parentElement) {
      const idx = this.parentElement.children.indexOf(this);
      if (idx >= 0) this.parentElement.children.splice(idx, 1);
      this.parentElement = null;
    }
    this.isConnected = false;
  }

  getBoundingClientRect() {
    return { top: 100, bottom: 200, left: 0, right: 800, width: 800, height: 100 };
  }

  scrollIntoView(options) {
    this.scrollIntoViewCalled = true;
    this.lastScrollOptions = options;
  }

  scrollTo({ top }) {
    this.scrollTop = top;
  }
}

class MockDocument extends MockElement {
  constructor() {
    super("#document");
    this.body = new MockElement("body");
    this.documentElement = new MockElement("html");
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
    this.scrollingElement = this.documentElement;
  }

  createElement(tagName) {
    return new MockElement(tagName);
  }
}

// Setup VM Context
const mockDoc = new MockDocument();
const context = {
  console,
  URL,
  URLSearchParams,
  document: mockDoc,
  HTMLElement: MockElement,
  Element: MockElement,
  Node: MockElement,
  setTimeout,
  clearTimeout,
  postMessage: () => {}
};
context.window = context;
context.globalThis = context;
vm.createContext(context);

// Load required extension scripts
for (const file of [
  "extension/converter.js",
  "extension/adapters/chatgpt.js",
  "extension/adapters/chatgpt-navigator.js"
]) {
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
}

const converter = context.CCEConversationConverter;
const navigator = context.CCEChatGPTNavigator;

assert.ok(converter, "CCEConversationConverter should be loaded");
assert.ok(navigator, "CCEChatGPTNavigator should be loaded");

async function runTests() {
  console.log("Starting ChatGPT History Navigator Backend verification...");

  // 1. Current DOM prompt can be immediately indexed
  {
    console.log("Test 1: DOM prompt immediate indexing");
    const testDoc = new MockDocument();
    const thread = new MockElement("div", { id: "thread" });
    testDoc.body.appendChild(thread);

    // Turn 1 (user)
    const turn1 = new MockElement("article", { "data-testid": "conversation-turn-1", "data-turn-id": "turn-1" });
    const userRole1 = new MockElement("div", { "data-message-author-role": "user", "data-message-id": "msg-u1" }, "First question from user");
    turn1.appendChild(userRole1);
    thread.appendChild(turn1);

    // Turn 2 (assistant)
    const turn2 = new MockElement("article", { "data-testid": "conversation-turn-2", "data-turn-id": "turn-2" });
    const asstRole = new MockElement("div", { "data-message-author-role": "assistant", "data-message-id": "msg-a1" }, "Assistant reply");
    turn2.appendChild(asstRole);
    thread.appendChild(turn2);

    // Turn 3 (user)
    const turn3 = new MockElement("article", { "data-testid": "conversation-turn-3", "data-turn-id": "turn-3" });
    const userRole2 = new MockElement("div", { "data-message-author-role": "user", "data-message-id": "msg-u2" }, "Second question from user");
    turn3.appendChild(userRole2);
    thread.appendChild(turn3);

    const localIndex = navigator.buildLocalPromptIndexFromDom(testDoc);
    assert.strictEqual(localIndex.length, 2, "Should index exactly 2 user prompts from DOM");
    assert.strictEqual(localIndex[0].userOrder, 1);
    assert.strictEqual(localIndex[0].messageId, "msg-u1");
    assert.strictEqual(localIndex[0].previewText, "First question from user");
    assert.strictEqual(localIndex[0].node, turn1);

    assert.strictEqual(localIndex[1].userOrder, 2);
    assert.strictEqual(localIndex[1].messageId, "msg-u2");
    assert.strictEqual(localIndex[1].previewText, "Second question from user");
    assert.strictEqual(localIndex[1].node, turn3);
    console.log("PASS: Test 1 passed");
  }

  // 2. Multi-page cursor merges completely
  {
    console.log("Test 2: Multi-page cursor pagination and merging");
    const basePayload = {
      conversation_id: "conv-123",
      current_node: "msg-3",
      page_info: {
        has_previous_page: true,
        start_cursor: "cursor-page-2"
      },
      messages: [
        {
          id: "msg-2",
          author: { role: "assistant" },
          content: { content_type: "text", parts: ["Assistant response 2"] },
          parent: "msg-1"
        },
        {
          id: "msg-3",
          author: { role: "user" },
          content: { content_type: "text", parts: ["User prompt 2"] },
          parent: "msg-2"
        }
      ]
    };

    const mockPages = {
      "cursor-page-2": {
        page_info: {
          has_previous_page: true,
          start_cursor: "cursor-page-1"
        },
        messages: [
          {
            id: "msg-1",
            author: { role: "assistant" },
            content: { content_type: "text", parts: ["Assistant response 1"] },
            parent: "msg-0"
          }
        ]
      },
      "cursor-page-1": {
        page_info: {
          has_previous_page: false
        },
        messages: [
          {
            id: "msg-0",
            author: { role: "user" },
            content: { content_type: "text", parts: ["User prompt 1"] },
            parent: null
          }
        ]
      }
    };

    const requestedCursors = [];
    const mockFetchPage = async (convId, cursor) => {
      requestedCursors.push(cursor);
      return mockPages[cursor];
    };

    const doc = await navigator.loadFullConversationHistory("conv-123", basePayload, {
      converter,
      fetchPage: mockFetchPage
    });

    assert.deepStrictEqual(requestedCursors, ["cursor-page-2", "cursor-page-1"], "Should fetch pages in order");
    assert.strictEqual(doc.messages.length, 4, "Should merge into 4 total turns");
    assert.strictEqual(doc.messages[0].messageId, "msg-0");
    assert.strictEqual(doc.messages[1].messageId, "msg-1");
    assert.strictEqual(doc.messages[2].messageId, "msg-2");
    assert.strictEqual(doc.messages[3].messageId, "msg-3");
    console.log("PASS: Test 2 passed");
  }

  // 3. Active branch userOrder accuracy
  {
    console.log("Test 3: Active branch userOrder correctness");
    // Create a tree with a branched conversation:
    // root -> u1 -> a1 -> u2_inactive
    //                  -> u2_active -> a2 -> u3_active
    const branchedPayload = {
      conversation_id: "conv-branch",
      current_node: "u3_active",
      mapping: {
        "root": { id: "root", parent: null, children: ["u1"], message: null },
        "u1": {
          id: "u1",
          parent: "root",
          children: ["a1"],
          message: { id: "u1", author: { role: "user" }, content: { content_type: "text", parts: ["Prompt 1"] } }
        },
        "a1": {
          id: "a1",
          parent: "u1",
          children: ["u2_inactive", "u2_active"],
          message: { id: "a1", author: { role: "assistant" }, content: { content_type: "text", parts: ["Answer 1"] } }
        },
        "u2_inactive": {
          id: "u2_inactive",
          parent: "a1",
          children: [],
          message: { id: "u2_inactive", author: { role: "user" }, content: { content_type: "text", parts: ["Branched Prompt (ignored)"] } }
        },
        "u2_active": {
          id: "u2_active",
          parent: "a1",
          children: ["a2"],
          message: { id: "u2_active", author: { role: "user" }, content: { content_type: "text", parts: ["Prompt 2"] } }
        },
        "a2": {
          id: "a2",
          parent: "u2_active",
          children: ["u3_active"],
          message: { id: "a2", author: { role: "assistant" }, content: { content_type: "text", parts: ["Answer 2"] } }
        },
        "u3_active": {
          id: "u3_active",
          parent: "a2",
          children: [],
          message: { id: "u3_active", author: { role: "user" }, content: { content_type: "text", parts: ["Prompt 3"] } }
        }
      }
    };

    const doc = converter.inspect(branchedPayload);
    const promptIndex = navigator.buildPromptIndexFromDocument(doc);

    assert.strictEqual(promptIndex.length, 3, "Only active branch user prompts must be indexed");
    assert.strictEqual(promptIndex[0].messageId, "u1");
    assert.strictEqual(promptIndex[0].userOrder, 1);
    assert.strictEqual(promptIndex[0].targetIndex, 1); // 1st message in document.messages

    assert.strictEqual(promptIndex[1].messageId, "u2_active");
    assert.strictEqual(promptIndex[1].userOrder, 2);
    assert.strictEqual(promptIndex[1].targetIndex, 3); // 3rd message in document.messages

    assert.strictEqual(promptIndex[2].messageId, "u3_active");
    assert.strictEqual(promptIndex[2].userOrder, 3);
    assert.strictEqual(promptIndex[2].targetIndex, 5); // 5th message in document.messages
    console.log("PASS: Test 3 passed");
  }

  // 4. DOM mounted target jumps directly
  {
    console.log("Test 4: DOM mounted target direct jump");
    const testDoc = new MockDocument();
    const targetNode = new MockElement("article", { "data-message-id": "target-1" }, "Hello direct");
    testDoc.body.appendChild(targetNode);

    let virtualizerCalled = false;
    const res = await navigator.jumpToPrompt(
      { messageId: "target-1", targetIndex: 1 },
      {
        document: testDoc,
        requestVirtualizer: async () => {
          virtualizerCalled = true;
          return { ok: true };
        }
      }
    );

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.method, "direct");
    assert.strictEqual(res.node, targetNode);
    assert.strictEqual(targetNode.scrollIntoViewCalled, true);
    assert.strictEqual(virtualizerCalled, false, "Virtualizer must NOT be called on direct hit");
    console.log("PASS: Test 4 passed");
  }

  // 5. Unmounted target reachable via virtualized jump
  {
    console.log("Test 5: Virtualized jump to unmounted target");
    const testDoc = new MockDocument();
    let virtualizerCandidates = null;

    const res = await navigator.jumpToPrompt(
      { messageId: "unmounted-target", targetIndex: 4 },
      {
        document: testDoc,
        settleMs: 10,
        requestVirtualizer: async (candidates) => {
          virtualizerCandidates = candidates;
          // Simulate TanStack virtualizer rendering the node
          const mountedNode = new MockElement("article", { "data-message-id": "unmounted-target" }, "Rendered");
          testDoc.body.appendChild(mountedNode);
          return { ok: true, method: "scrollToIndex" };
        }
      }
    );

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.method, "virtualizer");
    assert.ok(virtualizerCandidates.includes(3), "Candidate indices should include 0-based targetIndex-1 (4-1=3)");
    assert.strictEqual(res.node.getAttribute("data-message-id"), "unmounted-target");
    console.log("PASS: Test 5 passed");
  }

  // 6. Fallback works when bridge is unavailable
  {
    console.log("Test 6: Proportional fallback & boundary probe");
    const testDoc = new MockDocument();
    const scrollRoot = new MockElement("div", { "data-scroll-root": "true" });
    scrollRoot.scrollHeight = 2000;
    scrollRoot.clientHeight = 500;
    testDoc.body.appendChild(scrollRoot);

    // Test Proportional fallback:
    let ratioJumpTriggered = false;
    const resRatio = await navigator.jumpToPrompt(
      { messageId: "ratio-target", targetIndex: 3 },
      {
        document: testDoc,
        scrollContainer: scrollRoot,
        totalMessages: 5,
        settleMs: 10,
        requestVirtualizer: async () => ({ ok: false, reason: "disabled" }),
        // Hook when ratio scroll moves container
        onApproximateScroll: () => {
          ratioJumpTriggered = true;
        }
      }
    );
    // When target appears after ratio scroll:
    const testDoc2 = new MockDocument();
    const scrollRoot2 = new MockElement("div", { "data-scroll-root": "true" });
    scrollRoot2.scrollHeight = 2000;
    scrollRoot2.clientHeight = 500;
    testDoc2.body.appendChild(scrollRoot2);

    // Attach getter/setter to simulate mounting on scroll
    Object.defineProperty(scrollRoot2, "scrollTop", {
      get() { return this._top || 0; },
      set(val) {
        this._top = val;
        if (val > 500 && !this._mounted) {
          this._mounted = true;
          const node = new MockElement("article", { "data-message-id": "ratio-target" });
          testDoc2.body.appendChild(node);
        }
      }
    });

    const res2 = await navigator.jumpToPrompt(
      { messageId: "ratio-target", targetIndex: 3 },
      {
        document: testDoc2,
        scrollContainer: scrollRoot2,
        totalMessages: 5,
        settleMs: 10,
        requestVirtualizer: async () => ({ ok: false, reason: "bridge_disabled" })
      }
    );

    assert.strictEqual(res2.ok, true);
    assert.strictEqual(res2.method, "ratio");
    console.log("PASS: Test 6 passed");
  }

  // 7. No history requests triggered on page load (lazy initialization)
  {
    console.log("Test 7: Lazy initialization constraint");
    let fetchCount = 0;
    const mockDeps = {
      converter,
      fetchPage: async () => {
        fetchCount++;
        return { messages: [] };
      }
    };

    const backend = navigator.createChatGPTNavigatorBackend(mockDeps);
    assert.strictEqual(backend.getState().status, "idle", "Status must be idle before open()");
    assert.strictEqual(fetchCount, 0, "No network calls before open()");

    // Now user explicitly opens Navigator
    const basePayload = {
      conversation_id: "lazy-conv",
      current_node: "u1",
      page_info: { has_previous_page: false },
      messages: [{ id: "u1", author: { role: "user" }, content: { content_type: "text", parts: ["hi"] }, parent: null }]
    };

    await backend.open("lazy-conv", basePayload);
    assert.strictEqual(backend.getState().status, "ready");
    assert.strictEqual(fetchCount, 0, "No older pages needed when has_previous_page is false");
    console.log("PASS: Test 7 passed");
  }

  // 8. Switching conversation invalidates cache
  {
    console.log("Test 8: Conversation change cache invalidation");
    const backend = navigator.createChatGPTNavigatorBackend({ converter });

    const baseA = {
      conversation_id: "conv-A",
      current_node: "uA",
      page_info: { has_previous_page: false },
      messages: [{ id: "uA", author: { role: "user" }, content: { content_type: "text", parts: ["Conv A Prompt"] }, parent: null }]
    };

    await backend.open("conv-A", baseA);
    assert.strictEqual(backend.getState().status, "ready");
    assert.strictEqual(backend.getState().conversationId, "conv-A");
    assert.strictEqual(backend.getState().items.length, 1);

    // Switch conversation
    backend.resetForConversation("conv-B");
    assert.strictEqual(backend.getState().status, "idle");
    assert.strictEqual(backend.getState().conversationId, "conv-B");
    assert.strictEqual(backend.getState().items.length, 0, "Cache must be cleared for new conversation");
    console.log("PASS: Test 8 passed");
  }

  console.log("\nALL 8 TESTS PASSED SUCCESSFULLY!");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
