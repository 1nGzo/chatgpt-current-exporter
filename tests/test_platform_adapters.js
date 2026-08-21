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
assert.strictEqual(context.CCEPlatformCore.conversationIdHint("https://gemini.google.com/app/example", "gemini"), "example");

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
