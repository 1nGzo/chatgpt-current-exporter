/* Gemini adapter for the isolated content world.
 *
 * The page-world observer has a larger discovery parser. This file keeps the
 * same verified BardChatUi history-record boundary available to the isolated
 * UI/export layer without relying on a cross-world global registration.
 */
(function (root) {
  "use strict";

  function stringAt(value, path) {
    let current = value;
    for (const index of path) {
      if (current === null || current === undefined) return "";
      current = current[index];
    }
    return typeof current === "string" ? current : "";
  }

  function textSegments(value, output = [], seen = new Set(), depth = 0) {
    if (output.length >= 200 || depth > 16 || value === null || value === undefined) return output;
    if (typeof value === "string") {
      if (value.length > 0) output.push(value);
      return output;
    }
    if (typeof value !== "object" || seen.has(value)) return output;
    seen.add(value);
    if (Array.isArray(value)) value.slice(0, 300).forEach((item) => textSegments(item, output, seen, depth + 1));
    return output;
  }

  function legacyRecordShape(value) {
    return Boolean(
      Array.isArray(value) && value.length >= 4 &&
      Array.isArray(value[0]) && Array.isArray(value[1]) &&
      Array.isArray(value[2]) && Array.isArray(value[3]) &&
      Array.isArray(value[2][0]) && Array.isArray(value[3][0]) &&
      Array.isArray(value[3][0][0]) &&
      (Array.isArray(value[3][0][0][1]) || typeof value[3][0][0][1] === "string")
    );
  }

  function recordIds(record) {
    const parentMessageId = stringAt(record, [0, 1]) || null;
    const messageId = stringAt(record, [1, 1]) || parentMessageId;
    const responseId = stringAt(record, [1, 2]) || stringAt(record, [3, 0, 0, 0]) || null;
    const parentResponseId = stringAt(record, [3, 0, 0, 0]) || null;
    return { parentMessageId, messageId, responseId, parentResponseId };
  }

  function parseLegacy(payload, conversationId) {
    if (!Array.isArray(payload) || !Array.isArray(payload[0])) return null;
    const rawRecords = payload[0];
    const records = rawRecords.filter(legacyRecordShape);
    if (!records.length) return null;
    const turns = records.map((record, nativeIndex) => {
      const ids = recordIds(record);
      const userText = stringAt(record, [2, 0, 0]);
      const assistantText = textSegments(record[3][0][0][1], []).join("");
      return {
        nativeIndex,
        userText,
        assistantText,
        ids,
        timestamp: Array.isArray(record[4]) ? record[4].slice(0, 2) : record[4] === undefined ? null : record[4]
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
    const messages = [];
    turns.forEach((turn) => {
      messages.push({
        sequence: messages.length,
        role: "user",
        text: turn.userText || "[This turn includes non-text content]",
        timestamp: turn.timestamp,
        platformMessageId: turn.ids.messageId,
        metadata: { native_record_index: turn.nativeIndex, parent_message_id: turn.ids.parentMessageId }
      });
      if (turn.assistantText) {
        messages.push({
          sequence: messages.length,
          role: "assistant",
          text: turn.assistantText,
          timestamp: turn.timestamp,
          platformMessageId: turn.ids.responseId,
          metadata: { native_record_index: turn.nativeIndex, parent_response_id: turn.ids.parentResponseId }
        });
      }
    });
    return {
      schemaVariant: "BardChatUi-history-records",
      conversationId: conversationId || null,
      records,
      turns,
      messages,
      schemaVerified: records.length === rawRecords.length && turns.every((turn) => turn.userText && turn.assistantText),
      orderingValidated: messageLinksValidated && responseLinksValidated,
      messageLinksValidated,
      responseLinksValidated,
      candidateUserTurns: turns.length,
      candidateAssistantTurns: turns.filter((turn) => turn.assistantText).length,
      normalizedUserTurns: messages.filter((message) => message.role === "user").length,
      normalizedAssistantTurns: messages.filter((message) => message.role === "assistant").length
    };
  }

  function inspectResponse(payload, responsePath, conversationId, options = {}) {
    const parsed = parseLegacy(payload, conversationId);
    if (parsed) {
      return {
        responsePath: responsePath || "(unavailable)",
        topLevelShape: options.topLevelShape || "array",
        topLevelKeys: [],
        structuralSignature: "",
        fieldHints: [
          `${parsed.schemaVariant}[${parsed.records.length}]`,
          "user_text=$[0][n][2][0][0]",
          "assistant_text=$[0][n][3][0][0][1]"
        ],
        possibleCandidate: true,
        possibleTurnCount: parsed.candidateUserTurns + parsed.candidateAssistantTurns,
        possibleUserMessages: parsed.candidateUserTurns,
        possibleAssistantMessages: parsed.candidateAssistantTurns,
        normalizedUserMessages: parsed.normalizedUserTurns,
        normalizedAssistantMessages: parsed.normalizedAssistantTurns,
        candidateMessageKeys: [],
        conversationId: parsed.conversationId,
        paginationDetected: false,
        paginationPossible: false,
        paginationSignals: [],
        truncationDetected: false,
        truncationSignals: [],
        branchSignals: [],
        branchSelection: "NONE_DETECTED",
        countImbalance: Math.abs(parsed.candidateUserTurns - parsed.candidateAssistantTurns) > 1,
        completeness: parsed.schemaVerified ? "UNVERIFIED" : "INCOMPLETE",
        schemaVariant: parsed.schemaVariant,
        schemaVerified: parsed.schemaVerified,
        orderingValidated: parsed.orderingValidated,
        messageLinksValidated: parsed.messageLinksValidated,
        responseLinksValidated: parsed.responseLinksValidated
      };
    }
    return {
      responsePath: responsePath || "(unavailable)",
      topLevelShape: options.topLevelShape || "unknown",
      topLevelKeys: [],
      structuralSignature: "",
      fieldHints: [],
      possibleCandidate: false,
      possibleTurnCount: 0,
      possibleUserMessages: 0,
      possibleAssistantMessages: 0,
      normalizedUserMessages: 0,
      normalizedAssistantMessages: 0,
      candidateMessageKeys: [],
      conversationId: conversationId || null,
      paginationDetected: false,
      paginationPossible: false,
      paginationSignals: [],
      truncationDetected: false,
      truncationSignals: [],
      branchSignals: [],
      branchSelection: "NONE_DETECTED",
      countImbalance: false,
      completeness: "WAITING",
      schemaVariant: "unknown",
      schemaVerified: false,
      orderingValidated: false
    };
  }

  function inspectBundle(records, conversationId) {
    const list = Array.isArray(records) ? records : [];
    const reports = [];
    const messagesByKey = new Map();
    for (const record of list) {
      const parsed = parseLegacy(record && record.payload, conversationId);
      const report = record && (record.report || record.structure)
        ? (record.report || record.structure)
        : inspectResponse(record && record.payload, record && record.responsePath, conversationId);
      reports.push(report);
      if (!parsed) continue;
      for (const message of parsed.messages) {
        const key = message.platformMessageId
          ? `${message.role}:${message.platformMessageId}`
          : `${message.role}:native:${message.metadata.native_record_index}:${message.sequence}`;
        if (!messagesByKey.has(key)) messagesByKey.set(key, message);
      }
    }
    const normalizedMessages = Array.from(messagesByKey.values()).map((message, sequence) => ({ ...message, sequence }));
    const candidateResponses = reports.filter((report) => report && report.possibleCandidate).length;
    const candidateUserTurns = normalizedMessages.filter((message) => message.role === "user").length || reports.reduce((sum, report) => sum + (Number(report && report.possibleUserMessages) || 0), 0);
    const candidateAssistantTurns = normalizedMessages.filter((message) => message.role === "assistant").length || reports.reduce((sum, report) => sum + (Number(report && report.possibleAssistantMessages) || 0), 0);
    const incomplete = reports.some((report) => report && report.completeness === "INCOMPLETE") || Math.abs(candidateUserTurns - candidateAssistantTurns) > 1;
    return {
      responseCount: list.length,
      candidateResponses,
      candidateUserTurns,
      candidateAssistantTurns,
      normalizedUserTurns: normalizedMessages.filter((message) => message.role === "user").length,
      normalizedAssistantTurns: normalizedMessages.filter((message) => message.role === "assistant").length,
      possibleTotalTurns: candidateUserTurns + candidateAssistantTurns,
      topLevelShape: reports.length ? reports[reports.length - 1].topLevelShape || "unknown" : "unknown",
      lastTopLevelKeys: reports.length && Array.isArray(reports[reports.length - 1].topLevelKeys) ? reports[reports.length - 1].topLevelKeys : [],
      structuralSignature: reports.length ? reports[reports.length - 1].structuralSignature || "" : "",
      paginationDetected: reports.some((report) => report && report.paginationDetected),
      paginationPossible: reports.some((report) => report && report.paginationPossible),
      paginationSignals: Array.from(new Set(reports.flatMap((report) => report && report.paginationSignals || []))),
      truncationDetected: reports.some((report) => report && report.truncationDetected),
      truncationSignals: Array.from(new Set(reports.flatMap((report) => report && report.truncationSignals || []))),
      branchSelection: reports.some((report) => report && report.branchSelection === "UNVERIFIED") ? "UNVERIFIED" : "NONE_DETECTED",
      completeness: incomplete ? "INCOMPLETE" : candidateResponses ? "UNVERIFIED" : "WAITING",
      ready: false,
      readyReason: "已解析 BardChatUi history records；仍需验证历史分页、当前 branch、原生顺序和长会话完整性",
      schemaVerified: reports.length > 0 && reports.every((report) => Boolean(report && report.schemaVerified)),
      orderingValidated: reports.length > 0 && reports.every((report) => Boolean(report && report.orderingValidated)),
      schemaVariant: reports.length ? reports[0].schemaVariant || "unknown" : "unknown",
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

  root.CCEGeminiIsolatedAdapter = Object.freeze({
    id: "gemini",
    inspectResponse,
    inspectBundle,
    normalizeBundle,
    schemaVerified: false,
    exportSupported: false
  });
})(globalThis);
