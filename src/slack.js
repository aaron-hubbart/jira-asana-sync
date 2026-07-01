const axios = require("axios");

// Posts ticket notifications to Slack via chat.postMessage.
// Returns null when no bot token is configured, so the sync simply skips Slack.
function makeClient({ slackBotToken, jiraBaseUrl }) {
  if (!slackBotToken) return null;

  const http = axios.create({
    baseURL: "https://slack.com/api",
    headers: {
      Authorization: `Bearer ${slackBotToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    timeout: 15000,
  });

  // Resolve a channel NAME ("#boa-support" or "boa-support") to its ID, cached.
  // A raw ID ("C0123ABCD") is used as-is. Requires channels:read (+ groups:read
  // for private channels), and the bot must be a member of private channels.
  const channelCache = new Map();
  async function resolveChannelId(channel) {
    if (/^[CG][A-Z0-9]{6,}$/.test(channel)) return channel; // already an ID
    const name = String(channel).replace(/^#/, "");
    if (channelCache.has(name)) return channelCache.get(name);
    let cursor;
    do {
      const params = { limit: 200, exclude_archived: true, types: "public_channel,private_channel" };
      if (cursor) params.cursor = cursor;
      const res = await http.get("/conversations.list", { params });
      if (!res.data || !res.data.ok) throw new Error(`slack conversations.list failed: ${res.data ? res.data.error : "no response"}`);
      for (const ch of res.data.channels) {
        if (ch.name === name) { channelCache.set(name, ch.id); return ch.id; }
      }
      cursor = res.data.response_metadata && res.data.response_metadata.next_cursor;
    } while (cursor);
    throw new Error(`Slack channel '#${name}' not found (is the bot a member, and does it have channels:read / groups:read?)`);
  }

  // Auto-join a PUBLIC channel (needs channels:join). Private channels can't be
  // self-joined by a bot — a member must /invite it.
  async function joinChannel(channelId) {
    try {
      const res = await http.post("/conversations.join", { channel: channelId });
      return !!(res.data && res.data.ok);
    } catch (_) {
      return false;
    }
  }

  function fieldsFor(issue) {
    const f = issue.fields || {};
    return {
      key: issue.key,
      summary: f.summary || "(no summary)",
      priority: f.priority?.name || "None",
      assignee: f.assignee?.displayName || "Unassigned",
      reporter: f.reporter?.displayName || "Unknown",
      status: f.status?.name || "Unknown",
      url: `${jiraBaseUrl}/browse/${issue.key}`,
    };
  }

  // kind: "new" | "update". extra: { from, to } for status changes.
  function buildMessage(kind, issue, extra) {
    const d = fieldsFor(issue);
    const heading = kind === "new" ? ":new: New ticket" : ":arrows_counterclockwise: Ticket update";
    const statusValue =
      kind === "update" && extra && extra.from ? `${extra.from} → ${extra.to}` : d.status;

    // Single-column layout: one field per line, inline labels, blank line after Summary.
    const body = [
      `*Ticket ID:* <${d.url}|${d.key}>`,
      `*Summary:* ${d.summary}`,
      "",
      `*Priority:* ${d.priority}`,
      `*Reporter:* ${d.reporter}`,
      `*Assignee:* ${d.assignee}`,
      `*Status:* ${statusValue}`,
    ].join("\n");

    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: `*${heading}*` } },
      { type: "section", text: { type: "mrkdwn", text: body } },
    ];

    // Plain-text fallback used for notifications / clients without Block Kit.
    const text = `${heading}: ${d.key} — ${d.summary} (Priority ${d.priority}, Assignee ${d.assignee}, Reporter ${d.reporter})`;
    return { blocks, text };
  }

  async function notify(channel, kind, issue, extra) {
    const channelId = await resolveChannelId(channel);
    const msg = buildMessage(kind, issue, extra);
    let res = await http.post("/chat.postMessage", { channel: channelId, ...msg });
    // Not a member yet? Try to auto-join (public channels only) and post again.
    if (res.data && res.data.error === "not_in_channel") {
      await joinChannel(channelId);
      res = await http.post("/chat.postMessage", { channel: channelId, ...msg });
    }
    if (!res.data || !res.data.ok) {
      const err = res.data ? res.data.error : "no response";
      const hint = err === "not_in_channel" ? " (private channel — invite the bot manually: /invite @your-bot)" : "";
      throw new Error(`slack chat.postMessage failed: ${err}${hint}`);
    }
    return res.data.ts;
  }

  return { notify };
}

module.exports = { makeClient };
