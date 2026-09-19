(function () {
  "use strict";

  const SOURCE = "chatgpt-current-exporter";
  const converter = globalThis.CCEConversationConverter;
  const platformCore = globalThis.CCEPlatformCore;
  function fallbackPlatformFromUrl(value) {
    try {
      const hostname = new URL(value).hostname.toLowerCase();
      if (hostname === "gemini.google.com" || hostname.endsWith(".gemini.google.com")) return "gemini";
    } catch (_) {
      // URL parsing failure is handled by the existing unsupported fallback.
    }
    return "chatgpt";
  }
  let platformId = platformCore && typeof platformCore.detectPlatform === "function"
    ? platformCore.detectPlatform(window.location.href)
    : fallbackPlatformFromUrl(window.location.href);
  if (platformId === "unsupported") platformId = fallbackPlatformFromUrl(window.location.href);
  let platformDefinition = platformCore && typeof platformCore.definition === "function"
    ? platformCore.definition(platformId)
    : { id: platformId, label: platformId };
  function currentGeminiAdapter() {
    return globalThis.CCEGeminiAdapter || globalThis.CCEGeminiIsolatedAdapter || null;
  }
  const captured = new Map();
  const basePayloads = new Map();
  const messagePages = new Map();
  const geminiRecords = [];
  const geminiRecordKeys = new Set();
  const runtimeDiagnostics = {
    extension: true,
    platform: platformId,
    platformLabel: platformDefinition.label,
    injected: false,
    fetchObserved: 0,
    xhrObserved: 0,
    jsonCandidates: 0,
    conversationCandidates: 0,
    jsonParseErrors: 0,
    streamResponses: 0,
    webSocketObserved: 0,
    webSocketMessages: 0,
    conversationEndpointObserved: 0,
    currentConversationEndpointResponses: 0,
    fallbackAttempts: 0,
    fallbackResponses: 0,
    fallbackConversationCandidates: 0,
    fallbackLastResult: "",
    fallbackConfigured: false,
    fallbackSkipReason: "",
    fallbackLastEndpoint: "",
    messagePageResponses: 0,
    messagePageCandidates: 0,
    cachedMessagePages: 0,
    capturedPageCount: 0,
    paginationState: "unknown",
    lastParsedStats: { mappingNodes: 0, activePathNodes: 0, excludedBranchNodes: 0, visibleMessages: 0, incompleteReasons: [] },
    lastParsedSchemaVariant: "none",
    lastPageInfo: { keys: [], hasMore: null, hasPreviousPage: null, hasNextPage: null, endCursorPresent: false },
    lastDetectedKeys: [],
    lastEndpointKeys: [],
    lastEndpointSchema: { mapping: false, currentNode: false, title: false, conversationId: null },
    lastCandidatePath: "",
    lastSchema: { mapping: false, messages: false, currentNode: false, title: false, conversationId: null, schemaType: "none" },
    lastContentType: "",
    lastResponsePath: "",
    observedResponsePaths: [],
    rejectedIdMismatches: 0,
    lastRescan: "",
    candidateResponses: 0,
    candidateUserTurns: 0,
    candidateAssistantTurns: 0,
    normalizedUserTurns: 0,
    normalizedAssistantTurns: 0,
    possibleTotalTurns: 0,
    topLevelShape: "unknown",
    structuralSignature: "",
    paginationDetected: false,
    truncationDetected: false,
    branchSelection: "NONE_DETECTED",
    completeness: "WAITING",
    readyReason: "等待结构化 response",
    geminiConversationCandidates: 0,
    geminiLastTopLevelKeys: [],
    geminiLastWrapperDepth: null,
    geminiLastTurnCount: 0,
    geminiLastUserMessages: 0,
    geminiLastAssistantMessages: 0,
    geminiPaginationDetected: false,
    geminiPaginationSignals: [],
    geminiPaginationPossible: false,
    geminiTruncationDetected: false,
    geminiTruncationSignals: [],
    geminiCompleteness: "WAITING",
    geminiSchemaVerified: false,
    geminiOrderingValidated: false,
    geminiSchemaVariant: "unknown",
    geminiBranchSelection: "NONE_DETECTED",
    geminiLastFieldHints: [],
    geminiLastConversationId: null,
    geminiResponseCount: 0,
    geminiLastRpcId: null,
    geminiLastCandidatePath: "",
    geminiLastCandidateContentType: "",
    geminiRpcSummaries: [],
    geminiAdapterLoaded: Boolean(currentGeminiAdapter() && typeof currentGeminiAdapter().inspectBundle === "function"),
    geminiAdapterMode: "adapter",
    geminiAdapterError: "",
    batchResponses: 0,
    batchFrames: 0,
    batchInnerPayloads: 0,
    batchParseFailures: 0,
    batchRpcIds: []
  };
  let currentId = currentConversationId();
  let lastError = "";
  let panel = null;
  let quickExport = null;
  let dotHistory = null;
  const namingConfigReady = loadLocalNamingConfig();

  function loadLocalNamingConfig() {
    if (!converter || typeof converter.setNamingRules !== "function" || typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.getURL !== "function") return Promise.resolve();
    return fetch(chrome.runtime.getURL("naming.local.json"), { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((config) => {
        if (config && Array.isArray(config.series_rules)) converter.setNamingRules(config.series_rules);
      })
      .catch(() => {
        // The optional file is intentionally absent in public clones.
      });
  }

  function currentConversationId() {
    if (platformId === "gemini") {
      if (platformCore && typeof platformCore.conversationIdHint === "function") {
        const hinted = platformCore.conversationIdHint(window.location.href, platformId);
        if (hinted) return hinted;
      }
      try {
        const parts = new URL(window.location.href).pathname.split("/").filter(Boolean);
        const appIndex = parts.indexOf("app");
        if (appIndex >= 0 && parts[appIndex + 1]) return decodeURIComponent(parts[appIndex + 1]);
      } catch (_) {
        return null;
      }
      return null;
    }
    try {
      const parts = new URL(window.location.href).pathname.split("/").filter(Boolean);
      const index = parts.lastIndexOf("c");
      return index >= 0 && parts[index + 1] ? decodeURIComponent(parts[index + 1]) : null;
    } catch (_) {
      return null;
    }
  }

  function currentEntry() {
    return currentId ? captured.get(currentId) || null : null;
  }

  function currentConversationTitle() {
    try {
      return typeof window.document.title === "string" && window.document.title.trim()
        ? window.document.title.trim()
        : "Untitled conversation";
    } catch (_) {
      return "Untitled conversation";
    }
  }

  function payloadFingerprint(payload) {
    try {
      const text = JSON.stringify(payload);
      let hash = 2166136261;
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return `${text.length}:${(hash >>> 0).toString(16)}`;
    } catch (_) {
      return "unserializable";
    }
  }

  function aggregateGeminiReports(reason) {
    const reports = geminiRecords.map((record) => record && record.report).filter((report) => report && typeof report === "object");
    const ids = new Set();
    let anonymousUser = 0;
    let anonymousAssistant = 0;
    for (const report of reports) {
      for (const item of Array.isArray(report.candidateMessageKeys) ? report.candidateMessageKeys : []) {
        if (item && item.id) ids.add(`${item.role}:${item.id}`);
        else if (item && item.role === "user") anonymousUser += 1;
        else if (item && item.role === "assistant") anonymousAssistant += 1;
      }
    }
    const userIds = Array.from(ids).filter((key) => key.startsWith("user:")).length;
    const assistantIds = Array.from(ids).filter((key) => key.startsWith("assistant:")).length;
    const candidateUserTurns = userIds || anonymousUser;
    const candidateAssistantTurns = assistantIds || anonymousAssistant;
    const candidateResponses = reports.filter((report) => report.possibleCandidate).length;
    const normalizedUserTurns = userIds || Math.max(0, ...reports.map((report) => Number(report.normalizedUserMessages) || 0));
    const normalizedAssistantTurns = assistantIds || Math.max(0, ...reports.map((report) => Number(report.normalizedAssistantMessages) || 0));
    const incomplete = reports.some((report) => report.completeness === "INCOMPLETE") || Math.abs(candidateUserTurns - candidateAssistantTurns) > 1;
    return {
      responseCount: geminiRecords.length,
      candidateResponses,
      candidateUserTurns,
      candidateAssistantTurns,
      normalizedUserTurns,
      normalizedAssistantTurns,
      possibleTotalTurns: candidateUserTurns + candidateAssistantTurns,
      topLevelShape: reports.length ? reports[reports.length - 1].topLevelShape || "unknown" : "unknown",
      lastTopLevelKeys: reports.length && Array.isArray(reports[reports.length - 1].topLevelKeys) ? reports[reports.length - 1].topLevelKeys : [],
      structuralSignature: reports.length ? reports[reports.length - 1].structuralSignature || "" : "",
      paginationDetected: reports.some((report) => report.paginationDetected),
      paginationPossible: reports.some((report) => report.paginationPossible),
      paginationSignals: Array.from(new Set(reports.flatMap((report) => report.paginationSignals || []))),
      truncationDetected: reports.some((report) => report.truncationDetected),
      truncationSignals: Array.from(new Set(reports.flatMap((report) => report.truncationSignals || []))),
      branchSelection: reports.some((report) => report.branchSelection === "UNVERIFIED") ? "UNVERIFIED" : "NONE_DETECTED",
      completeness: incomplete ? "INCOMPLETE" : candidateResponses ? "UNVERIFIED" : "WAITING",
      ready: false,
      readyReason: reason || "Gemini adapter 未加载；使用结构报告聚合，正式导出仍关闭",
      schemaVerified: reports.length > 0 && reports.every((report) => Boolean(report.schemaVerified)),
      orderingValidated: reports.length > 0 && reports.every((report) => Boolean(report.orderingValidated)),
      schemaVariant: reports.length ? reports[reports.length - 1].schemaVariant || "unknown" : "unknown",
      normalizedMessages: [],
      reports
    };
  }

  function geminiAggregate() {
    const geminiAdapter = currentGeminiAdapter();
    runtimeDiagnostics.geminiAdapterLoaded = Boolean(geminiAdapter && typeof geminiAdapter.inspectBundle === "function");
    if (!runtimeDiagnostics.geminiAdapterLoaded) {
      runtimeDiagnostics.geminiAdapterMode = "report-fallback";
      return aggregateGeminiReports("Gemini isolated adapter 未加载；使用 page-world 结构报告聚合，正式导出仍关闭");
    }
    try {
      const aggregate = geminiAdapter.inspectBundle(geminiRecords, currentId);
      const reportCandidateCount = geminiRecords.filter((record) => record && record.report && record.report.possibleCandidate).length;
      if (reportCandidateCount > 0 && (!aggregate || aggregate.candidateResponses === 0)) {
        runtimeDiagnostics.geminiAdapterMode = "report-fallback";
        return aggregateGeminiReports("Gemini isolated adapter 聚合为空；使用 page-world 结构报告聚合，正式导出仍关闭");
      }
      runtimeDiagnostics.geminiAdapterMode = "adapter";
      runtimeDiagnostics.geminiAdapterError = "";
      return aggregate;
    } catch (error) {
      runtimeDiagnostics.geminiAdapterMode = "report-fallback";
      runtimeDiagnostics.geminiAdapterError = error && error.message ? String(error.message) : String(error);
      return aggregateGeminiReports(`Gemini isolated adapter 聚合失败；使用 page-world 结构报告聚合：${runtimeDiagnostics.geminiAdapterError}`);
    }
  }

  function syncGeminiDiagnostics() {
    if (platformId !== "gemini") return geminiAggregate();
    const aggregate = geminiAggregate();
    const last = geminiRecords.length ? geminiRecords[geminiRecords.length - 1].report : null;
    const lastCandidateRecord = [...geminiRecords].reverse().find((record) => record && record.report && record.report.possibleCandidate) || null;
    runtimeDiagnostics.geminiResponseCount = aggregate.responseCount || geminiRecords.length;
    runtimeDiagnostics.candidateResponses = aggregate.candidateResponses || 0;
    runtimeDiagnostics.geminiConversationCandidates = runtimeDiagnostics.candidateResponses;
    runtimeDiagnostics.candidateUserTurns = aggregate.candidateUserTurns || 0;
    runtimeDiagnostics.candidateAssistantTurns = aggregate.candidateAssistantTurns || 0;
    runtimeDiagnostics.normalizedUserTurns = aggregate.normalizedUserTurns || 0;
    runtimeDiagnostics.normalizedAssistantTurns = aggregate.normalizedAssistantTurns || 0;
    runtimeDiagnostics.possibleTotalTurns = aggregate.possibleTotalTurns || 0;
    runtimeDiagnostics.topLevelShape = aggregate.topLevelShape || "unknown";
    runtimeDiagnostics.structuralSignature = aggregate.structuralSignature || "";
    runtimeDiagnostics.paginationDetected = Boolean(aggregate.paginationDetected);
    runtimeDiagnostics.geminiPaginationDetected = runtimeDiagnostics.paginationDetected;
    runtimeDiagnostics.geminiPaginationSignals = Array.isArray(aggregate.paginationSignals) ? aggregate.paginationSignals.slice(0, 20) : [];
    runtimeDiagnostics.geminiPaginationPossible = Boolean(aggregate.paginationPossible);
    runtimeDiagnostics.truncationDetected = Boolean(aggregate.truncationDetected);
    runtimeDiagnostics.geminiTruncationDetected = runtimeDiagnostics.truncationDetected;
    runtimeDiagnostics.geminiTruncationSignals = Array.isArray(aggregate.truncationSignals) ? aggregate.truncationSignals.slice(0, 20) : [];
    runtimeDiagnostics.completeness = aggregate.completeness || "WAITING";
    runtimeDiagnostics.geminiCompleteness = runtimeDiagnostics.completeness;
    runtimeDiagnostics.branchSelection = aggregate.branchSelection || "NONE_DETECTED";
    runtimeDiagnostics.geminiBranchSelection = runtimeDiagnostics.branchSelection;
    runtimeDiagnostics.readyReason = aggregate.readyReason || "Gemini schema、历史聚合、顺序、candidate 和完整性尚未经过 live 验证";
    runtimeDiagnostics.geminiSchemaVerified = Boolean(aggregate.schemaVerified);
    runtimeDiagnostics.geminiOrderingValidated = Boolean(aggregate.orderingValidated);
    runtimeDiagnostics.geminiSchemaVariant = aggregate.schemaVariant || "unknown";
    const rpcMap = new Map();
    for (const record of geminiRecords) {
      const rpcId = record.rpcId || "(none)";
      const summary = rpcMap.get(rpcId) || { rpcId, responses: 0, candidates: 0, users: 0, assistants: 0, maxUsers: 0, maxAssistants: 0, shapes: [] };
      const report = record.report || {};
      summary.responses += 1;
      summary.candidates += report.possibleCandidate ? 1 : 0;
      summary.users += report.possibleUserMessages || 0;
      summary.assistants += report.possibleAssistantMessages || 0;
      summary.maxUsers = Math.max(summary.maxUsers, report.possibleUserMessages || 0);
      summary.maxAssistants = Math.max(summary.maxAssistants, report.possibleAssistantMessages || 0);
      if (report.topLevelShape && !summary.shapes.includes(report.topLevelShape)) summary.shapes.push(report.topLevelShape);
      rpcMap.set(rpcId, summary);
    }
    runtimeDiagnostics.geminiRpcSummaries = Array.from(rpcMap.values()).slice(-40);
    if (last) {
      runtimeDiagnostics.geminiLastTopLevelKeys = Array.isArray(last.topLevelKeys) ? last.topLevelKeys.slice(0, 80) : [];
      runtimeDiagnostics.geminiLastWrapperDepth = last.wrapperDepth === undefined ? null : last.wrapperDepth;
      runtimeDiagnostics.geminiLastTurnCount = last.possibleTurnCount || 0;
      runtimeDiagnostics.geminiLastUserMessages = last.possibleUserMessages || 0;
      runtimeDiagnostics.geminiLastAssistantMessages = last.possibleAssistantMessages || 0;
      runtimeDiagnostics.geminiLastFieldHints = Array.isArray(last.fieldHints) ? last.fieldHints.slice(0, 40) : [];
      runtimeDiagnostics.geminiLastConversationId = last.conversationId || currentId || null;
      runtimeDiagnostics.geminiLastRpcId = geminiRecords[geminiRecords.length - 1].rpcId || null;
    }
    if (lastCandidateRecord) {
      runtimeDiagnostics.geminiLastCandidatePath = lastCandidateRecord.responsePath || "";
      runtimeDiagnostics.geminiLastCandidateContentType = lastCandidateRecord.contentType || "";
    } else if (runtimeDiagnostics.lastCandidatePath) {
      runtimeDiagnostics.geminiLastCandidatePath = runtimeDiagnostics.lastCandidatePath;
      runtimeDiagnostics.geminiLastCandidateContentType = runtimeDiagnostics.lastCandidateContentType || "";
    }
    return aggregate;
  }

  function captureGeminiStructure(event) {
    if (platformId !== "gemini" || !event || typeof event !== "object") return;
    const payload = event.payload;
    if (!payload || typeof payload !== "object") return;
    const geminiAdapter = currentGeminiAdapter();
    const report = event.report && typeof event.report === "object"
      ? event.report
      : (geminiAdapter && typeof geminiAdapter.inspectResponse === "function"
        ? geminiAdapter.inspectResponse(payload, event.responsePath, currentId)
        : null);
    const responsePath = typeof event.responsePath === "string" ? event.responsePath : "(unavailable)";
    const rpcId = event.rpcId ? String(event.rpcId) : "";
    const fingerprint = payloadFingerprint(payload);
    const key = `${responsePath}|${rpcId}|${fingerprint}`;
    if (geminiRecordKeys.has(key)) return;
    geminiRecordKeys.add(key);
    geminiRecords.push({
      payload,
      report,
      transport: typeof event.transport === "string" ? event.transport : "unknown",
      contentType: typeof event.contentType === "string" ? event.contentType : "",
      responsePath,
      rpcId: rpcId || null,
      capturedAt: new Date().toISOString()
    });
    while (geminiRecords.length > 200) geminiRecords.shift();
    syncGeminiDiagnostics();
    updatePanel();
  }

  function geminiDebugBundle() {
    const aggregate = syncGeminiDiagnostics();
    return {
      exporter_metadata: {
        platform: "gemini",
        raw_type: "bundle",
        schema_status: aggregate.completeness || "WAITING",
        conversation_id: currentId || runtimeDiagnostics.geminiLastConversationId || null,
        title: currentConversationTitle(),
        source_url: safeCurrentUrl(),
        captured_at: new Date().toISOString(),
        response_count: geminiRecords.length,
        note: "Local debug bundle of structured responses; not an assertion that Gemini history is complete."
      },
      diagnostics: {
        candidateResponses: aggregate.candidateResponses || 0,
        candidateUserTurns: aggregate.candidateUserTurns || 0,
        candidateAssistantTurns: aggregate.candidateAssistantTurns || 0,
        normalizedUserTurns: aggregate.normalizedUserTurns || 0,
        normalizedAssistantTurns: aggregate.normalizedAssistantTurns || 0,
        possibleTotalTurns: aggregate.possibleTotalTurns || 0,
        schemaVariant: aggregate.schemaVariant || "unknown",
        schemaVerified: Boolean(aggregate.schemaVerified),
        orderingValidated: Boolean(aggregate.orderingValidated),
        rpcSummaries: runtimeDiagnostics.geminiRpcSummaries,
        completeness: aggregate.completeness || "WAITING",
        branchSelection: aggregate.branchSelection || "NONE_DETECTED",
        paginationDetected: Boolean(aggregate.paginationDetected),
        truncationDetected: Boolean(aggregate.truncationDetected),
        ready: false,
        readyReason: aggregate.readyReason || "Gemini schema 尚未经过 live 验证"
      },
      responses: geminiRecords.map((record) => ({
        transport: record.transport,
        content_type: record.contentType,
        response_path: record.responsePath,
        rpc_id: record.rpcId,
        captured_at: record.capturedAt,
        structure: record.report,
        payload: record.payload
      }))
    };
  }

  function pageInfoOf(payload) {
    const value = payload && payload.page_info;
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  }

  function paginationState(basePayload, pages) {
    const pagePayloads = pages.map((page) => page && page.payload ? page.payload : page);
    const pageInfos = [basePayload, ...pagePayloads].map(pageInfoOf).filter(Boolean);
    if (!pageInfos.length) return "not-paginated";
    if (pageInfos.some((info) => info.has_previous_page === false)) return "complete";
    if (pageInfos.some((info) => info.has_previous_page === true)) return "waiting-older-pages";
    return "unknown";
  }

  function currentPageCount(id) {
    return messagePages.has(id) ? messagePages.get(id).length : 0;
  }

  function updateParsedDiagnostics(document, id) {
    runtimeDiagnostics.lastParsedStats = {
      mappingNodes: document.stats.mappingNodes,
      activePathNodes: document.stats.activePathNodes,
      excludedBranchNodes: document.stats.excludedBranchNodes,
      visibleMessages: document.stats.visibleMessages,
      incompleteReasons: document.stats.incompleteReasons.slice()
    };
    runtimeDiagnostics.lastPageInfo = { ...document.pageInfo, keys: document.pageInfo.keys.slice() };
    runtimeDiagnostics.lastSchema = {
      mapping: Boolean(document.stats.mappingNodes),
      messages: document.schemaVariant !== "mapping",
      currentNode: Boolean(document.stats.activePathNodes),
      title: Boolean(document.title),
      conversationId: document.conversationId || id,
      schemaType: document.schemaVariant || "mapping"
    };
    runtimeDiagnostics.lastParsedSchemaVariant = document.schemaVariant || "mapping";
  }

  function rebuildConversation(id) {
    const basePayload = basePayloads.get(id);
    if (!basePayload) return;
    const pages = messagePages.get(id) || [];
    const pagination = paginationState(basePayload, pages);
    runtimeDiagnostics.paginationState = pagination;
    runtimeDiagnostics.capturedPageCount = pages.length;
    const pagePayloads = pages.map((page) => page.payload);
    const payload = pagePayloads.length && typeof converter.mergeMessagePages === "function"
      ? converter.mergeMessagePages(basePayload, pagePayloads, { olderComplete: pagination === "complete" })
      : basePayload;
    let document;
    try {
      document = converter.inspect(payload);
    } catch (error) {
      captured.delete(id);
      lastError = `schema 解析失败：${error && error.message ? error.message : String(error)}`;
      runtimeDiagnostics.lastSchemaError = lastError;
      updatePanel();
      return;
    }
    updateParsedDiagnostics(document, id);
    const normalized = platformId === "chatgpt" && globalThis.CCEChatGPTAdapter && typeof globalThis.CCEChatGPTAdapter.normalize === "function"
      ? globalThis.CCEChatGPTAdapter.normalize(document, { sourceUrl: safeCurrentUrl(), capturedAt: new Date().toISOString() })
      : null;
    if (document.stats.incompleteReasons.length) {
      captured.delete(id);
      const reason = document.stats.incompleteReasons.join("；");
      lastError = pagination === "waiting-older-pages"
        ? `当前响应仍有旧消息分页：${reason}；请继续向上滚动至最顶端后重新扫描`
        : `捕获响应明确表示不完整：${reason}`;
      updatePanel();
      return;
    }
    const rawText = `${JSON.stringify(payload, null, 2)}\n`;
    captured.set(id, {
      payload,
      document,
      rawText,
      rawSize: new Blob([rawText]).size,
      capturedAt: new Date().toISOString(),
      pageCount: pages.length,
      paginationState: pagination,
      normalized
    });
    lastError = "";
    updatePanel();
  }

  function safeCurrentUrl() {
    try {
      const url = new URL(window.location.href);
      return `${url.origin}${url.pathname}`;
    } catch (_) {
      return "(unavailable)";
    }
  }

  function readyReason(entry) {
    if (entry) {
      if (entry.document.stats.incompleteReasons.length) return `明确不完整：${entry.document.stats.incompleteReasons.join("；")}`;
      if (entry.document.messages.length === 0) return "active path 没有 user/assistant 可见消息";
      if (entry.paginationState === "complete" && entry.pageCount > 0) {
        if (entry.document.warningSummary) return `已合并 ${entry.pageCount} 个旧消息分页，active path 可导出；${entry.document.warningSummary}`;
        return `已合并 ${entry.pageCount} 个旧消息分页，active path 可导出`;
      }
      if (entry.document.warningSummary) return `已捕获 conversation，active path 可导出；${entry.document.warningSummary}`;
      return "已捕获 conversation，active path 可导出";
    }
    if (lastError) return lastError;
    if (platformId === "gemini") {
      const aggregate = syncGeminiDiagnostics();
      if (!currentId) return "当前 Gemini URL 未识别 /app/<conversation_id>";
      if (!runtimeDiagnostics.injected) return "Gemini page-world observer 尚未确认注入；请刷新当前页面";
      if (aggregate.completeness === "INCOMPLETE") return `Gemini completeness=INCOMPLETE：${[...(aggregate.paginationSignals || []), ...(aggregate.truncationSignals || [])].join(", ") || "count sanity check failed"}；暂不导出`;
      if (aggregate.candidateResponses > 0) return aggregate.readyReason || "已发现 Gemini 结构化 candidate，但 schema、历史聚合、顺序、分支和完整性尚未验证；暂不导出";
      if (runtimeDiagnostics.jsonCandidates > 0 || runtimeDiagnostics.batchResponses > 0) return "已观察 Gemini response，但尚未确认 conversation turn schema；当前仅诊断";
      if (runtimeDiagnostics.fetchObserved || runtimeDiagnostics.xhrObserved || runtimeDiagnostics.streamResponses || runtimeDiagnostics.webSocketMessages) return "已观察 Gemini 请求，但尚未发现可识别 turn；当前仅诊断";
      return "等待 Gemini 结构化 response；刷新当前会话后重试";
    }
    if (runtimeDiagnostics.paginationState === "waiting-older-pages") return "当前 conversation 仍有旧消息分页；请继续向上滚动至最顶端后重新扫描";
    if (!currentId) return "当前 URL 未识别 /c/<conversation_id>";
    if (!runtimeDiagnostics.injected) return "尚未确认 injected.js 在 page world 运行";
    if (runtimeDiagnostics.fallbackSkipReason === "config-not-loaded") return "fallback adapter 未加载；请重新加载扩展并刷新当前页面";
    if (runtimeDiagnostics.fallbackLastResult === "json-without-mapping") return "当前 conversation endpoint 返回了 JSON，但没有发现 mapping；未生成不完整导出";
    if (runtimeDiagnostics.fallbackLastResult === "response-not-json") return "当前 conversation endpoint 返回的内容不是 JSON；未生成不完整导出";
    if (runtimeDiagnostics.fallbackLastResult === "request-failed") return "当前 conversation endpoint 重试失败；未生成不完整导出";
    if (runtimeDiagnostics.fallbackLastResult && runtimeDiagnostics.fallbackLastResult.startsWith("http-")) return `当前 conversation endpoint 返回 ${runtimeDiagnostics.fallbackLastResult}；未生成不完整导出`;
    if (runtimeDiagnostics.conversationCandidates === 0) {
      if (runtimeDiagnostics.jsonCandidates === 0) {
        if (runtimeDiagnostics.fetchObserved === 0 && runtimeDiagnostics.xhrObserved === 0) return "尚未观察到 fetch/XHR；请刷新当前会话";
        if (runtimeDiagnostics.streamResponses > 0) return "观察到 streaming response，但尚未发现 conversation JSON";
        return "已观察请求，但尚未解析出 JSON response";
      }
      return "已解析 JSON，但没有发现 mapping conversation response";
    }
    if (runtimeDiagnostics.rejectedIdMismatches > 0) return "conversation candidate 的 id 与当前 URL 不匹配";
    return "已发现 conversation candidate，但 schema 尚未通过 active path 解析";
  }

  function status() {
    if (platformId === "gemini") {
      const aggregate = syncGeminiDiagnostics();
      const reason = readyReason(null);
      const incomplete = aggregate.completeness === "INCOMPLETE";
      return {
        extension: true,
        platform: platformId,
        platformLabel: platformDefinition.label,
        conversationId: currentId || runtimeDiagnostics.geminiLastConversationId || null,
        title: currentConversationTitle(),
        capturedAt: geminiRecords.length ? geminiRecords[geminiRecords.length - 1].capturedAt : null,
        captured: false,
        mappingNodes: 0,
        activePathNodes: 0,
        activePathMessages: 0,
        rawJsonSize: 0,
        pagesCaptured: 0,
        incompleteReasons: incomplete ? [reason] : [],
        warnings: [],
        warningSummary: "",
        state: lastError ? "Error" : incomplete ? "Error" : "Waiting",
        readyReason: reason,
        debugBundleAvailable: geminiRecords.length > 0,
        diagnostics: {
          ...runtimeDiagnostics,
          currentUrl: safeCurrentUrl(),
          platform: platformId,
          platformLabel: platformDefinition.label,
          conversationId: currentId || runtimeDiagnostics.geminiLastConversationId || null,
          conversationTitle: currentConversationTitle(),
          pagesCaptured: 0,
          paginationState: aggregate.paginationDetected ? "detected" : "unknown",
          candidateResponses: aggregate.candidateResponses || 0,
          candidateUserTurns: aggregate.candidateUserTurns || 0,
          candidateAssistantTurns: aggregate.candidateAssistantTurns || 0,
          normalizedUserTurns: aggregate.normalizedUserTurns || 0,
          normalizedAssistantTurns: aggregate.normalizedAssistantTurns || 0,
          possibleTotalTurns: aggregate.possibleTotalTurns || 0,
          completeness: aggregate.completeness || "WAITING",
          readyReason: reason,
          lastDetectedKeys: runtimeDiagnostics.geminiLastTopLevelKeys.slice(),
          structuralSignature: runtimeDiagnostics.structuralSignature || ""
        }
      };
    }
    const entry = currentEntry();
    const parsedDocument = entry ? entry.document : null;
    const stats = parsedDocument ? parsedDocument.stats : null;
    const reason = readyReason(entry);
    const state = lastError ? "Error" : (entry && (stats.incompleteReasons.length || stats.visibleMessages === 0) ? "Error" : entry && stats.warnings.length ? "Review" : entry ? "Ready" : "Waiting");
    return {
      extension: true,
      platform: platformId,
      platformLabel: platformDefinition.label,
      conversationId: currentId,
      title: parsedDocument ? parsedDocument.title : window.document.title || "",
      capturedAt: entry ? entry.capturedAt : null,
      captured: Boolean(entry),
      mappingNodes: stats ? stats.mappingNodes : 0,
      activePathNodes: stats ? stats.activePathNodes : 0,
      activePathMessages: stats ? stats.visibleMessages : 0,
      rawJsonSize: entry ? entry.rawSize : 0,
      pagesCaptured: entry ? entry.pageCount : currentPageCount(currentId),
      incompleteReasons: stats ? stats.incompleteReasons : [],
      warnings: stats ? stats.warnings : [],
      warningSummary: parsedDocument ? parsedDocument.warningSummary : "",
      state,
      readyReason: reason,
      diagnostics: {
        ...runtimeDiagnostics,
        currentUrl: safeCurrentUrl(),
        conversationId: currentId,
        pagesCaptured: entry ? entry.pageCount : currentPageCount(currentId),
        paginationState: entry ? entry.paginationState : runtimeDiagnostics.paginationState,
        mapping: Boolean(stats ? stats.mappingNodes : runtimeDiagnostics.lastSchema.mapping),
        currentNode: Boolean(stats ? stats.activePathNodes : runtimeDiagnostics.lastSchema.currentNode),
        readyReason: reason,
        lastDetectedKeys: runtimeDiagnostics.lastDetectedKeys.slice(),
        lastSchema: { ...runtimeDiagnostics.lastSchema }
      }
    };
  }

  function text(value) {
    return value === undefined || value === null || value === "" ? "—" : String(value);
  }

  function updatePanel() {
    const snapshot = status();
    if (quickExport && typeof quickExport.update === "function") {
      quickExport.update(snapshot);
    }
  }

  function downloadText(filename, content, mimeType) {
    return converter.downloadText(filename, content, mimeType);
  }

  async function exportCurrent() {
    await namingConfigReady;
    if (platformId === "gemini") {
      lastError = "Gemini 当前仍是 UNVERIFIED/INCOMPLETE 诊断状态；正式 Raw + Markdown 尚未开放";
      updatePanel();
      return { ok: false, error: lastError };
    }
    const entry = currentEntry();
    if (!entry) {
      lastError = "尚未捕获完整 conversation 数据，可刷新当前会话后重试";
      updatePanel();
      return { ok: false, error: lastError };
    }
    if (entry.document.stats.incompleteReasons.length) {
      lastError = `捕获响应明确表示不完整：${entry.document.stats.incompleteReasons.join("；")}`;
      updatePanel();
      return { ok: false, error: lastError };
    }
    if (entry.document.messages.length === 0) {
      lastError = "active path 上没有可导出的 user/assistant 可见消息";
      updatePanel();
      return { ok: false, error: lastError };
    }
    try {
      const rendered = converter.renderMarkdown(entry.payload);
      const stem = converter.filenameStem(entry.document.title, entry.document.conversationId || currentId);
      // No artificial length limit: stringify and Blob retain the full payload.
      const rawText = entry.rawText || `${JSON.stringify(entry.payload, null, 2)}\n`;
      const files = await converter.downloadExport(stem, rawText, rendered.markdown);
      lastError = "";
      updatePanel();
      return { ok: true, files };
    } catch (error) {
      lastError = `导出失败：${error && error.message ? error.message : String(error)}`;
      updatePanel();
      return { ok: false, error: lastError };
    }
  }

  function exportGeminiDebugBundle() {
    if (platformId !== "gemini" || geminiRecords.length === 0) {
      return { ok: false, error: "尚未捕获 Gemini structured response；没有可导出的 debug bundle" };
    }
    try {
      const bundle = geminiDebugBundle();
      const stem = converter.filenameStem(currentConversationTitle(), currentId || "gemini-conversation");
      const filename = `${stem}.gemini.debug.raw.json`;
      downloadText(filename, `${JSON.stringify(bundle, null, 2)}\n`, "application/json");
      return { ok: true, files: [filename] };
    } catch (error) {
      return { ok: false, error: `debug bundle 导出失败：${error && error.message ? error.message : String(error)}` };
    }
  }

  function capture(payload) {
    const payloadId = payload && (payload.conversation_id || payload.id)
      ? String(payload.conversation_id || payload.id)
      : null;
    if (payloadId && currentId && payloadId !== currentId) {
      runtimeDiagnostics.rejectedIdMismatches += 1;
      updatePanel();
      return;
    }
    const id = payloadId || currentId;
    if (!id) {
      lastError = "捕获到 conversation candidate，但当前 URL 没有可匹配的 conversation id";
      updatePanel();
      return;
    }
    basePayloads.set(id, payload);
    rebuildConversation(id);
  }

  function captureMessagePage(conversationId, payload, pageKey) {
    const id = conversationId ? String(conversationId) : currentId;
    if (!id) return;
    if (currentId && id !== currentId) {
      runtimeDiagnostics.rejectedIdMismatches += 1;
      return;
    }
    const pages = messagePages.get(id) || [];
    if (pageKey && pages.some((page) => page.pageKey === pageKey)) return;
    pages.push({ pageKey: pageKey || `page-${pages.length + 1}`, payload });
    messagePages.set(id, pages);
    runtimeDiagnostics.capturedPageCount = pages.length;
    if (basePayloads.has(id)) rebuildConversation(id);
    else updatePanel();
  }

  function mergeObserverDiagnostics(info) {
    if (!info || typeof info !== "object") return;
    if (typeof info.platform === "string" && info.platform !== "unsupported" && info.platform !== platformId) {
      platformId = info.platform;
      platformDefinition = platformCore && typeof platformCore.definition === "function"
        ? platformCore.definition(platformId)
        : { id: platformId, label: platformId };
      currentId = currentConversationId();
      if (platformId === "gemini") {
        geminiRecords.length = 0;
        geminiRecordKeys.clear();
      }
      if (platformId === "chatgpt" && !dotHistory) {
        buildDotHistoryUI();
      }
    }
    const aggregateOnlyKeys = new Set(["candidateResponses", "candidateUserTurns", "candidateAssistantTurns", "normalizedUserTurns", "normalizedAssistantTurns", "possibleTotalTurns", "topLevelShape", "structuralSignature", "paginationDetected", "truncationDetected", "branchSelection", "completeness", "readyReason", "geminiConversationCandidates", "geminiLastTopLevelKeys", "geminiLastWrapperDepth", "geminiLastTurnCount", "geminiLastUserMessages", "geminiLastAssistantMessages", "geminiPaginationDetected", "geminiPaginationSignals", "geminiPaginationPossible", "geminiTruncationDetected", "geminiTruncationSignals", "geminiCompleteness", "geminiSchemaVerified", "geminiOrderingValidated", "geminiSchemaVariant", "geminiBranchSelection", "geminiLastFieldHints", "geminiLastConversationId", "geminiResponseCount", "geminiLastRpcId", "geminiLastCandidatePath", "geminiLastCandidateContentType", "geminiRpcSummaries"]);
    for (const key of ["injected", "fetchObserved", "xhrObserved", "jsonCandidates", "conversationCandidates", "jsonParseErrors", "streamResponses", "webSocketObserved", "webSocketMessages", "conversationEndpointObserved", "currentConversationEndpointResponses", "fallbackAttempts", "fallbackResponses", "fallbackConversationCandidates", "fallbackLastResult", "fallbackConfigured", "fallbackSkipReason", "fallbackLastEndpoint", "messagePageResponses", "messagePageCandidates", "messagePagePreviousTrue", "messagePagePreviousFalse", "messagePagePreviousUnknown", "messagePageNextTrue", "messagePageNextFalse", "messagePageNextUnknown", "cachedMessagePages", "lastMessagePageKeys", "lastContentType", "lastResponsePath", "observedResponsePaths", "cacheSize", "fetchHooked", "xhrHooked", "lastCandidatePath", "lastCandidateContentType"]) {
      if (info[key] !== undefined) runtimeDiagnostics[key] = info[key];
    }
    if (Array.isArray(info.lastDetectedKeys)) runtimeDiagnostics.lastDetectedKeys = info.lastDetectedKeys.slice(0, 80);
    if (Array.isArray(info.lastEndpointKeys)) runtimeDiagnostics.lastEndpointKeys = info.lastEndpointKeys.slice(0, 80);
    if (Array.isArray(info.lastMessagePageKeys)) runtimeDiagnostics.lastMessagePageKeys = info.lastMessagePageKeys.slice(0, 80);
    if (info.lastSchema && typeof info.lastSchema === "object") runtimeDiagnostics.lastSchema = { ...runtimeDiagnostics.lastSchema, ...info.lastSchema };
    if (info.lastEndpointSchema && typeof info.lastEndpointSchema === "object") runtimeDiagnostics.lastEndpointSchema = { ...runtimeDiagnostics.lastEndpointSchema, ...info.lastEndpointSchema };
    for (const key of ["platform", "platformLabel", "candidateResponses", "candidateUserTurns", "candidateAssistantTurns", "normalizedUserTurns", "normalizedAssistantTurns", "possibleTotalTurns", "topLevelShape", "structuralSignature", "paginationDetected", "truncationDetected", "branchSelection", "completeness", "readyReason", "geminiConversationCandidates", "geminiLastTopLevelKeys", "geminiLastWrapperDepth", "geminiLastTurnCount", "geminiLastUserMessages", "geminiLastAssistantMessages", "geminiPaginationDetected", "geminiPaginationSignals", "geminiPaginationPossible", "geminiTruncationDetected", "geminiTruncationSignals", "geminiCompleteness", "geminiSchemaVerified", "geminiOrderingValidated", "geminiSchemaVariant", "geminiBranchSelection", "geminiLastFieldHints", "geminiLastConversationId", "geminiResponseCount", "geminiLastRpcId", "geminiLastCandidatePath", "geminiLastCandidateContentType", "geminiRpcSummaries", "batchResponses", "batchFrames", "batchInnerPayloads", "batchParseFailures", "batchRpcIds"]) {
      if (info[key] !== undefined && !(platformId === "gemini" && aggregateOnlyKeys.has(key))) runtimeDiagnostics[key] = info[key];
    }
    if (Array.isArray(info.geminiLastTopLevelKeys)) runtimeDiagnostics.geminiLastTopLevelKeys = info.geminiLastTopLevelKeys.slice(0, 80);
    if (Array.isArray(info.geminiPaginationSignals)) runtimeDiagnostics.geminiPaginationSignals = info.geminiPaginationSignals.slice(0, 20);
    if (Array.isArray(info.geminiTruncationSignals)) runtimeDiagnostics.geminiTruncationSignals = info.geminiTruncationSignals.slice(0, 20);
    if (Array.isArray(info.geminiLastFieldHints)) runtimeDiagnostics.geminiLastFieldHints = info.geminiLastFieldHints.slice(0, 40);
    if (Array.isArray(info.batchRpcIds)) runtimeDiagnostics.batchRpcIds = info.batchRpcIds.slice(-40);
    if (Array.isArray(info.geminiRpcSummaries)) runtimeDiagnostics.geminiRpcSummaries = info.geminiRpcSummaries.slice(-40);
    if (platformId === "gemini" && geminiRecords.length) syncGeminiDiagnostics();
    updatePanel();
  }

  function requestRescan() {
    lastError = "";
    runtimeDiagnostics.lastRescan = `requested ${new Date().toISOString()}`;
    window.postMessage({ source: SOURCE, type: "rescan", conversationId: currentId }, "*");
    updatePanel();
  }

  // --- Theme Management ---
  function detectTheme() {
    const html = document.documentElement;
    const body = document.body;
    const explicit = html?.getAttribute("data-theme") || body?.getAttribute("data-theme");
    if (explicit === "dark" || explicit === "light") return explicit;
    if (html?.classList.contains("dark") || body?.classList.contains("dark")) return "dark";
    if (html?.classList.contains("light") || body?.classList.contains("light")) return "light";
    try {
      const bg = window.getComputedStyle(body || html).backgroundColor;
      const match = bg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      if (match) {
        const lum = (0.2126 * match[1] + 0.7152 * match[2] + 0.0722 * match[3]) / 255;
        return lum < 0.5 ? "dark" : "light";
      }
    } catch (_) {}
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function applyThemeToRoots() {
    const theme = detectTheme();
    const addClass = theme === "dark" ? "cce-theme-dark" : "cce-theme-light";
    const removeClass = theme === "dark" ? "cce-theme-light" : "cce-theme-dark";
    if (quickExport && quickExport.root) {
      quickExport.root.classList.remove(removeClass);
      quickExport.root.classList.add(addClass);
    }
    if (dotHistory && dotHistory.root) {
      dotHistory.root.classList.remove(removeClass);
      dotHistory.root.classList.add(addClass);
    }
  }

  function initThemeSync() {
    applyThemeToRoots();
    const observer = new MutationObserver(() => applyThemeToRoots());
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
    if (document.body) {
      observer.observe(document.body, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    if (media && media.addEventListener) media.addEventListener("change", applyThemeToRoots);
  }

  // --- In-Page Quick Export UI ---
  function buildQuickExportUI() {
    if (quickExport || !document.documentElement) return;
    const host = document.createElement("div");
    host.id = "cce-quick-export-host";
    host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483645;pointer-events:none;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; -webkit-font-smoothing: antialiased; }
        * { box-sizing: border-box; }
        .cce-quick-shell { pointer-events: auto; display: flex; flex-direction: column; align-items: flex-end; }
        .cce-theme-light {
          --cce-bg: rgba(255, 255, 255, 0.96);
          --cce-surface-hover: #f0f0f0;
          --cce-border: rgba(0, 0, 0, 0.1);
          --cce-border-subtle: rgba(0, 0, 0, 0.06);
          --cce-text-primary: #0d0d0d;
          --cce-text-secondary: #5d5d5d;
          --cce-text-tertiary: #8e8e8e;
          --cce-shadow-pill: 0 2px 8px rgba(0, 0, 0, 0.06);
          --cce-shadow-menu: 0 4px 16px rgba(0, 0, 0, 0.1);
        }
        .cce-theme-dark {
          --cce-bg: rgba(33, 33, 33, 0.96);
          --cce-surface-hover: #383838;
          --cce-border: rgba(255, 255, 255, 0.12);
          --cce-border-subtle: rgba(255, 255, 255, 0.08);
          --cce-text-primary: #ececec;
          --cce-text-secondary: #b4b4b4;
          --cce-text-tertiary: #737373;
          --cce-shadow-pill: 0 2px 10px rgba(0, 0, 0, 0.3);
          --cce-shadow-menu: 0 6px 20px rgba(0, 0, 0, 0.4);
        }
        .cce-quick-pill {
          display: inline-flex;
          align-items: center;
          height: 32px;
          background: var(--cce-bg);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          border: 1px solid var(--cce-border);
          border-radius: 8px;
          box-shadow: var(--cce-shadow-pill);
          overflow: hidden;
          transition: border-color 150ms ease, box-shadow 150ms ease;
        }
        .cce-quick-pill:hover { border-color: var(--cce-text-tertiary); }
        .cce-quick-btn {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          height: 100%;
          padding: 0 10px;
          border: 0;
          background: transparent;
          color: var(--cce-text-primary);
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          user-select: none;
          transition: background-color 150ms ease;
        }
        .cce-quick-btn:hover:not(:disabled) { background: var(--cce-surface-hover); }
        .cce-quick-btn:disabled { opacity: 0.45; cursor: not-allowed; }
        .cce-quick-btn svg { width: 13px; height: 13px; flex-shrink: 0; }
        .cce-format-trigger {
          display: inline-flex;
          align-items: center;
          gap: 3px;
          height: 100%;
          padding: 0 7px;
          border: 0;
          border-left: 1px solid var(--cce-border-subtle);
          background: transparent;
          color: var(--cce-text-secondary);
          font-size: 10.5px;
          font-weight: 600;
          cursor: pointer;
          user-select: none;
          transition: background-color 150ms ease, color 150ms ease;
        }
        .cce-format-trigger:hover { background: var(--cce-surface-hover); color: var(--cce-text-primary); }
        .cce-format-trigger svg { width: 9px; height: 9px; transition: transform 150ms ease; }
        .cce-format-trigger[aria-expanded="true"] svg { transform: rotate(180deg); }
        .cce-format-menu {
          position: absolute;
          bottom: 38px;
          right: 0;
          min-width: 135px;
          background: var(--cce-bg);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          border: 1px solid var(--cce-border);
          border-radius: 8px;
          box-shadow: var(--cce-shadow-menu);
          padding: 4px;
          display: none;
          flex-direction: column;
          gap: 2px;
        }
        .cce-format-menu.is-open { display: flex; }
        .cce-format-item, .cce-debug-item {
          width: 100%;
          padding: 6px 8px;
          border: 0;
          border-radius: 6px;
          background: transparent;
          color: var(--cce-text-primary);
          font-size: 11.5px;
          font-weight: 400;
          text-align: left;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: space-between;
          transition: background-color 120ms ease;
        }
        .cce-format-item:hover, .cce-debug-item:hover { background: var(--cce-surface-hover); }
        .cce-format-item.is-selected { font-weight: 600; }
        .cce-format-item.is-selected::after { content: "✓"; font-size: 11px; }
      </style>
      <div class="cce-quick-shell cce-theme-light">
        <div class="cce-quick-pill">
          <button class="cce-quick-btn" type="button" aria-label="导出当前会话" title="导出当前会话" disabled>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
            <span class="cce-quick-label">导出</span>
          </button>
          <button class="cce-format-trigger" type="button" aria-label="选择导出格式" aria-expanded="false" title="选择格式">
            <span class="cce-format-badge">MD</span>
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M3 4.5l3 3 3-3"></path>
            </svg>
          </button>
        </div>
        <div class="cce-format-menu" role="menu" aria-hidden="true">
          <button class="cce-format-item" data-format="markdown" type="button" role="menuitem">Markdown</button>
          <button class="cce-format-item" data-format="json" type="button" role="menuitem">JSON</button>
          <button class="cce-format-item" data-format="both" type="button" role="menuitem">两者 (MD+JSON)</button>
          <button class="cce-debug-item" type="button" role="menuitem" style="display:none;">Debug Bundle</button>
        </div>
      </div>`;

    const root = shadow.querySelector(".cce-quick-shell");
    const btn = shadow.querySelector(".cce-quick-btn");
    const label = shadow.querySelector(".cce-quick-label");
    const formatTrigger = shadow.querySelector(".cce-format-trigger");
    const formatBadge = shadow.querySelector(".cce-format-badge");
    const formatMenu = shadow.querySelector(".cce-format-menu");
    const formatItems = Array.from(shadow.querySelectorAll(".cce-format-item"));
    const debugItem = shadow.querySelector(".cce-debug-item");

    let currentFormat = "markdown";
    const formatLabels = { markdown: "MD", json: "JSON", both: "All" };

    function syncFormatSelection(format) {
      currentFormat = ["markdown", "json", "both"].includes(format) ? format : "markdown";
      formatBadge.textContent = formatLabels[currentFormat] || "MD";
      formatItems.forEach((it) => it.classList.toggle("is-selected", it.dataset.format === currentFormat));
    }

    chrome.storage.local.get({ exportFormat: "markdown" }).then(({ exportFormat }) => {
      syncFormatSelection(exportFormat);
      updatePanel();
    }).catch(() => {});

    function closeFormatMenu() {
      formatMenu.classList.remove("is-open");
      formatTrigger.setAttribute("aria-expanded", "false");
    }

    function toggleFormatMenu() {
      const open = formatMenu.classList.toggle("is-open");
      formatTrigger.setAttribute("aria-expanded", String(open));
    }

    formatTrigger.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleFormatMenu();
    });

    formatItems.forEach((item) => {
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        const nextFmt = item.dataset.format;
        chrome.storage.local.set({ exportFormat: nextFmt });
        syncFormatSelection(nextFmt);
        closeFormatMenu();
        updatePanel();
      });
    });

    if (debugItem) {
      debugItem.addEventListener("click", (e) => {
        e.stopPropagation();
        closeFormatMenu();
        exportGeminiDebugBundle();
      });
    }

    document.addEventListener("click", (e) => {
      if (!host.contains(e.target)) closeFormatMenu();
    });

    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      closeFormatMenu();
      if (btn.disabled) return;
      btn.disabled = true;
      const prevText = label.textContent;
      label.textContent = "导出中…";
      try {
        const result = await exportCurrent();
        if (result && result.ok) {
          label.textContent = "已导出 ✓";
          setTimeout(() => {
            label.textContent = prevText;
            updatePanel();
          }, 1500);
        } else {
          label.textContent = "导出失败";
          btn.title = (result && result.error) || "导出失败";
          setTimeout(() => {
            label.textContent = prevText;
            updatePanel();
          }, 2000);
        }
      } catch (err) {
        label.textContent = "导出失败";
        btn.title = (err && err.message) || String(err);
        setTimeout(() => {
          label.textContent = prevText;
          updatePanel();
        }, 2000);
      }
    });

    quickExport = {
      root,
      btn,
      label,
      debugItem,
      update: (snapshot) => {
        const ready = snapshot.captured && snapshot.incompleteReasons.length === 0 && snapshot.activePathMessages > 0;
        btn.disabled = !ready;
        btn.title = ready ? `导出当前会话 (${formatLabels[currentFormat] || "MD"})` : (lastError || snapshot.readyReason || "等待捕获会话数据…");
        if (debugItem) {
          debugItem.style.display = platformId === "gemini" && snapshot.debugBundleAvailable ? "flex" : "none";
        }
      }
    };

    document.documentElement.appendChild(host);
    applyThemeToRoots();
  }

  // --- Dot History Navigator UI (ChatGPT only) ---
  function buildDotHistoryUI() {
    if (dotHistory || platformId !== "chatgpt" || !navigatorBackend || !document.documentElement) return;

    const host = document.createElement("div");
    host.id = "cce-dot-history-host";
    host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483646;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; -webkit-font-smoothing: antialiased; }
        * { box-sizing: border-box; }
        .cce-theme-light {
          --cce-bg: #ffffff;
          --cce-border: rgba(0, 0, 0, 0.08);
          --cce-text-primary: #0d0d0d;
          --cce-text-secondary: #5d5d5d;
          --cce-text-tertiary: #8e8e8e;
          --cce-handle-hover: rgba(0, 0, 0, 0.06);
          --cce-dot-muted: rgba(0, 0, 0, 0.25);
          --cce-dot-active: #0d0d0d;
          --cce-shadow-popover: 0 4px 16px rgba(0, 0, 0, 0.08);
        }
        .cce-theme-dark {
          --cce-bg: #262626;
          --cce-border: rgba(255, 255, 255, 0.1);
          --cce-text-primary: #ececec;
          --cce-text-secondary: #b4b4b4;
          --cce-text-tertiary: #737373;
          --cce-handle-hover: rgba(255, 255, 255, 0.08);
          --cce-dot-muted: rgba(255, 255, 255, 0.28);
          --cce-dot-active: #ececec;
          --cce-shadow-popover: 0 6px 20px rgba(0, 0, 0, 0.35);
        }
        .cce-dot-shell { pointer-events: none; width: 100%; height: 100%; position: relative; }
        .cce-dot-handle {
          position: fixed;
          width: 44px;
          height: 32px;
          padding: 0;
          border: 0;
          border-radius: 8px;
          background: transparent;
          color: var(--cce-text-tertiary);
          cursor: grab;
          z-index: 2147483647;
          display: flex;
          align-items: center;
          justify-content: center;
          touch-action: none;
          pointer-events: auto;
          user-select: none;
          transition: background-color 150ms ease, color 150ms ease;
        }
        .cce-dot-handle:hover,
        .cce-dot-handle[aria-expanded="true"] {
          background: var(--cce-handle-hover);
          color: var(--cce-text-secondary);
        }
        .cce-dot-handle.is-dragging { cursor: grabbing; transition: none; }
        .cce-dot-handle:focus-visible { outline: 1px solid var(--cce-text-secondary); outline-offset: 1px; }
        .cce-dot-handle-mark { display: flex; gap: 7px; align-items: center; }
        .cce-dot-handle-mark i { width: 3px; height: 3px; border-radius: 50%; background: currentColor; display: block; }
        .cce-dot-timeline {
          position: fixed;
          width: 44px;
          z-index: 2147483646;
          pointer-events: auto;
          user-select: none;
          transition: opacity 150ms ease;
        }
        .cce-dot-timeline.is-hidden { display: none; }
        .cce-dot-track {
          height: 100%;
          width: 100%;
          overflow-y: auto;
          overflow-x: hidden;
          overscroll-behavior: contain;
          scrollbar-width: none;
        }
        .cce-dot-track::-webkit-scrollbar { display: none; }
        .cce-dot-content { position: relative; width: 100%; }
        .cce-dot-node {
          position: absolute;
          left: 50%;
          width: 28px;
          height: 28px;
          transform: translate(-50%, -50%);
          padding: 0;
          border: 0;
          border-radius: 50%;
          background: transparent;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .cce-dot {
          width: 4px;
          height: 4px;
          border-radius: 50%;
          background: var(--cce-dot-muted);
          transition: transform 150ms ease, background-color 150ms ease;
          pointer-events: none;
        }
        .cce-dot-node:hover .cce-dot,
        .cce-dot-node:focus-visible .cce-dot {
          background: var(--cce-dot-active);
          transform: scale(1.4);
        }
        .cce-dot-node.is-active .cce-dot {
          background: var(--cce-dot-active);
          transform: scale(1.75);
        }
        .cce-dot-node:focus-visible { outline: 1px solid var(--cce-text-secondary); outline-offset: 1px; }
        .cce-dot-preview {
          position: absolute;
          right: 48px;
          left: auto;
          width: max-content;
          max-width: min(260px, calc(100vw - 76px));
          box-sizing: border-box;
          border: 1px solid var(--cce-border);
          border-radius: 8px;
          padding: 8px 10px;
          font-size: 12px;
          line-height: 1.45;
          overflow-wrap: anywhere;
          color: var(--cce-text-primary);
          background: var(--cce-bg);
          box-shadow: var(--cce-shadow-popover);
          opacity: 0;
          visibility: hidden;
          pointer-events: none;
          transition: opacity 120ms ease;
          z-index: 2147483647;
        }
        .cce-dot-preview.is-visible { opacity: 1; visibility: visible; }
        .cce-dot-timeline.is-flipped .cce-dot-preview { left: 48px; right: auto; }
      </style>
      <div class="cce-dot-shell cce-theme-light">
        <button class="cce-dot-handle" type="button" aria-label="Toggle prompt history" aria-expanded="false" title="Prompt History">
          <span class="cce-dot-handle-mark" aria-hidden="true">
            <i></i><i></i><i></i>
          </span>
        </button>
        <div class="cce-dot-timeline is-hidden" aria-label="Prompt Timeline">
          <div class="cce-dot-track">
            <div class="cce-dot-content"></div>
          </div>
          <div class="cce-dot-preview" role="tooltip"></div>
        </div>
      </div>`;

    const root = shadow.querySelector(".cce-dot-shell");
    const handle = shadow.querySelector(".cce-dot-handle");
    const timeline = shadow.querySelector(".cce-dot-timeline");
    const track = shadow.querySelector(".cce-dot-track");
    const content = shadow.querySelector(".cce-dot-content");
    const preview = shadow.querySelector(".cce-dot-preview");

    let isExpanded = false;
    let initializedForCurrent = false;
    let currentItems = [];
    let activeIndex = -1;

    function clampPosition(left, top) {
      const maxLeft = Math.max(8, window.innerWidth - 44 - 8);
      const maxTop = Math.max(8, window.innerHeight - 32 - 8);
      return {
        left: Math.max(8, Math.min(maxLeft, left)),
        top: Math.max(8, Math.min(maxTop, top))
      };
    }

    function applyHandlePosition(left, top) {
      const clamped = clampPosition(left, top);
      handle.style.left = `${clamped.left}px`;
      handle.style.top = `${clamped.top}px`;
      handle.style.right = "auto";
      updateTimelinePosition();
    }

    const defaultLeft = window.innerWidth - 44 - 16;
    const defaultTop = (window.innerHeight - 32) / 2;
    applyHandlePosition(defaultLeft, defaultTop);

    chrome.storage.local.get({ cce_dot_position: null }).then(({ cce_dot_position }) => {
      if (cce_dot_position && typeof cce_dot_position.left === "number" && typeof cce_dot_position.top === "number") {
        applyHandlePosition(cce_dot_position.left, cce_dot_position.top);
      }
    }).catch(() => {});

    let isDragging = false;
    let hasMoved = false;
    let startX = 0, startY = 0;
    let startLeft = 0, startTop = 0;
    let curLeft = 0, curTop = 0;

    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      startX = e.clientX;
      startY = e.clientY;
      const rect = handle.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      curLeft = startLeft;
      curTop = startTop;
      isDragging = true;
      hasMoved = false;
      handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener("pointermove", (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!hasMoved) {
        if (dx * dx + dy * dy < 25) return;
        hasMoved = true;
        handle.classList.add("is-dragging");
        hidePreview();
      }
      const nextPos = clampPosition(startLeft + dx, startTop + dy);
      curLeft = nextPos.left;
      curTop = nextPos.top;
      handle.style.left = `${curLeft}px`;
      handle.style.top = `${curTop}px`;
      handle.style.right = "auto";
      updateTimelinePosition();
    });

    function finishDrag() {
      if (!isDragging) return;
      isDragging = false;
      handle.classList.remove("is-dragging");
      if (hasMoved) {
        chrome.storage.local.set({ cce_dot_position: { left: curLeft, top: curTop } });
      }
    }

    handle.addEventListener("pointerup", finishDrag);
    handle.addEventListener("pointercancel", finishDrag);

    window.addEventListener("resize", () => {
      const rect = handle.getBoundingClientRect();
      applyHandlePosition(rect.left, rect.top);
    });

    function updateTimelinePosition() {
      if (!isExpanded) return;
      const anchor = handle.getBoundingClientRect();
      const below = window.innerHeight - anchor.bottom - 16;
      const above = anchor.top - 16;
      const isBelow = below >= above;
      const trackHeight = Math.max(48, Math.min(360, isBelow ? below : above));
      const top = isBelow ? anchor.bottom + 6 : anchor.top - trackHeight - 6;
      timeline.style.left = `${anchor.left}px`;
      timeline.style.top = `${Math.max(8, top)}px`;
      timeline.style.height = `${trackHeight}px`;

      const isFlipped = anchor.left < window.innerWidth / 2;
      timeline.classList.toggle("is-flipped", isFlipped);
    }

    function showPreview(index, node) {
      const item = currentItems[index];
      if (!item || !preview) return;
      preview.textContent = item.preview || item.text || `Prompt ${item.order || index + 1}`;
      preview.classList.add("is-visible");
      const nodeRect = node.getBoundingClientRect();
      const timelineRect = timeline.getBoundingClientRect();
      const previewHeight = preview.offsetHeight || 32;
      const targetTop = (nodeRect.top + nodeRect.height / 2) - previewHeight / 2;
      const clampedTop = Math.max(8, Math.min(window.innerHeight - previewHeight - 8, targetTop));
      preview.style.top = `${clampedTop - timelineRect.top}px`;
    }

    function hidePreview() {
      if (preview) preview.classList.remove("is-visible");
    }

    track.addEventListener("wheel", (e) => {
      if (content.scrollHeight > track.clientHeight) {
        e.preventDefault();
        e.stopPropagation();
        track.scrollTop += e.deltaY;
        hidePreview();
      }
    }, { passive: false });

    function setActiveDot(index) {
      activeIndex = index;
      const buttons = content.querySelectorAll(".cce-dot-node");
      buttons.forEach((btn, idx) => {
        btn.classList.toggle("is-active", idx === index);
      });
    }

    function renderDots(items) {
      currentItems = Array.isArray(items) ? items : [];
      content.innerHTML = "";
      if (currentItems.length === 0) return;

      const count = currentItems.length;
      const trackHeight = track.clientHeight || 280;
      const pitch = count <= 1 ? 24 : Math.min(24, Math.max(8, (trackHeight - 20) / (count - 1)));
      const contentHeight = Math.max(trackHeight, count * pitch + 16);
      content.style.height = `${contentHeight}px`;

      const fragment = document.createDocumentFragment();
      currentItems.forEach((item, index) => {
        const node = document.createElement("button");
        node.type = "button";
        node.className = "cce-dot-node";
        node.dataset.index = String(index);
        node.setAttribute("aria-label", `Jump to prompt ${item.order || index + 1}`);

        const dot = document.createElement("span");
        dot.className = "cce-dot";
        node.appendChild(dot);

        const topPx = 10 + index * pitch;
        node.style.top = `${topPx}px`;

        node.addEventListener("mouseenter", () => showPreview(index, node));
        node.addEventListener("mouseleave", hidePreview);
        node.addEventListener("focus", () => showPreview(index, node));
        node.addEventListener("blur", hidePreview);
        node.addEventListener("click", () => {
          navigatorBackend.jumpToPrompt(item);
          setActiveDot(index);
        });

        fragment.appendChild(node);
      });
      content.appendChild(fragment);

      if (activeIndex >= 0 && activeIndex < count) {
        setActiveDot(activeIndex);
      } else {
        setActiveDot(count - 1);
      }
    }

    function setExpanded(expanded) {
      isExpanded = expanded;
      handle.setAttribute("aria-expanded", String(expanded));
      timeline.classList.toggle("is-hidden", !expanded);
      if (expanded) {
        updateTimelinePosition();
        if (!initializedForCurrent) {
          initializedForCurrent = true;
          globalThis.CCEHistoryNavigator.open();
        }
        renderDots(navigatorBackend.getState().items);
      } else {
        hidePreview();
      }
    }

    handle.addEventListener("click", (e) => {
      if (hasMoved) {
        hasMoved = false;
        return;
      }
      setExpanded(!isExpanded);
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && isExpanded) {
        setExpanded(false);
        handle.focus();
      }
    });

    navigatorBackend.subscribe((state) => {
      if (isExpanded && state.items) {
        renderDots(state.items);
      }
    });

    let scrollThrottle = null;
    function syncActiveFromViewport() {
      if (!isExpanded || currentItems.length === 0) return;
      const viewportCenter = window.innerHeight / 2;
      let closestIdx = -1;
      let minDistance = Infinity;

      for (let i = 0; i < currentItems.length; i++) {
        const item = currentItems[i];
        let el = item.node;
        if (!el || !el.isConnected) {
          if (item.messageId) {
            el = document.querySelector(`[data-message-id="${item.messageId}"], [data-turn-id="${item.messageId}"]`);
            if (el) item.node = el;
          }
        }
        if (el && el.isConnected) {
          const rect = el.getBoundingClientRect();
          const center = (rect.top + rect.bottom) / 2;
          const dist = Math.abs(center - viewportCenter);
          if (dist < minDistance) {
            minDistance = dist;
            closestIdx = i;
          }
        }
      }

      if (closestIdx >= 0 && closestIdx !== activeIndex) {
        setActiveDot(closestIdx);
      }
    }

    window.addEventListener("scroll", () => {
      if (scrollThrottle) return;
      scrollThrottle = requestAnimationFrame(() => {
        scrollThrottle = null;
        syncActiveFromViewport();
      });
    }, { passive: true });

    dotHistory = {
      root,
      reset: () => {
        initializedForCurrent = false;
        currentItems = [];
        activeIndex = -1;
        if (isExpanded) {
          setExpanded(false);
        }
      }
    };

    document.documentElement.appendChild(host);
    applyThemeToRoots();
  }

  function buildUI() {
    buildQuickExportUI();
    if (platformId === "chatgpt") {
      buildDotHistoryUI();
    }
    initThemeSync();
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.source !== SOURCE) return;
    if (event.data.type === "observer-status") mergeObserverDiagnostics(event.data.diagnostics);
    if (event.data.type === "conversation-response") capture(event.data.payload);
    if (event.data.type === "conversation-message-page") captureMessagePage(event.data.conversationId, event.data.payload, event.data.pageKey);
    if (event.data.type === "gemini-structure") captureGeminiStructure(event.data);
  });

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || !message.type) return false;
      if (message.type === "GET_STATUS") {
        sendResponse(status());
        return false;
      }
      if (message.type === "EXPORT_CURRENT") {
        exportCurrent().then(sendResponse).catch((error) => sendResponse({ ok: false, error: `导出失败：${error && error.message ? error.message : String(error)}` }));
        return true;
      }
      if (message.type === "EXPORT_DEBUG_BUNDLE") {
        sendResponse(exportGeminiDebugBundle());
        return false;
      }
      if (message.type === "RESCAN_CURRENT") {
        requestRescan();
        sendResponse(status());
        return false;
      }
      return false;
    });
  }

  function injectObserver() {
    if (!document.documentElement || document.documentElement.querySelector("script[data-cce-observer]")) return;
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("injected.js");
    script.dataset.cceObserver = "true";
    script.onload = () => script.remove();
    script.onerror = () => {
      runtimeDiagnostics.injectionError = "injected.js script element failed to load";
      updatePanel();
    };
    (document.head || document.documentElement).appendChild(script);
  }

  const navigatorBackend =
    platformId === "chatgpt" && globalThis.CCEChatGPTNavigator && typeof globalThis.CCEChatGPTNavigator.createChatGPTNavigatorBackend === "function"
      ? globalThis.CCEChatGPTNavigator.createChatGPTNavigatorBackend({ converter })
      : null;

  if (navigatorBackend) {
    globalThis.CCEHistoryNavigator = {
      ...navigatorBackend,
      open: (opt) => navigatorBackend.open(currentId, basePayloads.get(currentId), opt),
      init: (opt) => navigatorBackend.init(currentId, basePayloads.get(currentId), opt)
    };
  }

  injectObserver();
  // If the MAIN-world declaration ran before this isolated listener, ask it
  // to replay its bounded in-memory candidate cache after the listener exists.
  window.setTimeout(requestRescan, 0);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      injectObserver();
      buildUI();
    }, { once: true });
  }
  else buildUI();
  window.setInterval(() => {
    const nextId = currentConversationId();
    if (nextId !== currentId) {
      currentId = nextId;
      if (navigatorBackend) {
        navigatorBackend.resetForConversation(nextId);
        if (dotHistory && typeof dotHistory.reset === "function") {
          dotHistory.reset();
        }
      }
      if (platformId === "gemini") {
        geminiRecords.length = 0;
        geminiRecordKeys.clear();
        syncGeminiDiagnostics();
      }
      lastError = "";
      updatePanel();
    }
  }, 750);
})();
