const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const context = { console, URL, URLSearchParams };
vm.createContext(context);
for (const file of ["extension/core/platform.js", "extension/adapters/gemini.js"]) {
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
}

assert.strictEqual(context.CCEPlatformCore.detectPlatform("https://chatgpt.com/c/example"), "chatgpt");
assert.strictEqual(context.CCEPlatformCore.detectPlatform("https://gemini.google.com/app/example"), "gemini");
assert.strictEqual(context.CCEPlatformCore.conversationIdHint("https://gemini.google.com/u/1/app/example", "gemini"), "example");
const batchFrames = context.CCEGeminiAdapter.parseStructuredText(")]}'\n[[\"fixture\",{\"role\":\"user\"}]]");
assert.strictEqual(batchFrames.length, 1);
const lengthPrefixed = context.CCEGeminiAdapter.parseStructuredTextReport(")]}'\n42\n[[\"wrb.fr\",\"hNvQHb\",\"[{\\\"role\\\":\\\"user\\\"},{\\\"role\\\":\\\"model\\\"}]\"]]");
assert.strictEqual(lengthPrefixed.frameCount, 1);
assert.strictEqual(lengthPrefixed.innerPayloads, 1);
assert.deepStrictEqual(Array.from(lengthPrefixed.rpcIds), ["hNvQHb"]);
assert.strictEqual(lengthPrefixed.payloads.length, 1);
assert.strictEqual(lengthPrefixed.payloadRecords[0].rpcId, "hNvQHb");
const structuredBatchReport = context.CCEGeminiAdapter.inspectResponse(
  [[[["prompt text"], 1], ["rc_answer", ["assistant text"]]]],
  "https://gemini.google.com/u/1/_/BardChatUi/data/batchexecute",
  "example"
);
assert.strictEqual(structuredBatchReport.possibleCandidate, true);
assert.strictEqual(structuredBatchReport.possibleUserMessages, 1);
assert.strictEqual(structuredBatchReport.possibleAssistantMessages, 1);
assert.strictEqual(structuredBatchReport.possibleTurnCount, 1);
const batchReport = context.CCEGeminiAdapter.inspectResponse(
  [["wrb.fr", "[{\"role\":\"user\"},{\"role\":\"model\"}]"]],
  "https://gemini.google.com/u/1/_/BardChatUi/data/batchexecute",
  "example"
);
assert.strictEqual(batchReport.possibleCandidate, true);
assert.strictEqual(batchReport.possibleUserMessages, 1);
assert.strictEqual(batchReport.possibleAssistantMessages, 1);

const possibleConversation = {
  data: {
    turns: [
      { role: "user", content: { text: "fixture user" } },
      { role: "model", content: { text: "fixture assistant" } }
    ]
  }
};
const report = context.CCEGeminiAdapter.inspectResponse(possibleConversation, "https://gemini.google.com/api", "fixture-id");
assert.strictEqual(report.possibleCandidate, true);
assert.strictEqual(report.possibleUserMessages, 1);
assert.strictEqual(report.possibleAssistantMessages, 1);
assert.strictEqual(report.completeness, "UNKNOWN");
assert.deepStrictEqual(Array.from(report.topLevelKeys), ["data"]);

const incomplete = context.CCEGeminiAdapter.inspectResponse({ data: { turns: possibleConversation.data.turns }, has_more: true }, "(fixture)", null);
assert.strictEqual(incomplete.paginationDetected, true);
assert.strictEqual(incomplete.completeness, "INCOMPLETE");

console.log("platform adapter diagnostics mock: PASS");
