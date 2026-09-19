/* ChatGPT adapter boundary. mapping/current_node remains in converter.js. */
(function (root) {
  "use strict";

  function hasMapping(value) {
    return Boolean(value && typeof value === "object" && value.mapping && typeof value.mapping === "object" && !Array.isArray(value.mapping));
  }

  function hasMessageList(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.messages) && value.messages.length > 0 && value.current_node !== undefined && value.current_node !== null && value.current_node !== "" && (value.conversation_id || value.id));
  }

  function isConversationCandidate(value) {
    return hasMapping(value) || hasMessageList(value);
  }

  function normalize(document, metadata) {
    const core = root.CCEConversationCore;
    if (!core || !document) return null;
    return core.normalizeConversation({
      platform: "chatgpt",
      conversationId: document.conversationId,
      title: document.title,
      sourceUrl: metadata && metadata.sourceUrl,
      capturedAt: metadata && metadata.capturedAt,
      messages: (document.messages || []).map((message, sequence) => ({
        sequence,
        role: message.role,
        text: message.body,
        timestamp: message.createTime,
        platformMessageId: message.messageId,
        metadata: { nodeId: message.nodeId, activePathIndex: message.activePathIndex }
      }))
    });
  }

  root.CCEChatGPTAdapter = Object.freeze({
    id: "chatgpt",
    isConversationCandidate,
    normalize,
    activePathSource: "mapping.current_node.parent",
    get navigator() {
      return root.CCEChatGPTNavigator || null;
    }
  });
})(globalThis);
