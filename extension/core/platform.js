/* Small platform registry shared by the page-world observer and content UI. */
(function (root) {
  "use strict";

  const DEFINITIONS = Object.freeze({
    chatgpt: Object.freeze({ id: "chatgpt", label: "ChatGPT", hosts: ["chatgpt.com", "chat.openai.com"] }),
    gemini: Object.freeze({ id: "gemini", label: "Gemini", hosts: ["gemini.google.com"] })
  });

  function parseUrl(value) {
    try {
      return new URL(value || root.location && root.location.href);
    } catch (_) {
      return null;
    }
  }

  function detectPlatform(value) {
    const url = parseUrl(value);
    const hostname = url ? url.hostname.toLowerCase() : "";
    for (const definition of Object.values(DEFINITIONS)) {
      if (definition.hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))) {
        return definition.id;
      }
    }
    return "unsupported";
  }

  function sourceUrl(value) {
    const url = parseUrl(value);
    return url ? `${url.origin}${url.pathname}` : "(unavailable)";
  }

  function decodeSegment(value) {
    try {
      return decodeURIComponent(value);
    } catch (_) {
      return value;
    }
  }

  function conversationIdHint(value, platform) {
    const url = parseUrl(value);
    if (!url) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (platform === "chatgpt") {
      const index = parts.lastIndexOf("c");
      return index >= 0 && parts[index + 1] ? decodeSegment(parts[index + 1]) : null;
    }
    if (platform === "gemini" && parts[0] === "app" && parts[1]) {
      return decodeSegment(parts[1]);
    }
    return null;
  }

  function definition(platform) {
    return DEFINITIONS[platform] || Object.freeze({ id: "unsupported", label: "Unsupported", hosts: [] });
  }

  root.CCEPlatformCore = Object.freeze({
    definitions: DEFINITIONS,
    parseUrl,
    detectPlatform,
    sourceUrl,
    conversationIdHint,
    definition
  });
})(globalThis);
