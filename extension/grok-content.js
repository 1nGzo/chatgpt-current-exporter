(function () {
  "use strict";
  const converter = globalThis.CCEConversationConverter;
  const adapter = globalThis.CCEGrokAdapter;
  const namingReady = fetch(chrome.runtime.getURL("naming.local.json"), { cache: "no-store" })
    .then(r => r.ok ? r.json() : null).then(c => { if (c?.series_rules) converter.setNamingRules(c.series_rules); }).catch(() => {});
  let pending = null;
  let pendingUrl = null;
  function capture() {
    if (!pending || pendingUrl !== location.href) {
      pendingUrl = location.href;
      const operation = adapter.capture({ url: pendingUrl, document, fetch, currentUrl: () => location.href })
        .finally(() => { if (pending === operation) { pending = null; pendingUrl = null; } });
      pending = operation;
    }
    return pending;
  }
  function snapshot(value) {
    return { extension: true, platform: "grok", platformLabel: "Grok", state: value.metadata.source === "api" ? "Ready" : "Review",
      captured: true, conversationId: value.conversationId, title: value.title, capturedAt: value.capturedAt,
      mappingNodes: value.messages.length, activePathNodes: value.messages.length, activePathMessages: value.messages.length,
      rawJsonSize: JSON.stringify(value).length, incompleteReasons: [], warningSummary: value.metadata.warning,
      diagnostics: { ...value.metadata.diagnostics, platform: "grok", platformLabel: "Grok",
        readyReason: value.metadata.warning || "Grok API transcript", completeness: value.metadata.source === "api" ? "API" : "DOM_PARTIAL" } };
  }
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (!["GET_STATUS", "RESCAN_CURRENT", "EXPORT_CURRENT"].includes(message?.type)) return false;
    (async () => {
      const value = await capture();
      if (message.type !== "EXPORT_CURRENT") return snapshot(value);
      await namingReady;
      if (location.href !== value.sourceUrl) throw Error("会话已切换，请重新导出");
      const stem = converter.filenameStem(value.title, value.conversationId || "grok-conversation");
      const rendered = converter.renderNormalized(value);
      converter.downloadText(`${stem}.raw.json`, JSON.stringify(value, null, 2) + "\n", "application/json");
      setTimeout(() => converter.downloadText(`${stem}.md`, rendered.markdown, "text/markdown"), 300);
      return { ok: true, files: [`${stem}.raw.json`, `${stem}.md`], warning: value.metadata.warning };
    })().then(respond).catch(error => respond(message.type === "EXPORT_CURRENT" ? { ok: false, error: error.message } : {
      extension: true, platform: "grok", platformLabel: "Grok", state: "Error", captured: false,
      conversationId: adapter.conversationId(location.href), incompleteReasons: [error.message],
      diagnostics: { injected: true, conversationId: adapter.conversationId(location.href),
        ...error.diagnostics, readyReason: error.message } }));
    return true;
  });
})();
