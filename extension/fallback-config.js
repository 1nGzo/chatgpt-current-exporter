/* The only place where verified same-origin fallback paths are configured. */
(function (root) {
  root.CCEFallbackConfig = Object.freeze({
    enabled: true,
    method: "GET",
    endpoints: Object.freeze([
      Object.freeze({ name: "conversations-plural", pathTemplate: "/backend-api/conversations/{conversationId}" }),
      Object.freeze({ name: "conversation-singular", pathTemplate: "/backend-api/conversation/{conversationId}" })
    ]),
    reason: "The plural path was observed in the target page; the singular path is retained for compatibility with prior API-first exporters.",
    extractConversationId(value) {
      try {
        const pathname = new URL(String(value), root.location && root.location.href).pathname;
        const match = /^\/backend-api\/conversations?\/([^/]+)(?:\/messages)?$/.exec(pathname);
        return match ? decodeURIComponent(match[1]) : null;
      } catch (_) {
        return null;
      }
    },
    classifyPath(value) {
      try {
        const pathname = new URL(String(value), root.location && root.location.href).pathname;
        return /\/messages$/.test(pathname) ? "conversation-messages" : "conversation";
      } catch (_) {
        return "unknown";
      }
    },
    buildPaths(conversationId) {
      return this.endpoints.map((endpoint) => ({
        name: endpoint.name,
        path: endpoint.pathTemplate.replace("{conversationId}", encodeURIComponent(String(conversationId)))
      }));
    },
    buildPath(conversationId) {
      return this.buildPaths(conversationId)[0].path;
    }
  });
})(globalThis);
