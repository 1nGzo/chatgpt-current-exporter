/*
 * Browser-side companion to exporter/conversation.py and markdown.py.
 * It intentionally implements the same current_node -> parent walk so that a
 * click can download both files without sending private conversation data to a
 * server or depending on the Python process being running.
 */
(function (root) {
  "use strict";

  const VISIBLE_ROLES = new Set(["user", "assistant"]);
  const INTERNAL_CONTENT_TYPES = new Set(["thoughts", "reasoning_recap"]);
  let localNamingRules = [];

  function setNamingRules(rawRules) {
    if (!Array.isArray(rawRules)) {
      localNamingRules = [];
      return;
    }
    localNamingRules = rawRules.flatMap((rawRule) => {
      if (!rawRule || typeof rawRule !== "object" || typeof rawRule.title_pattern !== "string" || !rawRule.title_pattern || typeof rawRule.filename_prefix !== "string" || !rawRule.filename_prefix) return [];
      const minimumDigits = rawRule.minimum_digits === undefined ? 3 : rawRule.minimum_digits;
      if (!Number.isInteger(minimumDigits) || minimumDigits < 1 || minimumDigits > 12) return [];
      try {
        const regex = new RegExp(rawRule.title_pattern);
        if (regex.test("") && regex.exec("")?.[1] === undefined) return [];
        return [{ regex, filenamePrefix: rawRule.filename_prefix, minimumDigits }];
      } catch (_) {
        return [];
      }
    });
  }

  function hasMapping(value) {
    return Boolean(value && typeof value === "object" && value.mapping && typeof value.mapping === "object" && !Array.isArray(value.mapping));
  }

  function hasMessageList(value) {
    return Boolean(
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Array.isArray(value.messages) &&
      value.messages.length > 0 &&
      value.current_node !== undefined &&
      value.current_node !== null &&
      value.current_node !== "" &&
      (value.conversation_id || value.id)
    );
  }

  function isConversation(value) {
    return hasMapping(value) || hasMessageList(value);
  }

  function candidate(value) {
    const queue = [{ value, depth: 0 }];
    const seen = new Set();
    while (queue.length) {
      const current = queue.shift();
      const item = current.value;
      if (!item || typeof item !== "object" || seen.has(item)) continue;
      seen.add(item);
      if (isConversation(item)) return item;
      if (current.depth >= 4) continue;
      if (Array.isArray(item)) {
        item.slice(0, 8).forEach((child) => queue.push({ value: child, depth: current.depth + 1 }));
      } else {
        Object.keys(item).slice(0, 80).forEach((key) => {
          const child = item[key];
          if (child && typeof child === "object") queue.push({ value: child, depth: current.depth + 1 });
        });
      }
    }
    return null;
  }

  function conversationId(payload) {
    const value = payload.conversation_id || payload.id;
    return value === undefined || value === null ? null : String(value);
  }

  function title(payload) {
    return typeof payload.title === "string" && payload.title.trim() ? payload.title : "Untitled conversation";
  }

  function explicitIncomplete(payload) {
    const reasons = [];
    for (const key of ["partial", "is_partial", "truncated", "is_truncated", "has_more", "has_more_messages"]) {
      if (payload[key] === true) reasons.push(`payload.${key}=true`);
    }
    for (const key of ["next_cursor", "next_page", "next_token"]) {
      if (payload[key] !== undefined && payload[key] !== null && payload[key] !== "" && payload[key] !== false) {
        reasons.push(`payload.${key} is present`);
      }
    }
    const pagination = payload.pagination;
    if (pagination && typeof pagination === "object") {
      if (pagination.has_more === true) reasons.push("payload.pagination.has_more=true");
      if (pagination.next_cursor !== undefined && pagination.next_cursor !== null && pagination.next_cursor !== "") {
        reasons.push("payload.pagination.next_cursor is present");
      }
    }
    const pageInfo = payload.page_info;
    if (pageInfo && typeof pageInfo === "object") {
      for (const key of ["has_more", "has_previous_page", "has_next_page", "has_more_messages"]) {
        if (pageInfo[key] === true) reasons.push(`payload.page_info.${key}=true`);
      }
      for (const key of ["next_cursor", "next_page", "next_token"]) {
        if (pageInfo[key] !== undefined && pageInfo[key] !== null && pageInfo[key] !== "" && pageInfo[key] !== false) {
          reasons.push(`payload.page_info.${key} is present`);
        }
      }
    }
    return reasons;
  }

  function messageRecord(item, index) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const nested = item.message && typeof item.message === "object" && !item.author && !item.content ? item.message : item;
    const message = nested && typeof nested === "object" ? { ...nested } : null;
    if (!message) return null;
    if (!message.author && typeof message.role === "string") message.author = { role: message.role };
    const rawId = item.id ?? message.id;
    const nodeId = rawId === undefined || rawId === null || rawId === "" ? `messages-${index}` : String(rawId);
    const parentValue = item.parent ?? item.parent_message_id ?? message.parent ?? message.parent_message_id ?? null;
    const parent = parentValue === undefined || parentValue === null || parentValue === "" ? null : String(parentValue);
    return { item, message, nodeId, parent };
  }

  function messageItems(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
    const candidates = [
      payload.messages,
      payload.items,
      payload.data && payload.data.messages,
      payload.data && payload.data.items
    ];
    for (const items of candidates) {
      if (Array.isArray(items) && items.length) return items;
    }
    if (payload.mapping && typeof payload.mapping === "object" && !Array.isArray(payload.mapping)) {
      const nodes = Object.entries(payload.mapping).map(([id, node]) => node && typeof node === "object" && !node.id ? { id, ...node } : node);
      if (nodes.some((item) => item && typeof item === "object" && (item.message || item.author || item.content))) return nodes;
    }
    return [];
  }

  function createTimeValue(record) {
    const raw = record && record.message && record.message.create_time !== undefined
      ? record.message.create_time
      : record && record.item ? record.item.create_time : undefined;
    if (raw === undefined || raw === null || raw === "") return null;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw < 100000000000 ? raw * 1000 : raw;
    if (typeof raw !== "string") return null;
    const text = raw.trim();
    if (!text) return null;
    if (/^[+-]?\d+(?:\.\d+)?$/.test(text)) {
      const number = Number(text);
      if (Number.isFinite(number)) return number < 100000000000 ? number * 1000 : number;
    }
    const parsed = Date.parse(text);
    return Number.isNaN(parsed) ? null : parsed;
  }

  function orderRecordsByCreateTime(records) {
    const decorated = records.map((record, index) => ({ record, index, time: createTimeValue(record) }));
    const canSort = decorated.length > 1 && decorated.every((item) => item.time !== null);
    if (!canSort) return { records, sorted: false };
    decorated.sort((left, right) => left.time - right.time || left.index - right.index);
    return { records: decorated.map((item) => item.record), sorted: true };
  }

  function mergeMessagePages(basePayload, pagePayloads, options) {
    if (!hasMessageList(basePayload) || !Array.isArray(pagePayloads) || pagePayloads.length === 0) return basePayload;
    const seen = new Map();
    let anonymousIndex = 0;
    const append = (item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return;
      const nested = item.message && typeof item.message === "object" ? item.message : item;
      const rawId = item.id ?? nested.id;
      const key = rawId === undefined || rawId === null || rawId === "" ? `anonymous-${anonymousIndex++}` : `id:${String(rawId)}`;
      if (!seen.has(key)) {
        seen.set(key, item);
        return;
      }
      const existing = seen.get(key);
      if (existing && typeof existing === "object") {
        const existingMessage = existing.message && typeof existing.message === "object" ? existing.message : null;
        const itemMessage = item.message && typeof item.message === "object" ? item.message : null;
        seen.set(key, existingMessage || itemMessage
          ? { ...existing, ...item, message: { ...(existingMessage || {}), ...(itemMessage || {}) } }
          : { ...existing, ...item });
      }
    };

    // Older pages are normally observed while scrolling upward. Put them first
    // so the no-parent-links fallback remains chronological. Parent links are
    // authoritative whenever the API provides them.
    pagePayloads.forEach((page) => messageItems(page).forEach(append));
    messageItems(basePayload).forEach(append);
    const merged = { ...basePayload, messages: Array.from(seen.values()) };
    const olderComplete = Boolean(options && options.olderComplete);
    const basePageInfo = basePayload.page_info;
    if (olderComplete && basePageInfo && typeof basePageInfo === "object" && !Array.isArray(basePageInfo)) {
      merged.page_info = { ...basePageInfo, has_previous_page: false };
    }
    merged.__cce_capture = {
      version: 1,
      source: "observed-conversation-message-pages",
      page_count: pagePayloads.length,
      older_pages_complete: olderComplete,
      page_responses: pagePayloads
    };
    return merged;
  }

  function normalizeMessageList(payload) {
    const records = payload.messages.map(messageRecord).filter(Boolean);
    if (!records.length) throw new Error("messages 不是有效的 conversation message list");
    const byId = new Map();
    for (const record of records) {
      if (byId.has(record.nodeId)) throw new Error(`messages 中存在重复 message id：${record.nodeId}`);
      byId.set(record.nodeId, record);
    }
    const hasParentLinks = records.some((record) => record.parent !== null);
    const current = String(payload.current_node);
    const ordered = hasParentLinks ? { records, sorted: false } : orderRecordsByCreateTime(records);
    const currentIndex = ordered.records.findIndex((record) => record.nodeId === current);
    if (currentIndex < 0) throw new Error(`current_node 不在 messages 中：${current}`);
    const selected = hasParentLinks ? records : ordered.records.slice(0, currentIndex + 1);
    const mapping = {};
    for (let index = 0; index < selected.length; index += 1) {
      const record = selected[index];
      const parent = hasParentLinks ? record.parent : index > 0 ? selected[index - 1].nodeId : null;
      mapping[record.nodeId] = {
        id: record.nodeId,
        parent,
        children: [],
        message: record.message
      };
    }
    for (const node of Object.values(mapping)) {
      if (node.parent && mapping[node.parent]) mapping[node.parent].children.push(node.id);
    }
    return {
      ...payload,
      mapping,
      __cce_schema_variant: hasParentLinks
        ? "messages-with-parent-links"
        : ordered.sorted ? "ordered-messages-by-create-time" : "ordered-messages-active-path"
    };
  }

  function warningSummary(warnings) {
    if (!Array.isArray(warnings) || warnings.length === 0) return "";
    const counts = new Map();
    for (const warning of warnings) {
      let key = String(warning);
      const invisible = /^active path 上跳过不可见 role：(.+)$/.exec(key);
      if (invisible) key = `跳过不可见 role：${invisible[1]}`;
      else if (/没有可识别的文本 parts/.test(key)) key = "没有可识别的文本 parts";
      else if (/是空的可见消息/.test(key)) key = "空的可见消息";
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const lines = Array.from(counts, ([key, count]) => count > 1 ? `${key} ×${count}` : key);
    return lines.length > 12 ? `${lines.slice(0, 12).join("；")}；另有 ${lines.length - 12} 类 warning` : lines.join("；");
  }

  function normalizeConversation(payload) {
    if (hasMapping(payload)) return payload;
    if (hasMessageList(payload)) return normalizeMessageList(payload);
    throw new Error("JSON 中没有找到 mapping 或 messages conversation 结构");
  }

  function pageInfoSummary(payload) {
    const pageInfo = payload && payload.page_info;
    if (!pageInfo || typeof pageInfo !== "object" || Array.isArray(pageInfo)) {
      return { keys: [], hasMore: null, hasPreviousPage: null, hasNextPage: null, endCursorPresent: false };
    }
    return {
      keys: Object.keys(pageInfo).slice(0, 30),
      hasMore: typeof pageInfo.has_more === "boolean" ? pageInfo.has_more : null,
      hasPreviousPage: typeof pageInfo.has_previous_page === "boolean" ? pageInfo.has_previous_page : null,
      hasNextPage: typeof pageInfo.has_next_page === "boolean" ? pageInfo.has_next_page : null,
      endCursorPresent: pageInfo.end_cursor !== undefined && pageInfo.end_cursor !== null && pageInfo.end_cursor !== ""
    };
  }

  function pageInfoWarning(pageInfo) {
    if (!pageInfo || !pageInfo.endCursorPresent) return null;
    if (pageInfo.hasMore !== null || pageInfo.hasPreviousPage !== null || pageInfo.hasNextPage !== null) return null;
    return "payload.page_info.end_cursor present；has_next_page/has_more absent，完整性无法由该响应独立证明";
  }

  function activePath(payload) {
    const mapping = payload.mapping;
    const current = payload.current_node;
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) throw new Error("mapping 不是对象");
    if (current === undefined || current === null || current === "") throw new Error("缺少 current_node");
    let id = String(current);
    if (!Object.prototype.hasOwnProperty.call(mapping, id)) throw new Error(`current_node 不在 mapping 中：${id}`);
    const reverse = [];
    const seen = new Set();
    while (id !== null) {
      if (seen.has(id)) throw new Error(`parent 链出现循环：${id}`);
      seen.add(id);
      const node = mapping[id];
      if (!node || typeof node !== "object") throw new Error(`mapping 节点不是对象：${id}`);
      reverse.push({ nodeId: id, node });
      const parent = node.parent;
      if (parent === undefined || parent === null || parent === "") {
        id = null;
      } else {
        id = String(parent);
        if (!Object.prototype.hasOwnProperty.call(mapping, id)) throw new Error(`parent 节点缺失：${id}`);
      }
    }
    reverse.reverse();
    return reverse.map((item, index) => ({ nodeId: item.nodeId, node: item.node, index }));
  }

  function assetId(value) {
    if (typeof value !== "string" || !value) return null;
    return value.includes("://") ? value.split("://").slice(1).join("://") : value;
  }

  function attachmentIndex(message) {
    const attachments = message && message.metadata && message.metadata.attachments;
    const result = {};
    if (!Array.isArray(attachments)) return result;
    for (const item of attachments) {
      if (!item || typeof item !== "object") continue;
      for (const key of [item.id, item.asset_pointer, item.library_file_id]) {
        if (key) result[String(key)] = item;
      }
    }
    return result;
  }

  function placeholder(kind, id, filename, mimeType, size) {
    const fields = [kind];
    if (id) fields.push(`asset_id: ${id}`);
    if (filename) fields.push(`filename: ${filename}`);
    if (mimeType) fields.push(`mime_type: ${mimeType}`);
    if (size !== undefined && size !== null) fields.push(`size: ${size}`);
    return `[${fields.join("｜")}]`;
  }

  function renderPart(part, attachments, warnings, label) {
    if (typeof part === "string") return { text: part, assets: new Set() };
    if (!part || typeof part !== "object") {
      warnings.push(`${label} 有未识别的 content part 类型`);
      return { text: `[非文本内容：${typeof part}]`, assets: new Set() };
    }
    for (const key of ["text", "value"]) {
      if (typeof part[key] === "string") return { text: part[key], assets: new Set() };
    }
    if (typeof part.content === "string") return { text: part.content, assets: new Set() };

    const rawPointer = part.asset_pointer || part.asset_id || part.id;
    const id = assetId(rawPointer);
    const related = (rawPointer && (attachments[String(rawPointer)] || attachments[id])) || {};
    const filename = part.name || related.name;
    const mimeType = part.mime_type || related.mime_type;
    const size = part.size_bytes || related.size;
    const contentType = part.content_type;
    if (rawPointer || filename || contentType) {
      const kind = contentType === "image_asset_pointer" || (typeof mimeType === "string" && mimeType.startsWith("image/")) ? "图片附件" : "附件";
      return {
        text: placeholder(kind, id || String(rawPointer || ""), filename, mimeType, size),
        assets: new Set([String(rawPointer || ""), id].filter(Boolean))
      };
    }
    warnings.push(`${label} 有未识别的对象 content part，已保留 JSON 占位符`);
    return { text: `[未识别 content part：${JSON.stringify(part)}]`, assets: new Set() };
  }

  function inspect(raw) {
    const found = candidate(raw);
    if (!found) throw new Error("JSON 中没有找到 mapping 或 messages conversation 对象");
    const payload = normalizeConversation(found);
    const path = activePath(payload);
    const pageInfo = pageInfoSummary(payload);
    const stats = {
      mappingNodes: Object.keys(payload.mapping).length,
      activePathNodes: path.length,
      excludedBranchNodes: Math.max(0, Object.keys(payload.mapping).length - path.length),
      skippedEmptyOrMetadataNodes: 0,
      skippedInternalNodes: 0,
      warnings: [],
      incompleteReasons: explicitIncomplete(payload),
      visibleMessages: 0,
      userMessages: 0,
      assistantMessages: 0
    };
    const pageWarning = pageInfoWarning(pageInfo);
    if (pageWarning) stats.warnings.push(pageWarning);
    if (payload.__cce_schema_variant === "ordered-messages-by-create-time") {
      stats.warnings.push("messages 没有 parent links；已按 create_time 稳定排序，branch separation 无法由该响应独立证明");
    }
    const messages = [];
    for (const item of path) {
      const message = item.node.message;
      if (!message || typeof message !== "object") {
        stats.skippedEmptyOrMetadataNodes++;
        continue;
      }
      const role = message.author && message.author.role;
      const content = message.content;
      const contentType = content && typeof content === "object" ? content.content_type : null;
      if (INTERNAL_CONTENT_TYPES.has(contentType)) {
        stats.skippedInternalNodes++;
        continue;
      }
      if (!VISIBLE_ROLES.has(role)) {
        stats.skippedEmptyOrMetadataNodes++;
        if (role !== undefined && role !== null) stats.warnings.push(`active path 上跳过不可见 role：${role}`);
        continue;
      }
      const attachments = attachmentIndex(message);
      const pieces = [];
      const seenAssets = new Set();
      const label = `node ${item.nodeId}`;
      if (typeof content === "string") {
        pieces.push(content);
      } else if (content && typeof content === "object") {
        const parts = content.parts;
        if (Array.isArray(parts)) {
          for (const part of parts) {
            const rendered = renderPart(part, attachments, stats.warnings, label);
            pieces.push(rendered.text);
            rendered.assets.forEach((asset) => seenAssets.add(asset));
          }
        } else if (typeof parts === "string") {
          pieces.push(parts);
        } else if (typeof content.text === "string") {
          pieces.push(content.text);
        } else if (parts !== undefined && parts !== null) {
          stats.warnings.push(`${label} 的 content.parts 类型异常`);
        } else if (Object.keys(content).length > 0) {
          stats.warnings.push(`${label} 没有可识别的文本 parts`);
        }
      } else if (content !== undefined && content !== null) {
        stats.warnings.push(`${label} 的 content 类型异常`);
      }
      const appended = new Set();
      for (const key of Object.keys(attachments)) {
        const attachment = attachments[key];
        const canonical = String(attachment.id || attachment.library_file_id || key);
        if (appended.has(canonical)) continue;
        appended.add(canonical);
        if (seenAssets.has(canonical) || seenAssets.has(key)) continue;
        const mimeType = attachment.mime_type;
        pieces.push(placeholder(typeof mimeType === "string" && mimeType.startsWith("image/") ? "图片附件" : "附件", String(attachment.id || key), attachment.name, mimeType, attachment.size));
      }
      const body = pieces.join("");
      if (body === "") {
        stats.skippedEmptyOrMetadataNodes++;
        stats.warnings.push(`${label} 是空的可见消息，未写入 Markdown`);
        continue;
      }
      const messageId = message.id === undefined || message.id === null ? item.nodeId : String(message.id);
      if (message.id === undefined || message.id === null) stats.warnings.push(`${label} 缺少 message.id，使用 mapping 节点 id`);
      messages.push({
        nodeId: item.nodeId,
        messageId,
        messageIdSource: message.id === undefined || message.id === null ? "mapping.node.id" : "message.id",
        activePathIndex: item.index,
        role: String(role),
        body,
        createTime: message.create_time,
        updateTime: message.update_time
      });
    }
    stats.visibleMessages = messages.length;
    stats.userMessages = messages.filter((message) => message.role === "user").length;
    stats.assistantMessages = messages.filter((message) => message.role === "assistant").length;
    return {
      payload,
      title: title(payload),
      conversationId: conversationId(payload),
      schemaVariant: payload.__cce_schema_variant || "mapping",
      warningSummary: warningSummary(stats.warnings),
      pageInfo,
      path,
      messages,
      stats
    };
  }

  function value(valueToRender) {
    return valueToRender === undefined || valueToRender === null ? "None" : String(valueToRender);
  }

  function renderMarkdown(raw) {
    const document = inspect(raw);
    const stats = document.stats;
    const lines = [
      `# ${document.title}`,
      "",
      `- conversation_id：${value(document.conversationId)}`,
      `- mapping 节点数：${stats.mappingNodes}`,
      `- active path 节点数：${stats.activePathNodes}`,
      `- 排除的其他分支节点数：${stats.excludedBranchNodes}`,
      "",
      "---",
      ""
    ];
    document.messages.forEach((message, index) => {
      lines.push(`## Turn ${String(index + 1).padStart(4, "0")}｜${message.role.toUpperCase()}`, "", `- message_id：${message.messageId}`);
      if (message.messageIdSource !== "message.id") lines.push(`- message_id_source：${message.messageIdSource}`);
      lines.push(`- active_path_index：${message.activePathIndex}`, `- create_time：${value(message.createTime)}`);
      if (message.updateTime !== undefined && message.updateTime !== null) lines.push(`- update_time：${message.updateTime}`);
      lines.push("", message.body, "", "---", "");
    });
    return { markdown: lines.join("\n"), document };
  }

  const FORBIDDEN = /[\x00-\x1f\x7f\/\\<>:"|?*]/g;
  function sanitizeTitle(rawTitle, fallback) {
    let valueToUse = typeof rawTitle === "string" ? rawTitle : "";
    valueToUse = valueToUse.replace(FORBIDDEN, "_").replace(/\s+/g, " ").trim().replace(/[. ]+$/g, "");
    if (!valueToUse || valueToUse === "." || valueToUse === "..") valueToUse = fallback || "conversation";
    return valueToUse.length > 180 ? valueToUse.slice(0, 160).trimEnd() + "-long-title" : valueToUse;
  }

  function filenameStem(rawTitle, id) {
    if (typeof rawTitle === "string") {
      for (const rule of localNamingRules) {
        const match = rule.regex.exec(rawTitle);
        if (!match || !/^\d+$/.test(match[1] || "")) continue;
        const number = match[1];
        const prefix = sanitizeTitle(rule.filenamePrefix, "conversation");
        return `${prefix}${number.padStart(rule.minimumDigits, "0")}`;
      }
    }
    return sanitizeTitle(rawTitle, sanitizeTitle(id, "conversation"));
  }

  root.CCEConversationConverter = { inspect, renderMarkdown, filenameStem, mergeMessagePages, warningSummary, setNamingRules };
})(globalThis);
