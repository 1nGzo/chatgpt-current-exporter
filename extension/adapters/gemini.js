/* Gemini discovery adapter. It reports structure only until a live schema is verified. */
(function (root) {
  "use strict";

  const MAX_NODES = 1800;
  const MAX_DEPTH = 8;
  const ID_KEYS = new Set(["conversation_id", "conversationid", "chat_id", "chatid", "thread_id", "threadid"]);
  const PAGINATION_KEYS = new Set(["has_more", "hasmore", "next_cursor", "nextcursor", "next_page", "nextpage", "cursor", "truncated", "partial"]);
  const TURN_KEY_HINT = /turn|message|candidate|prompt|response|content/i;

  function objectKeys(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).slice(0, 80) : [];
  }

  function normalizedKey(value) {
    return String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function roleOf(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const author = value.author && typeof value.author === "object" ? value.author : null;
    const candidates = [value.role, value.speaker, value.sender, author && author.role, author && author.name];
    for (const candidate of candidates) {
      if (typeof candidate !== "string") continue;
      const role = candidate.toLowerCase();
      if (role === "user" || role === "human") return "user";
      if (role === "assistant" || role === "model" || role === "gemini") return "assistant";
    }
    return null;
  }

  function stringLeaves(value, output = []) {
    if (output.length >= 80) return output;
    if (typeof value === "string") {
      if (value.trim()) output.push(value);
      return output;
    }
    if (Array.isArray(value)) {
      value.slice(0, 80).forEach((item) => stringLeaves(item, output));
    }
    return output;
  }

  function looksLikeInternalId(value) {
    return /^(?:c_|rc_|r_)[A-Za-z0-9_-]{6,}$/.test(String(value || "").trim());
  }

  function isGeminiUserNode(value) {
    if (!Array.isArray(value) || value.length < 2 || !Array.isArray(value[0]) || typeof value[1] !== "number") return false;
    if (value[1] !== 1 && value[1] !== 2) return false;
    return stringLeaves(value[0]).some((item) => !looksLikeInternalId(item));
  }

  function isGeminiAssistantNode(value) {
    if (!Array.isArray(value) || value.length < 2 || typeof value[0] !== "string" || !Array.isArray(value[1])) return false;
    return /^(?:rc_|r_|response[_-])/i.test(value[0]);
  }

  function likelyTurnItem(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return Boolean(roleOf(value)) || objectKeys(value).some((key) => TURN_KEY_HINT.test(key));
  }

  function addParsedString(queue, value, depth, path) {
    if (typeof value !== "string" || value.length < 2 || value.length > 1_000_000) return;
    const trimmed = value.trim();
    if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") queue.push({ value: parsed, depth: depth + 1, path: `${path}.$json` });
    } catch (_) {
      // Most text fields are not JSON; discovery must remain non-fatal.
    }
  }

  function parseJsonCandidates(text) {
    const raw = String(text || "").replace(/^\uFEFF/, "");
    const stripped = raw.replace(/^\s*\)\]\}',?\s*/, "").trim();
    const candidates = [stripped];
    if (stripped !== raw.trim()) candidates.push(raw.trim());
    const lines = stripped.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      candidates.push(line);
      candidates.push(line.replace(/^\d+\s*/, ""));
    }
    const firstArray = stripped.indexOf("[");
    const lastArray = stripped.lastIndexOf("]");
    if (firstArray >= 0 && lastArray > firstArray) candidates.push(stripped.slice(firstArray, lastArray + 1));

    const seen = new Set();
    const parsed = [];
    for (const candidate of candidates) {
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      try {
        parsed.push(JSON.parse(candidate));
      } catch (_) {
        // Try the next known batch framing variant without retaining text.
      }
    }
    return parsed;
  }

  function parseBatchExecute(text) {
    const raw = String(text || "").replace(/^\uFEFF/, "");
    const stripped = raw.replace(/^\s*\)\]\}',?\s*/, "").trim();
    const lines = stripped.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const payloads = [];
    const rpcIds = new Set();
    let frameCount = 0;
    let innerPayloads = 0;
    let parseFailures = 0;
    let lengthPrefixed = false;
    let recognizedEnvelope = false;

    for (let index = 0; index < lines.length;) {
      let line = lines[index++];
      if (/^\d+$/.test(line) && index < lines.length) {
        lengthPrefixed = true;
        line = lines[index++];
      }
      let segment;
      try {
        segment = JSON.parse(line);
      } catch (_) {
        parseFailures += 1;
        continue;
      }
      frameCount += 1;
      const entries = Array.isArray(segment)
        ? segment.filter((entry) => Array.isArray(entry) && entry[0] === "wrb.fr")
        : [];
      if (!entries.length) {
        payloads.push(segment);
        continue;
      }
      recognizedEnvelope = true;
      for (const entry of entries) {
        const rpcId = typeof entry[1] === "string" ? entry[1] : "";
        if (rpcId) rpcIds.add(rpcId);
        const nested = entry[2];
        if (typeof nested === "string") {
          try {
            payloads.push(JSON.parse(nested));
            innerPayloads += 1;
          } catch (_) {
            parseFailures += 1;
          }
        } else if (nested && typeof nested === "object") {
          payloads.push(nested);
          innerPayloads += 1;
        }
      }
    }
    return {
      payloads,
      frameCount,
      innerPayloads,
      parseFailures,
      lengthPrefixed,
      recognizedEnvelope,
      rpcIds: Array.from(rpcIds).slice(0, 40)
    };
  }

  function parseStructuredTextReport(text) {
    const batch = parseBatchExecute(text);
    if (batch.lengthPrefixed || batch.recognizedEnvelope) return batch;
    const payloads = parseJsonCandidates(text);
    return {
      payloads,
      frameCount: payloads.length,
      innerPayloads: 0,
      parseFailures: payloads.length ? 0 : 1,
      lengthPrefixed: false,
      recognizedEnvelope: false,
      rpcIds: []
    };
  }

  function parseStructuredText(text) {
    return parseStructuredTextReport(text).payloads;
  }

  function inspectResponse(payload, responsePath, urlHint) {
    const queue = [{ value: payload, depth: 0, path: "$" }];
    const seen = new Set();
    const topLevelKeys = objectKeys(payload);
    const fieldHints = new Set();
    let nodesVisited = 0;
    let maxDepth = 0;
    let wrapperDepth = null;
    let possibleTurnCount = 0;
    let possibleUserMessages = 0;
    let possibleAssistantMessages = 0;
    let structuredUserMessages = 0;
    let structuredAssistantMessages = 0;
    let conversationId = urlHint || null;
    let paginationDetected = false;
    const paginationSignals = new Set();

    while (queue.length && nodesVisited < MAX_NODES) {
      const current = queue.shift();
      const value = current.value;
      if (!value || typeof value !== "object" || seen.has(value) || current.depth > MAX_DEPTH) continue;
      seen.add(value);
      nodesVisited += 1;
      maxDepth = Math.max(maxDepth, current.depth);
      const structuredUser = isGeminiUserNode(value);
      const structuredAssistant = isGeminiAssistantNode(value);
      if (structuredUser) {
        structuredUserMessages += 1;
        possibleUserMessages += 1;
        fieldHints.add("gemini-user-node");
        if (wrapperDepth === null) wrapperDepth = current.depth;
      }
      if (structuredAssistant) {
        structuredAssistantMessages += 1;
        possibleAssistantMessages += 1;
        fieldHints.add("gemini-assistant-node");
        if (wrapperDepth === null) wrapperDepth = current.depth;
      }
      if (Array.isArray(value)) {
        value.slice(0, 80).forEach((item, index) => {
          if (item && typeof item === "object") {
            queue.push({ value: item, depth: current.depth + 1, path: `${current.path}[${index}]` });
          } else {
            addParsedString(queue, item, current.depth, `${current.path}[${index}]`);
          }
        });
        continue;
      }
      const keys = objectKeys(value);
      for (const key of keys) {
        const normalized = normalizedKey(key);
        if (TURN_KEY_HINT.test(key)) fieldHints.add(key);
        if (PAGINATION_KEYS.has(normalized)) {
          const item = value[key];
          if (item === true || (item !== null && item !== undefined && item !== "" && item !== false)) {
            paginationDetected = true;
            paginationSignals.add(key);
          }
        }
        if (!conversationId && ID_KEYS.has(normalized) && typeof value[key] === "string" && value[key].length < 256) conversationId = value[key];
        const child = value[key];
        if (Array.isArray(child)) {
          const turnItems = child.filter(likelyTurnItem);
          if (turnItems.length) {
            possibleTurnCount += turnItems.length;
            if (wrapperDepth === null) wrapperDepth = current.depth + 1;
          }
          child.slice(0, 80).forEach((item, index) => queue.push({ value: item, depth: current.depth + 1, path: `${current.path}.${key}[${index}]` }));
        } else if (child && typeof child === "object") {
          queue.push({ value: child, depth: current.depth + 1, path: `${current.path}.${key}` });
        } else {
          addParsedString(queue, child, current.depth, `${current.path}.${key}`);
        }
      }
      const ownRole = roleOf(value);
      if (ownRole === "user") possibleUserMessages += 1;
      if (ownRole === "assistant") possibleAssistantMessages += 1;
    }

    const possibleCandidate = possibleUserMessages > 0 && possibleAssistantMessages > 0;
    return {
      responsePath: responsePath || "(unavailable)",
      topLevelKeys,
      wrapperDepth,
      maxDepth,
      nodesVisited,
      fieldHints: Array.from(fieldHints).slice(0, 40),
      possibleTurnCount: Math.max(possibleTurnCount, Math.min(structuredUserMessages, structuredAssistantMessages)),
      possibleUserMessages,
      possibleAssistantMessages,
      conversationId,
      possibleCandidate,
      paginationDetected,
      paginationSignals: Array.from(paginationSignals).slice(0, 20),
      completeness: paginationDetected ? "INCOMPLETE" : "UNKNOWN",
      schemaVerified: false
    };
  }

  root.CCEGeminiAdapter = Object.freeze({
    id: "gemini",
    parseStructuredText,
    parseStructuredTextReport,
    inspectResponse,
    schemaVerified: false,
    exportSupported: false
  });
})(globalThis);
