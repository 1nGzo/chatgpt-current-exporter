/* Platform-neutral in-memory model. Raw payloads remain outside this model. */
(function (root) {
  "use strict";

  function normalizeMessage(message, index) {
    const source = message && typeof message === "object" ? message : {};
    const role = typeof source.role === "string" ? source.role : "other";
    return Object.freeze({
      sequence: Number.isInteger(source.sequence) ? source.sequence : index,
      role,
      text: typeof source.text === "string" ? source.text : "",
      timestamp: source.timestamp === undefined ? null : source.timestamp,
      platformMessageId: source.platformMessageId === undefined || source.platformMessageId === null ? null : String(source.platformMessageId),
      metadata: source.metadata && typeof source.metadata === "object" ? source.metadata : {}
    });
  }

  function normalizeConversation(value) {
    const source = value && typeof value === "object" ? value : {};
    const messages = Array.isArray(source.messages) ? source.messages.map(normalizeMessage) : [];
    return Object.freeze({
      platform: typeof source.platform === "string" ? source.platform : "unknown",
      conversationId: source.conversationId === undefined || source.conversationId === null ? null : String(source.conversationId),
      title: typeof source.title === "string" && source.title ? source.title : "Untitled conversation",
      sourceUrl: typeof source.sourceUrl === "string" ? source.sourceUrl : "(unavailable)",
      capturedAt: typeof source.capturedAt === "string" ? source.capturedAt : null,
      messages: Object.freeze(messages),
      metadata: source.metadata && typeof source.metadata === "object" ? source.metadata : {}
    });
  }

  root.CCEConversationCore = Object.freeze({ normalizeConversation, normalizeMessage });
})(globalThis);
