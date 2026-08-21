/* Platform-neutral in-memory conversation shape. Raw payloads stay separate. */
(function (root) {
  "use strict";

  function normalizeMessage(message, index) {
    const role = message && typeof message.role === "string" ? message.role : "other";
    return Object.freeze({
      sequence: Number.isInteger(message && message.sequence) ? message.sequence : index,
      role,
      text: message && typeof message.text === "string" ? message.text : "",
      timestamp: message ? message.timestamp ?? null : null,
      platformMessageId: message && message.platformMessageId !== undefined ? String(message.platformMessageId) : null,
      metadata: message && message.metadata && typeof message.metadata === "object" ? message.metadata : {}
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
