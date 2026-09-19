const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const context = { console, URL, URLSearchParams };
vm.createContext(context);
for (const file of ["extension/core/platform.js", "extension/adapters/gemini.js", "extension/adapters/gemini-isolated.js"]) {
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
}

assert.strictEqual(context.CCEPlatformCore.detectPlatform("https://chatgpt.com/c/example"), "chatgpt");
assert.strictEqual(context.CCEPlatformCore.detectPlatform("https://gemini.google.com/app/example"), "gemini");
assert.strictEqual(context.CCEPlatformCore.conversationIdHint("https://gemini.google.com/app/example", "gemini"), "example");
assert.strictEqual(context.CCEPlatformCore.conversationIdHint("https://gemini.google.com/u/1/app/example", "gemini"), "example");

const possibleConversation = {
  data: {
    turns: [
      { id: "u1", role: "user", content: { text: "fixture user" } },
      { id: "a1", role: "model", content: { text: "fixture assistant" } }
    ]
  }
};
const report = context.CCEGeminiAdapter.inspectResponse(possibleConversation, "https://gemini.google.com/api", "fixture-id");
assert.strictEqual(report.possibleCandidate, true);
assert.strictEqual(report.possibleUserMessages, 1);
assert.strictEqual(report.possibleAssistantMessages, 1);
assert.strictEqual(report.completeness, "UNVERIFIED");
assert.strictEqual(report.schemaVerified, false);
assert.strictEqual(report.orderingValidated, false);
assert.ok(!report.structuralSignature.includes("fixture user"));

const incomplete = context.CCEGeminiAdapter.inspectResponse(
  { data: { turns: possibleConversation.data.turns }, has_more: true },
  "(fixture)",
  null
);
assert.strictEqual(incomplete.paginationDetected, true);
assert.strictEqual(incomplete.completeness, "INCOMPLETE");

const batchText = [")]}\'", "25", "[[\"wrb.fr\",\"rpc-a\",\"{\\\"data\\\":{\\\"turns\\\":[{\\\"role\\\":\\\"model\\\",\\\"content\\\":{\\\"text\\\":\\\"assistant\\\"}}]}}\"]]"].join(String.fromCharCode(10));
const batch = context.CCEGeminiAdapter.parseStructuredTextReport(batchText);
assert.strictEqual(batch.recognizedEnvelope, true);
assert.strictEqual(batch.lengthPrefixed, true);
assert.strictEqual(batch.payloadRecords.length, 1);
assert.strictEqual(batch.payloadRecords[0].rpcId, "rpc-a");

const aggregate = context.CCEGeminiAdapter.inspectBundle([
  { payload: { turn: { role: "user", content: { text: "u" } } }, responsePath: "/rpc/1" },
  { payload: { turn: { role: "model", content: { text: "a" } } }, responsePath: "/rpc/2" }
], "fixture-id");
assert.strictEqual(aggregate.candidateUserTurns, 1);
assert.strictEqual(aggregate.candidateAssistantTurns, 1);
assert.strictEqual(aggregate.ready, false);
assert.notStrictEqual(aggregate.completeness, "READY");

function legacyRecord(index) {
  const parentPromptId = index === 0 ? "root-prompt" : `prompt-${index}`;
  const promptId = `prompt-${index + 1}`;
  const responseId = `rc_response-${index + 1}`;
  const parentResponseId = index === 0 ? "rc-root" : `rc_response-${index}`;
  return [
    ["c_fixture", parentPromptId],
    ["c_fixture", promptId, responseId],
    [[`fixture user ${index}`, null, null, null, null]],
    [[[parentResponseId, [`fixture assistant ${index}`]]]],
    [1700000000 + index, 0]
  ];
}

const legacyPayload = [
  [legacyRecord(0), legacyRecord(1), legacyRecord(2)],
  "hNvQHb",
  null,
  []
];
const legacyReport = context.CCEGeminiAdapter.inspectResponse(legacyPayload, "/_/BardChatUi/data/batchexecute", "fixture-id", { topLevelShape: "batch" });
assert.strictEqual(legacyReport.schemaVariant, "BardChatUi-history-records");
assert.strictEqual(legacyReport.schemaVerified, true);
assert.strictEqual(legacyReport.orderingValidated, true);
assert.strictEqual(legacyReport.normalizedUserMessages, 3);
assert.strictEqual(legacyReport.normalizedAssistantMessages, 3);
assert.ok(!JSON.stringify(legacyReport).includes("fixture user"));
const legacyAggregate = context.CCEGeminiAdapter.inspectBundle([{ payload: legacyPayload, responsePath: "/_/BardChatUi/data/batchexecute", report: legacyReport }], "fixture-id");
assert.strictEqual(legacyAggregate.candidateUserTurns, 3);
assert.strictEqual(legacyAggregate.candidateAssistantTurns, 3);
assert.strictEqual(legacyAggregate.normalizedUserTurns, 3);
assert.strictEqual(legacyAggregate.normalizedAssistantTurns, 3);
assert.strictEqual(legacyAggregate.schemaVerified, true);
assert.strictEqual(legacyAggregate.orderingValidated, true);
assert.strictEqual(legacyAggregate.completeness, "UNVERIFIED");
const normalizedLegacy = context.CCEGeminiAdapter.normalizeBundle([{ payload: legacyPayload, responsePath: "/_/BardChatUi/data/batchexecute", report: legacyReport }], { conversationId: "fixture-id" });
assert.deepStrictEqual(Array.from(normalizedLegacy.messages, (message) => message.role), ["user", "assistant", "user", "assistant", "user", "assistant"]);
assert.strictEqual(normalizedLegacy.messages.length, 6);
const isolatedAggregate = context.CCEGeminiIsolatedAdapter.inspectBundle([{ payload: legacyPayload, responsePath: "/_/BardChatUi/data/batchexecute", report: legacyReport }], "fixture-id");
assert.strictEqual(isolatedAggregate.candidateUserTurns, 3);
assert.strictEqual(isolatedAggregate.candidateAssistantTurns, 3);
assert.strictEqual(isolatedAggregate.normalizedUserTurns, 3);
assert.strictEqual(isolatedAggregate.normalizedAssistantTurns, 3);
assert.strictEqual(isolatedAggregate.schemaVerified, true);
assert.strictEqual(isolatedAggregate.orderingValidated, true);

console.log("platform adapter diagnostics mock: PASS");
