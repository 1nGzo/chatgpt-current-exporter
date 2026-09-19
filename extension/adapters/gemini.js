/*
 * Gemini structural adapter.
 *
 * This file deliberately separates safe shape discovery from conversation
 * reconstruction. A report contains keys, counts, paths and signatures only;
 * it never contains message text. Parsed payloads are returned separately so
 * the user can explicitly save a local debug bundle when needed.
 */
(function (root) {
  "use strict";

  const MAX_NODES = 4000;
  const MAX_DEPTH = 12;
  const MAX_ARRAY_ITEMS = 300;
  const MAX_KEYS = 80;
  const ID_KEYS = new Set(["conversationid", "conversation_id", "chatid", "chat_id", "threadid", "thread_id", "sessionid", "session_id"]);
  const PAGINATION_KEYS = new Set(["hasmore", "has_more", "hasmoremessages", "has_more_messages", "nextcursor", "next_cursor", "nextpage", "next_page", "pagetoken", "page_token", "continuation", "continuationtoken"]);
  const TRUNCATION_KEYS = new Set(["truncated", "istruncated", "is_truncated", "partial", "ispartial", "is_partial", "incomplete"]);
  const BRANCH_KEYS = new Set(["candidate", "candidates", "alternate", "alternates", "branch", "branches", "regenerate", "regenerated", "selectedcandidate", "selected_candidate"]);
  const TURN_KEY_HINT = /turn|message|candidate|prompt|response|content|history|conversation/i;
  const INTERNAL_ID = /^(?:c_|rc_|r_|response[_-])?[A-Za-z0-9_-]{6,}$/;

  function isObject(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  }

  function objectKeys(value) {
    return isObject(value) ? Object.keys(value).slice(0, MAX_KEYS) : [];
  }

  function normalizedKey(value) {
    return String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function topLevelShape(value) {
    if (Array.isArray(value)) return "array";
    if (isObject(value)) return "object";
    if (typeof value === "string") return "string";
    if (value === null) return "null";
    return typeof value;
  }

  function safeString(value) {
    return typeof value === "string" ? value : "";
  }

  function roleOf(value) {
    if (!isObject(value)) return null;
    const author = isObject(value.author) ? value.author : null;
    const sender = isObject(value.sender) ? value.sender : null;
    const candidates = [value.role, value.speaker, value.sender, value.type, value.actor, author && author.role, author && author.name, sender && sender.role, sender && sender.name];
    for (const candidate of candidates) {
      if (typeof candidate !== "string") continue;
      const role = candidate.toLowerCase();
      if (["user", "human", "prompt", "you"].includes(role)) return "user";
      if (["assistant", "model", "gemini", "bot", "ai", "bard", "response"].includes(role)) return "assistant";
    }
    return null;
  }

  function stringLeaves(value, output = [], seen = new Set(), depth = 0) {
    if (output.length >= 80 || depth > 8 || value === null || value === undefined) return output;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed && !INTERNAL_ID.test(trimmed)) output.push(value);
      return output;
    }
    if (typeof value !== "object" || seen.has(value)) return output;
    seen.add(value);
    if (Array.isArray(value)) {
      value.slice(0, MAX_ARRAY_ITEMS).forEach((item) => stringLeaves(item, output, seen, depth + 1));
    } else {
      for (const key of Object.keys(value).slice(0, MAX_KEYS)) {
        if (["id", "uuid", "timestamp", "create_time", "update_time", "url", "href"].includes(normalizedKey(key))) continue;
        stringLeaves(value[key], output, seen, depth + 1);
      }
    }
    return output;
  }

  function textLike(value) {
    return stringLeaves(value, []).length > 0;
  }

  function textSegments(value, output = [], seen = new Set(), depth = 0) {
    if (output.length >= 200 || depth > 16 || value === null || value === undefined) return output;
    if (typeof value === "string") {
      if (value.length > 0) output.push(value);
      return output;
    }
    if (typeof value !== "object" || seen.has(value)) return output;
    seen.add(value);
    if (Array.isArray(value)) {
      value.slice(0, MAX_ARRAY_ITEMS).forEach((item) => textSegments(item, output, seen, depth + 1));
    }
    return output;
  }

  function joinTextSegments(value) {
    const parts = textSegments(value, []);
    return parts.length ? parts.join("") : "";
  }

  function stringAt(value, path) {
    let current = value;
    for (const index of path) {
      if (current === null || current === undefined) return "";
      current = current[index];
    }
    return typeof current === "string" ? current : "";
  }

  function legacyRecordShape(value) {
    return Boolean(
      Array.isArray(value) &&
      value.length >= 4 &&
      Array.isArray(value[0]) &&
      Array.isArray(value[1]) &&
      Array.isArray(value[2]) &&
      Array.isArray(value[3]) &&
      Array.isArray(value[2][0]) &&
      Array.isArray(value[3][0]) &&
      Array.isArray(value[3][0][0]) &&
      (Array.isArray(value[3][0][0][1]) || typeof value[3][0][0][1] === "string")
    );
  }

  function legacyUserText(record) {
    const direct = stringAt(record, [2, 0, 0]);
    if (direct) return direct;
    return "";
  }

  function legacyAssistantText(record) {
    return joinTextSegments(record && record[3] && record[3][0] && record[3][0][0] ? record[3][0][0][1] : null);
  }

  function legacyRecordIds(record) {
    const parentMessageId = stringAt(record, [0, 1]) || null;
    const messageId = stringAt(record, [1, 1]) || parentMessageId;
    const responseId = stringAt(record, [1, 2]) || stringAt(record, [3, 0, 0, 0]) || null;
    const parentResponseId = stringAt(record, [3, 0, 0, 0]) || null;
    return { parentMessageId, messageId, responseId, parentResponseId };
  }

  function legacyTimestamp(record) {
    const value = record && record[4];
    return Array.isArray(value) ? value.slice(0, 2) : value === undefined ? null : value;
  }

  function extractLegacyConversation(payload, urlHint) {
    if (!Array.isArray(payload) || !Array.isArray(payload[0])) return null;
    const rawRecords = payload[0];
    const records = rawRecords.filter(legacyRecordShape);
    if (!records.length) return null;
    const turns = records.map((record, index) => {
      const ids = legacyRecordIds(record);
      const userText = legacyUserText(record);
      const assistantText = legacyAssistantText(record);
      return {
        nativeIndex: index,
        user: {
          role: "user",
          text: userText || "[This turn includes non-text content]",
          platformMessageId: ids.messageId,
          timestamp: legacyTimestamp(record),
          metadata: { native_record_index: index, parent_message_id: ids.parentMessageId }
        },
        assistant: {
          role: "assistant",
          text: assistantText,
          platformMessageId: ids.responseId,
          timestamp: legacyTimestamp(record),
          metadata: { native_record_index: index, parent_response_id: ids.parentResponseId }
        },
        hasUserText: Boolean(userText),
        hasAssistantText: Boolean(assistantText),
        ids
      };
    });
    const messageLinksValidated = turns.length < 2 || turns.slice(1).every((turn, index) => {
      const previous = turns[index];
      return Boolean(turn.ids.parentMessageId && previous.ids.messageId && turn.ids.parentMessageId === previous.ids.messageId);
    });
    const responseLinksValidated = turns.length < 2 || turns.slice(1).every((turn, index) => {
      const previous = turns[index];
      return Boolean(turn.ids.parentResponseId && previous.ids.responseId && turn.ids.parentResponseId === previous.ids.responseId);
    });
    const orderingValidated = messageLinksValidated && responseLinksValidated;
    const schemaVerified = records.length === rawRecords.length && turns.every((turn) => turn.hasUserText && turn.hasAssistantText);
    const messages = [];
    const candidateMessageKeys = [];
    turns.forEach((turn, index) => {
      if (turn.user.text) {
        messages.push({ ...turn.user, sequence: messages.length });
        candidateMessageKeys.push({ role: "user", id: turn.user.platformMessageId, path: `$[0][${index}][2][0][0]` });
      }
      if (turn.assistant.text) {
        messages.push({ ...turn.assistant, sequence: messages.length });
        candidateMessageKeys.push({ role: "assistant", id: turn.assistant.platformMessageId, path: `$[0][${index}][3][0][0][1]` });
      }
    });
    const userCount = turns.filter((turn) => turn.user.text).length;
    const assistantCount = turns.filter((turn) => turn.assistant.text).length;
    const countImbalance = Math.abs(userCount - assistantCount) > 1;
    return {
      schemaVariant: "BardChatUi-history-records",
      conversationId: urlHint || stringAt(payload, [1]) || null,
      records,
      turns,
      messages,
      candidateMessageKeys,
      possibleTurnCount: userCount + assistantCount,
      possibleUserMessages: userCount,
      possibleAssistantMessages: assistantCount,
      normalizedUserMessages: messages.filter((message) => message.role === "user").length,
      normalizedAssistantMessages: messages.filter((message) => message.role === "assistant").length,
      messageLinksValidated,
      responseLinksValidated,
      orderingValidated,
      schemaVerified,
      countImbalance,
      possibleCandidate: true,
      completeness: countImbalance || !schemaVerified ? "INCOMPLETE" : "UNVERIFIED"
    };
  }

  function isGeminiUserNode(value) {
    if (!Array.isArray(value) || value.length < 2 || !Array.isArray(value[0]) || typeof value[1] !== "number") return false;
    return value[1] === 1 || value[1] === 2 ? textLike(value[0]) : false;
  }

  function isGeminiAssistantNode(value) {
    if (!Array.isArray(value) || value.length < 2 || typeof value[0] !== "string" || !Array.isArray(value[1])) return false;
    return /^(?:rc_|r_|response[_-])/i.test(value[0]);
  }

  function candidateId(value) {
    if (!isObject(value)) return null;
    for (const key of ["id", "message_id", "messageId", "turn_id", "turnId", "response_id", "responseId", "uuid"]) {
      if (value[key] !== undefined && value[key] !== null && String(value[key])) return String(value[key]);
    }
    return null;
  }

  function likelyTurnObject(value) {
    if (!isObject(value)) return false;
    if (roleOf(value)) return true;
    return objectKeys(value).some((key) => TURN_KEY_HINT.test(key)) && textLike(value);
  }

  function structuredSignature(value, depth = 0, seen = new Set()) {
    if (depth > 5) return "…";
    if (value === null) return "null";
    if (Array.isArray(value)) {
      const sample = value.slice(0, 4).map((item) => structuredSignature(item, depth + 1, seen)).join(",");
      return `array[${value.length}](${sample})`;
    }
    if (!isObject(value)) return typeof value;
    if (seen.has(value)) return "cycle";
    seen.add(value);
    const keys = Object.keys(value).slice(0, 24).sort();
    return `object{${keys.map((key) => `${key}:${structuredSignature(value[key], depth + 1, seen)}`).join(",")}}`;
  }

  function addParsedString(queue, value, depth, path) {
    if (typeof value !== "string" || value.length < 2 || value.length > 2_000_000) return;
    const trimmed = value.trim();
    if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") queue.push({ value: parsed, depth: depth + 1, path: `${path}.$json` });
    } catch (_) {
      // Ordinary text fields are expected to fail this probe.
    }
  }

  function parseJsonCandidates(text) {
    const raw = String(text || "").replace(/^\uFEFF/, "");
    const stripped = raw.replace(/^\s*\)\]\}',?\s*/, "").trim();
    const candidates = [stripped];
    const lines = stripped.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      candidates.push(line);
      candidates.push(line.replace(/^\d+\s*/, ""));
    }
    const firstArray = stripped.indexOf("[");
    const lastArray = stripped.lastIndexOf("]");
    if (firstArray >= 0 && lastArray > firstArray) candidates.push(stripped.slice(firstArray, lastArray + 1));
    const seen = new Set();
    const payloads = [];
    for (const candidate of candidates) {
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      try {
        payloads.push(JSON.parse(candidate));
      } catch (_) {
        // Try the next framing candidate.
      }
    }
    return payloads;
  }

  function parseBatchExecute(text) {
    const raw = String(text || "").replace(/^\uFEFF/, "");
    const stripped = raw.replace(/^\s*\)\]\}',?\s*/, "").trim();
    const lines = stripped.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const payloadRecords = [];
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
      const entries = Array.isArray(segment) ? segment.filter((entry) => Array.isArray(entry) && entry[0] === "wrb.fr") : [];
      if (!entries.length) {
        payloadRecords.push({ payload: segment, rpcId: "", frameIndex: frameCount - 1 });
        continue;
      }
      recognizedEnvelope = true;
      for (const entry of entries) {
        const rpcId = typeof entry[1] === "string" ? entry[1] : "";
        if (rpcId) rpcIds.add(rpcId);
        const nested = entry[2];
        if (typeof nested === "string") {
          try {
            payloadRecords.push({ payload: JSON.parse(nested), rpcId, frameIndex: frameCount - 1 });
            innerPayloads += 1;
          } catch (_) {
            parseFailures += 1;
          }
        } else if (nested && typeof nested === "object") {
          payloadRecords.push({ payload: nested, rpcId, frameIndex: frameCount - 1 });
          innerPayloads += 1;
        }
      }
    }
    return {
      payloadRecords,
      payloads: payloadRecords.map((record) => record.payload),
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
    if (batch.lengthPrefixed || batch.recognizedEnvelope) return { ...batch, topLevelShape: "batch" };
    const payloads = parseJsonCandidates(text);
    return {
      payloadRecords: payloads.map((payload, index) => ({ payload, rpcId: "", frameIndex: index })),
      payloads,
      frameCount: payloads.length,
      innerPayloads: 0,
      parseFailures: payloads.length ? 0 : 1,
      lengthPrefixed: false,
      recognizedEnvelope: false,
      rpcIds: [],
      topLevelShape: payloads.length ? topLevelShape(payloads[0]) : "unknown"
    };
  }

  function parseStructuredText(text) {
    return parseStructuredTextReport(text).payloads;
  }

  function reportCandidate(record, path, role, text) {
    return {
      role,
      id: record && record.id ? record.id : null,
      path,
      textAvailable: Boolean(text),
      textParts: text ? text.length : 0
    };
  }

  function inspectResponse(payload, responsePath, urlHint, options = {}) {
    const queue = [{ value: payload, depth: 0, path: "$" }];
    const seen = new Set();
    const candidates = [];
    const candidateKeys = new Set();
    const fieldHints = new Set();
    const paginationSignals = new Set();
    const truncationSignals = new Set();
    const branchSignals = new Set();
    let nodesVisited = 0;
    let maxDepth = 0;
    let wrapperDepth = null;
    let conversationId = typeof urlHint === "string" ? urlHint : null;
    let paginationPossible = false;
    let branchSelection = "NONE_DETECTED";
    const legacy = extractLegacyConversation(payload, urlHint);

    function addCandidate(record, path, role, text) {
      const id = record && record.id ? record.id : null;
      const key = id ? `${role}:${id}` : `${role}:${path}`;
      if (candidateKeys.has(key)) return;
      candidateKeys.add(key);
      candidates.push(reportCandidate({ id }, path, role, text));
    }

    while (queue.length && nodesVisited < MAX_NODES) {
      const current = queue.shift();
      const value = current.value;
      if (value === null || value === undefined || seen.has(value) || current.depth > MAX_DEPTH) continue;
      if (typeof value !== "object") continue;
      seen.add(value);
      nodesVisited += 1;
      maxDepth = Math.max(maxDepth, current.depth);
      if (wrapperDepth === null && (isGeminiUserNode(value) || isGeminiAssistantNode(value))) wrapperDepth = current.depth;

      if (Array.isArray(value)) {
        if (isGeminiUserNode(value)) addCandidate({ id: null }, current.path, "user", stringLeaves(value[0], []));
        if (isGeminiAssistantNode(value)) addCandidate({ id: value[0] }, current.path, "assistant", stringLeaves(value[1], []));
        value.slice(0, MAX_ARRAY_ITEMS).forEach((item, index) => {
          if (item && typeof item === "object") queue.push({ value: item, depth: current.depth + 1, path: `${current.path}[${index}]` });
          else addParsedString(queue, item, current.depth, `${current.path}[${index}]`);
        });
        continue;
      }

      const role = roleOf(value);
      const text = textLike(value) ? stringLeaves(value, []) : [];
      if (role) addCandidate({ id: candidateId(value) }, current.path, role, text);
      const keys = objectKeys(value);
      for (const key of keys) {
        const normalized = normalizedKey(key);
        if (TURN_KEY_HINT.test(key)) fieldHints.add(key);
        if (ID_KEYS.has(normalized) && !conversationId && typeof value[key] === "string" && value[key].length < 256) conversationId = value[key];
        if (PAGINATION_KEYS.has(normalized)) {
          paginationPossible = true;
          const item = value[key];
          if (item === true || (item !== null && item !== undefined && item !== "" && item !== false)) paginationSignals.add(key);
        }
        if (TRUNCATION_KEYS.has(normalized)) {
          const item = value[key];
          if (item === true || (item !== null && item !== undefined && item !== "" && item !== false)) truncationSignals.add(key);
        }
        if (BRANCH_KEYS.has(normalized)) {
          branchSignals.add(key);
          const item = value[key];
          if (Array.isArray(item) && item.length > 1) branchSelection = "UNVERIFIED";
          else if (item && typeof item === "object" && Object.keys(item).length > 1) branchSelection = "UNVERIFIED";
        }
        const child = value[key];
        if (Array.isArray(child)) {
          const turnItems = child.filter(likelyTurnObject);
          if (turnItems.length) {
            wrapperDepth = wrapperDepth === null ? current.depth + 1 : wrapperDepth;
            fieldHints.add(`${key}[${turnItems.length}]`);
          }
          child.slice(0, MAX_ARRAY_ITEMS).forEach((item, index) => {
            if (item && typeof item === "object") queue.push({ value: item, depth: current.depth + 1, path: `${current.path}.${key}[${index}]` });
            else addParsedString(queue, item, current.depth, `${current.path}.${key}[${index}]`);
          });
        } else if (child && typeof child === "object") {
          queue.push({ value: child, depth: current.depth + 1, path: `${current.path}.${key}` });
        } else {
          addParsedString(queue, child, current.depth, `${current.path}.${key}`);
        }
      }
    }

    const userMessages = candidates.filter((item) => item.role === "user");
    const assistantMessages = candidates.filter((item) => item.role === "assistant");
    const clearPagination = paginationSignals.size > 0;
    const truncationDetected = truncationSignals.size > 0;
    const possibleCandidate = userMessages.length > 0 || assistantMessages.length > 0;
    const comparable = userMessages.length > 0 && assistantMessages.length > 0 && Boolean(options.sequenceLike || candidates.length >= 2);
    const countImbalance = userMessages.length > assistantMessages.length + 1 && (comparable || assistantMessages.length === 0);
    if (branchSignals.size > 0 && branchSelection === "NONE_DETECTED") branchSelection = "UNVERIFIED";
    const report = {
      responsePath: responsePath || "(unavailable)",
      topLevelKeys: objectKeys(payload),
      topLevelShape: options.topLevelShape || topLevelShape(payload),
      wrapperDepth,
      maxDepth,
      nodesVisited,
      structuralSignature: structuredSignature(payload),
      fieldHints: Array.from(fieldHints).slice(0, 40),
      possibleTurnCount: candidates.length,
      possibleUserMessages: userMessages.length,
      possibleAssistantMessages: assistantMessages.length,
      candidateMessageKeys: candidates.map((item) => ({ role: item.role, id: item.id, path: item.path })).slice(0, 200),
      conversationId,
      possibleCandidate,
      paginationDetected: clearPagination,
      paginationPossible,
      paginationSignals: Array.from(paginationSignals).slice(0, 20),
      truncationDetected,
      truncationSignals: Array.from(truncationSignals).slice(0, 20),
      branchSignals: Array.from(branchSignals).slice(0, 20),
      branchSelection,
      countImbalance,
      comparableCounts: comparable,
      completeness: clearPagination || truncationDetected || countImbalance ? "INCOMPLETE" : possibleCandidate ? "UNVERIFIED" : "WAITING",
      schemaVerified: false,
      orderingValidated: false,
      schemaVariant: "unknown",
      normalizedUserMessages: 0,
      normalizedAssistantMessages: 0,
      messageLinksValidated: false,
      responseLinksValidated: false
    };
    if (legacy) {
      const legacyHints = [
        `${legacy.schemaVariant}[${legacy.records.length}]`,
        "user_text=$[0][n][2][0][0]",
        "assistant_text=$[0][n][3][0][0][1]"
      ];
      report.wrapperDepth = report.wrapperDepth === null ? 2 : report.wrapperDepth;
      report.fieldHints = Array.from(new Set(report.fieldHints.concat(legacyHints))).slice(0, 40);
      report.possibleTurnCount = legacy.possibleTurnCount;
      report.possibleUserMessages = legacy.possibleUserMessages;
      report.possibleAssistantMessages = legacy.possibleAssistantMessages;
      report.normalizedUserMessages = legacy.normalizedUserMessages;
      report.normalizedAssistantMessages = legacy.normalizedAssistantMessages;
      report.candidateMessageKeys = legacy.candidateMessageKeys.slice(0, 200);
      report.conversationId = legacy.conversationId || report.conversationId;
      report.possibleCandidate = legacy.possibleCandidate;
      report.countImbalance = legacy.countImbalance;
      report.comparableCounts = true;
      report.schemaVariant = legacy.schemaVariant;
      report.schemaVerified = legacy.schemaVerified;
      report.orderingValidated = legacy.orderingValidated;
      report.messageLinksValidated = legacy.messageLinksValidated;
      report.responseLinksValidated = legacy.responseLinksValidated;
      report.completeness = clearPagination || truncationDetected || legacy.countImbalance
        ? "INCOMPLETE"
        : legacy.schemaVerified ? "UNVERIFIED" : "INCOMPLETE";
    }
    return report;
  }

  function inspectBundle(records, urlHint) {
    const list = Array.isArray(records) ? records : [];
    const parsedRecords = list.map((record) => {
      const payload = record && record.payload;
      const suppliedReport = record && (record.report || record.structure) ? (record.report || record.structure) : null;
      const report = inspectResponse(
        payload,
        record && record.responsePath,
        urlHint,
        { sequenceLike: true, topLevelShape: suppliedReport && suppliedReport.topLevelShape }
      );
      return { report, parsed: extractLegacyConversation(payload, urlHint) };
    });
    const reports = parsedRecords.map((item) => item.report);
    const ids = new Set();
    const keyed = new Map();
    let anonymousUser = 0;
    let anonymousAssistant = 0;
    for (const report of reports) {
      for (const item of Array.isArray(report.candidateMessageKeys) ? report.candidateMessageKeys : []) {
        if (item.id) keyed.set(`${item.role}:${item.id}`, item);
        else if (item.role === "user") anonymousUser += 1;
        else if (item.role === "assistant") anonymousAssistant += 1;
      }
    }
    keyed.forEach((_value, key) => ids.add(key));
    const userWithIds = Array.from(ids).filter((key) => key.startsWith("user:")).length;
    const assistantWithIds = Array.from(ids).filter((key) => key.startsWith("assistant:")).length;
    const normalizedByKey = new Map();
    const legacyParses = parsedRecords.map((item) => item.parsed).filter(Boolean);
    for (const parsed of legacyParses) {
      for (const message of parsed.messages) {
        const key = message.platformMessageId
          ? `${message.role}:${message.platformMessageId}`
          : `${message.role}:native:${message.metadata && message.metadata.native_record_index}:${message.sequence}`;
        if (!normalizedByKey.has(key)) normalizedByKey.set(key, message);
      }
    }
    const normalizedMessages = Array.from(normalizedByKey.values()).map((message, sequence) => ({ ...message, sequence }));
    const hasLegacySchema = legacyParses.length > 0;
    const candidateUserTurns = hasLegacySchema
      ? normalizedMessages.filter((message) => message.role === "user").length
      : userWithIds || anonymousUser;
    const candidateAssistantTurns = hasLegacySchema
      ? normalizedMessages.filter((message) => message.role === "assistant").length
      : assistantWithIds || anonymousAssistant;
    const explicitIncomplete = reports.some((report) => report.completeness === "INCOMPLETE");
    const branchUnverified = reports.some((report) => report.branchSelection === "UNVERIFIED");
    const possibleCandidateResponses = reports.filter((report) => report.possibleCandidate).length;
    const schemaVerified = hasLegacySchema && legacyParses.every((parsed) => parsed.schemaVerified);
    const orderingValidated = hasLegacySchema && legacyParses.every((parsed) => parsed.orderingValidated);
    let completeness = "WAITING";
    if (explicitIncomplete) completeness = "INCOMPLETE";
    else if (possibleCandidateResponses > 0) completeness = "UNVERIFIED";
    const countImbalance = Math.abs(candidateUserTurns - candidateAssistantTurns) > 1;
    if (countImbalance) completeness = "INCOMPLETE";
    if (hasLegacySchema && !schemaVerified) completeness = "INCOMPLETE";
    const readyReason = hasLegacySchema
      ? "已解析 BardChatUi history records；仍需验证历史分页、当前 branch、原生顺序和长会话完整性"
      : "Gemini schema、历史聚合、顺序、当前 candidate 和完整性尚未经过 live 验证";
    return {
      responseCount: list.length,
      candidateResponses: possibleCandidateResponses,
      candidateUserTurns,
      candidateAssistantTurns,
      normalizedUserTurns: normalizedMessages.filter((message) => message.role === "user").length,
      normalizedAssistantTurns: normalizedMessages.filter((message) => message.role === "assistant").length,
      possibleTotalTurns: candidateUserTurns + candidateAssistantTurns,
      topLevelShape: reports.length ? reports[reports.length - 1].topLevelShape : "unknown",
      lastTopLevelKeys: reports.length ? reports[reports.length - 1].topLevelKeys : [],
      structuralSignature: reports.length ? reports[reports.length - 1].structuralSignature : "",
      paginationDetected: reports.some((report) => report.paginationDetected),
      paginationPossible: reports.some((report) => report.paginationPossible),
      truncationDetected: reports.some((report) => report.truncationDetected),
      paginationSignals: Array.from(new Set(reports.flatMap((report) => report.paginationSignals || []))).slice(0, 20),
      truncationSignals: Array.from(new Set(reports.flatMap((report) => report.truncationSignals || []))).slice(0, 20),
      branchSelection: branchUnverified ? "UNVERIFIED" : "NONE_DETECTED",
      completeness,
      ready: false,
      readyReason,
      schemaVerified,
      orderingValidated,
      schemaVariant: hasLegacySchema ? legacyParses[0].schemaVariant : "unknown",
      normalizedMessages,
      reports
    };
  }

  function normalizeBundle(records, metadata = {}) {
    const aggregate = inspectBundle(records, metadata.conversationId || null);
    return {
      platform: "gemini",
      conversation_id: metadata.conversationId || null,
      title: metadata.title || "Untitled conversation",
      source_url: metadata.sourceUrl || "(unavailable)",
      captured_at: metadata.capturedAt || null,
      messages: aggregate.normalizedMessages || [],
      metadata: {
        raw_type: "bundle",
        response_count: aggregate.responseCount,
        schema_variant: aggregate.schemaVariant,
        schema_verified: aggregate.schemaVerified,
        ordering_validated: aggregate.orderingValidated,
        completeness: aggregate.completeness
      }
    };
  }

  root.CCEGeminiAdapter = Object.freeze({
    id: "gemini",
    parseStructuredTextReport,
    parseStructuredText,
    inspectResponse,
    inspectBundle,
    normalizeBundle,
    schemaVerified: false,
    exportSupported: false
  });
})(globalThis);
