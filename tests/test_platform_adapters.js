const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const context = { console, URL, URLSearchParams, globalThis: {} };
context.globalThis = context;
vm.createContext(context);

for (const file of ["extension/core/platform.js", "extension/core/normalized.js", "extension/adapters/chatgpt.js"]) {
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
}

// 1. Platform detection
assert.strictEqual(context.CCEPlatformCore.detectPlatform("https://chatgpt.com/c/example"), "chatgpt");
assert.strictEqual(context.CCEPlatformCore.detectPlatform("https://chatgpt.com/"), "chatgpt");
assert.strictEqual(context.CCEPlatformCore.detectPlatform("https://grok.com/c/grok-123"), "grok");
assert.strictEqual(context.CCEPlatformCore.detectPlatform("https://grok.com/"), "grok");
assert.strictEqual(context.CCEPlatformCore.detectPlatform("https://example.com/"), "unsupported");

// 2. Conversation ID hints
assert.strictEqual(context.CCEPlatformCore.conversationIdHint("https://chatgpt.com/c/example-conv-id", "chatgpt"), "example-conv-id");
assert.strictEqual(context.CCEPlatformCore.conversationIdHint("https://grok.com/c/grok-conv-id", "grok"), "grok-conv-id");
assert.strictEqual(context.CCEPlatformCore.conversationIdHint("https://grok.com/chat/grok-chat-id", "grok"), "grok-chat-id");

// 3. ChatGPT Adapter
assert.strictEqual(context.CCEChatGPTAdapter.id, "chatgpt");
assert.strictEqual(context.CCEChatGPTAdapter.isConversationCandidate({ mapping: {} }), true);
assert.strictEqual(
  context.CCEChatGPTAdapter.isConversationCandidate({
    messages: [{ id: "1" }],
    current_node: "n1",
    conversation_id: "c1"
  }),
  true
);
assert.strictEqual(context.CCEChatGPTAdapter.isConversationCandidate({ foo: "bar" }), false);

const mockDoc = {
  conversationId: "test-cid",
  title: "Test Title",
  messages: [
    { role: "user", body: "Hello", createTime: 1700000000, messageId: "m1", nodeId: "n1", activePathIndex: 0 },
    { role: "assistant", body: "Hi there!", createTime: 1700000005, messageId: "m2", nodeId: "n2", activePathIndex: 1 }
  ]
};
const normalized = context.CCEChatGPTAdapter.normalize(mockDoc, { sourceUrl: "https://chatgpt.com/c/test-cid" });
assert.strictEqual(normalized.platform, "chatgpt");
assert.strictEqual(normalized.conversationId, "test-cid");
assert.strictEqual(normalized.title, "Test Title");
assert.strictEqual(normalized.messages.length, 2);
assert.strictEqual(normalized.messages[0].role, "user");
assert.strictEqual(normalized.messages[0].text, "Hello");
assert.strictEqual(normalized.messages[1].role, "assistant");
assert.strictEqual(normalized.messages[1].text, "Hi there!");

console.log("platform adapter diagnostics mock: PASS");
