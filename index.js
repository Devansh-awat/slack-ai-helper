require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { App, Assistant } = require("@slack/bolt");

// Simple file-backed counter so stats survive process restarts.
const STATS_FILE = path.join(__dirname, "stats.json");

function getStats() {
  try {
    return JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
  } catch (err) {
    return { answered: 0 };
  }
}

function recordAnswer() {
  const stats = getStats();
  stats.answered = (stats.answered || 0) + 1;
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats));
  } catch (err) {
    console.error("Failed to write stats:", err);
  }
  return stats.answered;
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true
});

// Populated at startup; used to build clickable (non-pinging) profile links.
let TEAM_ID = process.env.SLACK_TEAM_ID || "";

app.command("/ai-ping", async ({ command, ack, respond }) => {
  const start = Date.now();
  await ack();
  const latency = Date.now() - start;
  await respond({ text: `Pong!\nLatency: ${latency}ms` });
});

// authorLinks maps a lowercased display name -> a clickable, NON-pinging
// profile link (<url|@name>). It's populated from search/lookup results so we
// can rewrite any "<@Display Name>" the model invents into a real link.
function convertMarkdownToMrkdwn(text, authorLinks = {}) {
  if (!text) return "";
  return text
    // Neutralize real user mentions so the bot never pings people or exposes
    // profiles from channels the asker may not share. <@U123> -> "a user".
    .replace(/<@[A-Z0-9]+>/g, "a user")
    // The model sometimes emits "<@Display Name>" (a name, not a real ID).
    // Slack won't render that as a mention, so it leaks as literal "<@...>"
    // text. If we have a clickable profile link for that name use it (clickable,
    // no ping); otherwise fall back to the plain name.
    .replace(/<@([^>]+)>/g, (_m, name) => {
      const link = authorLinks[name.trim().toLowerCase()];
      return link || name;
    })
    // Replace markdown bold (**text**) with Slack bold (*text*)
    .replace(/\*\*(.*?)\*\*/g, "*$1*")
    // Replace markdown links ([text](url)) with Slack links (<url|text>)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");
}

async function handleAIHelp({ channel_id, thread_ts, text, slackClient, respond, actionToken, say }) {
  if (!process.env.HACKAI_KEY) {
    const errorText = "Bot configuration error: HACKAI_KEY is missing.";
    if (respond) await respond({ text: errorText });
    else await slackClient.chat.postMessage({ channel: channel_id, thread_ts, text: errorText });
    return;
  }

  let threadText = "";
  let canvasDocs = [];
  if (thread_ts) {
    try {
      const replies = await slackClient.conversations.replies({
        channel: channel_id,
        ts: thread_ts,
      });
      threadText = replies.messages
        .map((m) => {
          const sender = m.user ? `<@${m.user}>` : `Bot (${m.username || m.bot_id})`;
          return `${sender}: ${m.text}`;
        })
        .join("\n");

      // Collect any canvas (quip) docs attached in the thread, e.g. an FAQ
      // posted by a welcome bot, so the model can read them via read_canvas.
      for (const m of replies.messages) {
        for (const f of m.files || []) {
          if (f.filetype === "quip" || f.filetype === "canvas" || f.mode === "quip" || f.mode === "canvas") {
            if (!canvasDocs.some((d) => d.id === f.id)) {
              canvasDocs.push({ id: f.id, title: f.title || "Untitled Canvas" });
            }
          }
        }
      }
    } catch (error) {
      console.error("Failed to fetch thread replies:", error);
      if (error.code === "slack_webapi_platform_error" && error.data.error === "not_in_channel") {
        const notInChannelMsg = "The bot is not a member of this channel. Please invite the bot first (by typing `/invite @AI help bot` in that channel).";
        if (respond) {
          await respond({ text: notInChannelMsg });
        } else {
          await slackClient.chat.postMessage({
            channel: channel_id,
            thread_ts: thread_ts,
            text: notInChannelMsg,
          });
        }
        return;
      }
      threadText = "Could not fetch thread messages due to an error.";
    }
  }

  const systemPrompt = `You are a strict, highly concise Slack AI assistant helping users in this workspace.

Current Channel ID: ${channel_id}

You MUST follow these rules:
1. CONCISENESS: Keep your final response short, direct, and under 3 sentences. No fluff.
2. STRICT CITATIONS: You are FORBIDDEN from stating facts or answers without citing the source.
   - If citing messages: Cite the author, the channel, and a link to the message (e.g. "as noted by {author} in #faq (<{permalink}|view message>)"). Copy the "author" field from the search result EXACTLY as given — it is already a clickable link; do not modify, unwrap, or reformat it. Use the "permalink" field from the same search result as the message link. NEVER write "<@U12345>" or a bare user ID yourself — that pings people and exposes private profiles to users who may not share a channel with them.
   - If citing bookmarks or canvases: Reference the tab/doc title and provide the exact URL.
3. USE WHAT YOU FIND: If the tools return messages that are relevant to the question, summarize the answer from them and cite the source — even if no single message states it word-for-word. Do NOT answer from your own general training knowledge. Only reply "I cannot find the answer to this in the Slack history or bookmarks." when the tool results genuinely contain nothing relevant to the question.
4. TOOL EXECUTION: Always call search_messages FIRST to gather facts before answering. Try at least one search (and refine the query if the first results are noisy) before concluding you cannot find an answer.
5. AUTHOR-SCOPED QUESTIONS: When the question is about messages a specific PERSON sent (e.g. "find a message zrl sent about cheese"), do NOT just put their name in the query as a keyword — that only matches messages whose text contains their name, not messages they authored. Instead:
   - First call lookup_user to resolve the person. It returns matches and a ready-to-use "from:" filter in its hint (e.g. from:<@U09UE480JHH>). Pick the FIRST match unless its title clearly describes a different person.
   - Then search using that exact from: filter, e.g. query "cheese from:<@U09UE480JHH>". You may combine operators, e.g. "cheese from:<@U09UE480JHH> in:#random".
   - Only after that from: search returns nothing should you conclude the person sent no such message.
6. SEARCH OPERATORS: search_messages also supports has: (e.g. has:link, has:star) and date-bounded before:/after: (e.g. before:2026-01-01, after:2026-01-01), same as Slack's own search bar. Combine freely with from:/in:, e.g. "deploy has:link after:2026-06-01 in:#eng".

Tools at your disposal:
- search_messages: PREFERRED. Searches ALL channels and threads across the workspace by relevance (includes replies inside threads). Use this first for any factual question. Supports Slack operators like from:@handle, in:#channel, has:link/has:star, and before:/after: date bounds.
- lookup_user: Resolves a person's name or handle to their Slack @handle and user ID. Use this BEFORE an author-scoped (from:) search.
- search_channel_history: Fallback. Scans only recent top-level messages in one channel (does NOT see thread replies).
- list_channels: Lists public channel names and IDs.
- list_channel_bookmarks: Lists bookmarks/tabs in a channel.
- read_web_page: Fetches text from a bookmark or document URL.
- read_canvas: Reads the full text of a Slack Canvas (e.g. an FAQ) by its file ID.

${canvasDocs.length
      ? `Canvases available in this thread (call read_canvas with the id to read them — the FAQ likely answers the question):\n${canvasDocs
        .map((d) => `- ${d.id}: "${d.title}"`)
        .join("\n")}`
      : "(No canvases detected in this thread.)"
    }

Thread History:
${threadText || "(Not run in a thread)"}`;

  const messages = [
    {
      role: "system",
      content: systemPrompt,
    },
    {
      role: "user",
      content: text || "Please help me based on the thread context above.",
    },
  ];

  const tools = [
    {
      type: "function",
      function: {
        name: "search_messages",
        description: "Search ALL Slack channels and threads across the workspace for messages matching a query, ranked by relevance. Includes replies inside threads. Use this first for any factual question — it sees far more than search_channel_history.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search terms or a phrase, e.g. 'AI usage limit stardance' or 'percentage of code allowed'. Supports Slack search operators like in:#channel.",
            },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "lookup_user",
        description: "Resolve a person's name or handle (e.g. 'zrl' or 'Zach') to their Slack @handle and user ID. Call this before doing a 'from:@handle' author-scoped search_messages query.",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The name, display name, or handle to look up (e.g. 'zrl').",
            },
          },
          required: ["name"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_channel_history",
        description: "Search the recent messages in a specific Slack channel (or the current channel if channel_id is not provided).",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The term or phrase to search for in the recent message history.",
            },
            channel_id: {
              type: "string",
              description: "The ID of the channel to search (e.g. C12345). If omitted, searches the current channel.",
            },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_channels",
        description: "List all public channels in the Slack workspace to find channel names and IDs.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_channel_bookmarks",
        description: "List all bookmarks (tabs) in a specific Slack channel by its channel ID.",
        parameters: {
          type: "object",
          properties: {
            channel_id: {
              type: "string",
              description: "The ID of the Slack channel (e.g. C12345).",
            },
          },
          required: ["channel_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_web_page",
        description: "Fetch and read the text content of a public URL (e.g., from a bookmark or external FAQ).",
        parameters: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The full URL to read.",
            },
          },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_canvas",
        description: "Read the full text content of a Slack Canvas (such as an FAQ document) by its file ID. Canvas file IDs are listed in the system prompt when present in the thread.",
        parameters: {
          type: "object",
          properties: {
            file_id: {
              type: "string",
              description: "The Slack file ID of the canvas (e.g. F0B75EET78W).",
            },
          },
          required: ["file_id"],
        },
      },
    },
  ];

  const MAX_TOOL_ROUNDS = 10;

  // Gemini bills against the daily spending cap as max_tokens * price, reserved
  // up front per request. Leaving it unset makes each call reserve the model's
  // full output window, which burns through the $3/day limit in a handful of
  // requests. Capping it keeps each reservation small so we can spread real
  // usage across the whole budget. Slack answers rarely need more than this.
  const MAX_OUTPUT_TOKENS = 2048;

  async function callModel(includeTools) {
    const body = {
      model: "google/gemini-3.1-flash-lite",
      messages,
      max_tokens: MAX_OUTPUT_TOKENS,
    };
    if (includeTools) {
      body.tools = tools;
    } else {
      body.tool_choice = "none";
    }

    let res = await fetch("https://ai.hackclub.com/proxy/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.HACKAI_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    // 402: hackclub proxy out of credit. 429: proxy hit its own daily Gemini
    // spending cap ("Daily spending limit of $3 reached"). Either way, fall
    // back to our own Gemini key.
    if (res.status === 402 || res.status === 429) {
      res = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.GEMINI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ ...body, model: "gemini-3.1-flash-lite" })
      });
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`API error (Status ${res.status}): ${errText}`);
    }

    const data = await res.json();
    return data.choices[0].message;
  }

  // name (lowercased) -> clickable, non-pinging profile link. Populated as we
  // map authors from search/lookup results, then used to rewrite any
  // "<@Name>" the model emits into a real link at format time.
  const authorLinks = {};

  let answerText = "";
  try {
    let loopCount = 0;
    let keepRunning = true;

    while (loopCount < MAX_TOOL_ROUNDS && keepRunning) {
      const message = await callModel(true);

      if (message.tool_calls && message.tool_calls.length > 0) {
        messages.push(message);

        for (const toolCall of message.tool_calls) {
          console.log(`[tool] ${toolCall.function.name} args=${toolCall.function.arguments}`);
          if (toolCall.function.name === "search_messages") {
            let args;
            try {
              args = JSON.parse(toolCall.function.arguments);
            } catch (err) {
              args = { query: toolCall.function.arguments };
            }

            // Clickable profile link that does NOT ping the user (Slack treats
            // <url|text> as a link, not a mention). Falls back to a plain handle.
            // Also records the link under the name so we can recover it if the
            // model later writes "<@Name>" instead of copying the link.
            const mapAuthor = (userId, name) => {
              const link =
                userId && TEAM_ID
                  ? `<https://app.slack.com/client/${TEAM_ID}/${userId}|@${name || "user"}>`
                  : `@${name || "user"}`;
              if (name && userId && TEAM_ID) authorLinks[name.toLowerCase()] = link;
              return link;
            };

            let searchResults;
            try {
              if (actionToken) {
                // Preferred: bot-token org-wide PUBLIC search via the AI-app
                // method. No user token, no channel membership needed.
                const sr = await slackClient.apiCall("assistant.search.context", {
                  query: args.query,
                  action_token: actionToken,
                  channel_types: "public_channel",
                  content_types: "messages",
                });
                const msgs = (sr.results && sr.results.messages) || [];
                searchResults = msgs.map((m) => ({
                  author: mapAuthor(m.author_user_id, m.author_name),
                  channel: m.channel_name ? `#${m.channel_name}` : m.channel_id || "",
                  text: m.content,
                  permalink: m.permalink,
                }));
                console.log(`[tool] assistant.search.context -> ${searchResults.length} matches`);
              } else if (process.env.SLACK_USER_TOKEN) {
                // Fallback only (no action_token, e.g. invoked outside a user
                // message event). User-token search is org-limited to the
                // token owner's channels — see the cross-user leak note.
                const sr = await slackClient.search.messages({
                  token: process.env.SLACK_USER_TOKEN,
                  query: args.query,
                  count: 20,
                  sort: "score",
                });
                const matches = (sr.messages && sr.messages.matches) || [];
                searchResults = matches.map((m) => ({
                  author: mapAuthor(m.user, m.username),
                  channel: m.channel ? (m.channel.name ? `#${m.channel.name}` : m.channel.id) : "",
                  text: m.text,
                  permalink: m.permalink,
                }));
                console.log(`[tool] search.messages(user) -> ${searchResults.length} matches`);
              } else {
                searchResults = {
                  error: "Search unavailable: no action_token for bot-token search and no SLACK_USER_TOKEN configured.",
                };
              }

              if (Array.isArray(searchResults) && searchResults.length === 0) {
                searchResults = { info: "No messages found for that query." };
              }
            } catch (err) {
              console.error("search_messages failed:", err);
              searchResults = { error: `Search failed: ${err.message}` };
            }

            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              name: "search_messages",
              content: JSON.stringify(searchResults),
            });
          } else if (toolCall.function.name === "lookup_user") {
            let args;
            try {
              args = JSON.parse(toolCall.function.arguments);
            } catch (err) {
              args = { name: toolCall.function.arguments };
            }

            const needle = (args.name || "").toLowerCase().replace(/^@/, "").trim();
            let result;
            try {
              const matches = [];
              // Register a candidate and pre-build a clickable, non-pinging
              // profile link so any "<@name>" the model later writes resolves
              // to a real link. Prefer the Slack-provided permalink; fall back
              // to a team-scoped client link.
              const register = (userId, handle, display, permalink, title) => {
                const name = display || handle || "user";
                matches.push({
                  user_id: userId || null,
                  handle: handle || null,
                  display_name: name,
                  title: title || undefined,
                });
                const url =
                  permalink ||
                  (userId && TEAM_ID ? `https://app.slack.com/client/${TEAM_ID}/${userId}` : null);
                if (url) {
                  const link = `<${url}|@${name}>`;
                  for (const n of [handle, display]) {
                    if (n) authorLinks[n.toLowerCase()] = link;
                  }
                }
              };

              if (actionToken) {
                // PREFERRED: relevance-ranked user search via the AI-app method.
                // No org-wide pagination, no rate-limit blowups. Uses the
                // search:read.users scope. User objects expose user_id,
                // full_name, title and permalink (no @handle), so author
                // filtering must use the user_id, not a handle.
                const sr = await slackClient.apiCall("assistant.search.context", {
                  query: args.name,
                  action_token: actionToken,
                  content_types: "users",
                });
                const users = (sr.results && sr.results.users) || [];
                for (const u of users.slice(0, 10)) {
                  register(
                    u.user_id,
                    u.username || u.name || null,
                    u.full_name || u.display_name || u.real_name,
                    u.permalink,
                    u.title
                  );
                }
              } else {
                // FALLBACK (no action_token): bounded users.list scan. Hard page
                // cap so a large workspace can't trigger a rate-limit storm; stop
                // on the first exact handle/name match.
                const MAX_PAGES = 6;
                let cursor;
                let exact = false;
                let pages = 0;
                do {
                  const res = await slackClient.users.list({ limit: 200, cursor });
                  for (const u of res.members || []) {
                    if (u.deleted || u.is_bot) continue;
                    const p = u.profile || {};
                    const display = p.display_name || p.real_name || u.name;
                    const fields = [u.name, p.display_name, p.display_name_normalized, p.real_name, p.real_name_normalized]
                      .filter(Boolean)
                      .map((s) => s.toLowerCase());
                    if (fields.some((f) => f === needle)) {
                      register(u.id, u.name, display);
                      exact = true;
                      break;
                    }
                    if (fields.some((f) => f.includes(needle)) && matches.length < 10) {
                      register(u.id, u.name, display);
                    }
                  }
                  cursor = res.response_metadata && res.response_metadata.next_cursor;
                  pages++;
                } while (cursor && !exact && pages < MAX_PAGES);
              }

              if (matches.length === 0) {
                result = {
                  info: `No user match found for "${args.name}".`,
                };
              } else {
                const top = matches[0];
                // Author filtering is by user ID: search.messages honors the
                // encoded mention form from:<@U123>. Prefer it over a handle.
                const fromOperator = top.user_id ? `from:<@${top.user_id}>` : `from:@${top.handle || needle}`;
                result = {
                  matches,
                  hint: `For an author-scoped search, add "${fromOperator}" to your search_messages query, e.g. "cheese ${fromOperator}". Use the FIRST match unless the title indicates a different person.`,
                };
              }
            } catch (err) {
              console.error("lookup_user failed:", err);
              if (err.code === "slack_webapi_platform_error" && err.data && err.data.error === "missing_scope") {
                result = { error: "The bot is missing the 'users:read' scope required to look up users. Add 'users:read' in the Slack app settings and reinstall the app." };
              } else {
                result = { error: `Failed to look up user: ${err.message}` };
              }
            }

            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              name: "lookup_user",
              content: JSON.stringify(result),
            });
          } else if (toolCall.function.name === "search_channel_history") {
            let args;
            try {
              args = JSON.parse(toolCall.function.arguments);
            } catch (err) {
              args = { query: toolCall.function.arguments };
            }

            const targetChannel = args.channel_id || channel_id;
            let searchResults = [];
            try {
              const history = await slackClient.conversations.history({
                channel: targetChannel,
                limit: 100,
              });

              searchResults = history.messages
                .filter((m) => m.text && m.text.toLowerCase().includes(args.query.toLowerCase()))
                .map((m) => ({
                  user: m.user || m.bot_id || "Unknown",
                  text: m.text,
                  ts: m.ts,
                }));
            } catch (err) {
              console.error(`Failed to search channel history for ${targetChannel}:`, err);
              if (err.code === "slack_webapi_platform_error" && err.data.error === "not_in_channel") {
                searchResults = { error: `The bot is not a member of channel ${targetChannel}. Please instruct the user to invite the bot first by typing '/invite @AI help bot' in that channel.` };
              } else {
                searchResults = { error: `Failed to search channel history: ${err.message}` };
              }
            }

            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              name: "search_channel_history",
              content: JSON.stringify(searchResults),
            });
          } else if (toolCall.function.name === "list_channels") {
            let searchResults = [];
            try {
              const res = await slackClient.conversations.list({
                exclude_archived: true,
                types: "public_channel",
                limit: 100,
              });
              if (res.ok && res.channels) {
                searchResults = res.channels.map((c) => ({
                  id: c.id,
                  name: c.name,
                  purpose: c.purpose ? c.purpose.value : "",
                  topic: c.topic ? c.topic.value : "",
                }));
              }
            } catch (err) {
              console.error("Failed to list channels:", err);
              searchResults = { error: `Failed to list channels: ${err.message}` };
            }

            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              name: "list_channels",
              content: JSON.stringify(searchResults),
            });
          } else if (toolCall.function.name === "list_channel_bookmarks") {
            let args;
            try {
              args = JSON.parse(toolCall.function.arguments);
            } catch (err) {
              args = { channel_id: toolCall.function.arguments };
            }

            let searchResults = [];
            try {
              const res = await slackClient.bookmarks.list({
                channel: args.channel_id,
              });

              if (res.ok && res.bookmarks) {
                searchResults = res.bookmarks.map((b) => ({
                  id: b.id,
                  title: b.title,
                  link: b.link,
                  type: b.type,
                }));
              }
            } catch (err) {
              console.error("Failed to list channel bookmarks:", err);
              if (err.code === "slack_webapi_platform_error" && err.data.error === "not_in_channel") {
                searchResults = { error: `The bot is not a member of channel ${args.channel_id}. Please instruct the user to invite the bot first by typing '/invite @AI help bot' in that channel.` };
              } else {
                searchResults = {
                  error: `Failed to list bookmarks: ${err.message}. If this is a missing scope error, make sure the Slack App has 'bookmarks:read' scope enabled in the developer dashboard.`,
                };
              }
            }

            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              name: "list_channel_bookmarks",
              content: JSON.stringify(searchResults),
            });
          } else if (toolCall.function.name === "read_web_page") {
            let args;
            try {
              args = JSON.parse(toolCall.function.arguments);
            } catch (err) {
              args = { url: toolCall.function.arguments };
            }

            let pageText = "";
            try {
              const res = await fetch(args.url);
              if (res.ok) {
                const html = await res.text();
                pageText = html
                  .replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, "")
                  .replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, "")
                  .replace(/<[^>]+>/g, " ")
                  .replace(/\s+/g, " ")
                  .substring(0, 10000);
              } else {
                pageText = `Error fetching page: Status ${res.status}`;
              }
            } catch (err) {
              pageText = `Error reading web page: ${err.message}`;
            }

            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              name: "read_web_page",
              content: JSON.stringify({ content: pageText }),
            });
          } else if (toolCall.function.name === "read_canvas") {
            let args;
            try {
              args = JSON.parse(toolCall.function.arguments);
            } catch (err) {
              args = { file_id: toolCall.function.arguments };
            }

            let result;
            try {
              const info = await slackClient.files.info({ file: args.file_id });
              const f = info.file || {};
              let canvasText = "";

              const dlUrl = f.url_private_download || f.url_private;
              if (dlUrl) {
                const r = await fetch(dlUrl, {
                  headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
                });
                if (r.ok) {
                  const raw = await r.text();
                  canvasText = raw
                    .replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, "")
                    .replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, "")
                    .replace(/<[^>]+>/g, " ")
                    .replace(/\s+/g, " ")
                    .trim()
                    .substring(0, 12000);
                }
              }
              if (!canvasText && f.content) {
                canvasText = String(f.content).substring(0, 12000);
              }

              result = {
                title: f.title || "Canvas",
                content: canvasText || "(Canvas content could not be read.)",
              };
            } catch (err) {
              console.error(`Failed to read canvas ${args.file_id}:`, err);
              if (err.code === "slack_webapi_platform_error" && err.data && err.data.error === "missing_scope") {
                result = { error: "The bot is missing the 'files:read' scope required to read canvases. Add 'files:read' in the Slack app settings and reinstall the app." };
              } else {
                result = { error: `Failed to read canvas: ${err.message}` };
              }
            }

            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              name: "read_canvas",
              content: JSON.stringify(result),
            });
          }
        }
        loopCount++;
      } else {
        answerText = message.content;
        keepRunning = false;
      }
    }

    // If the tool-call budget was exhausted without a final text answer,
    // make one more call with tools disabled so the model must respond
    // using the context it already gathered.
    if (!answerText && keepRunning) {
      const finalMessage = await callModel(false);
      answerText = finalMessage.content;
    }

    if (!answerText) {
      answerText = "I cannot find the answer to this in the Slack history or bookmarks.";
    }
    console.log(`[answer] ${answerText.slice(0, 200)}`);
  } catch (error) {
    console.error("Error calling Gemini API:", error);
    answerText = `Error calling Gemini API: ${error.message}`;
  }

  const formattedAnswerText = convertMarkdownToMrkdwn(answerText, authorLinks);

  // Count this as a question answered (any early return above skips this).
  const total = recordAnswer();
  console.log(`[stats] questions answered: ${total}`);

  // Reply. In the assistant pane, `say` posts into the assistant thread.
  if (say) {
    await say(formattedAnswerText);
  } else if (thread_ts) {
    try {
      await slackClient.chat.postMessage({
        channel: channel_id,
        thread_ts: thread_ts,
        text: formattedAnswerText,
      });
    } catch (postError) {
      console.error("Failed to post message to thread:", postError);
      if (respond) await respond({ text: formattedAnswerText });
    }
  } else {
    if (respond) {
      await respond({ text: formattedAnswerText });
    } else {
      await slackClient.chat.postMessage({
        channel: channel_id,
        text: formattedAnswerText,
      });
    }
  }
}

app.command("/ai-help", async ({ ack, respond }) => {
  await ack();
  const helpText = [
    "*AI help bot — how to use me*",
    "",
    "• *Ask a question:* mention me in any channel or thread, e.g. `@AI help bot how do I track my time?`",
    "   I search the workspace history, channel bookmarks, and FAQ canvases, then answer with cited sources and message links.",
    "• Add me to a channel first with `/invite @AI help bot` so I can read it.",
    "",
    "*Commands*",
    "• `/ai-help` — show this help",
    "• `/ai-stats` — how many questions I've answered",
    "• `/ai-ping` — check that I'm online",
  ].join("\n");
  await respond({ response_type: "ephemeral", text: helpText });
});

app.command("/ai-stats", async ({ ack, respond }) => {
  await ack();
  const { answered = 0 } = getStats();
  await respond({
    response_type: "ephemeral",
    text: `:bar_chart: I've answered *${answered}* question${answered === 1 ? "" : "s"} so far.`,
  });
});

app.event("app_mention", async ({ event, client: slackClient }) => {
  console.log("APP_MENTION payload:", JSON.stringify(event, null, 2));
  // Strip bot user mention from text (e.g. <@U12345> help -> help)
  const cleanText = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
  // If mentioned in a thread, reply in thread (event.thread_ts)
  // If mentioned in main chat, reply in thread on the mention message (event.ts)
  const targetThreadTs = event.thread_ts || event.ts;

  await handleAIHelp({
    channel_id: event.channel,
    thread_ts: targetThreadTs,
    text: cleanText,
    slackClient,
    // Token may be nested (when mentioned in an assistant thread) or top-level.
    actionToken: (event.assistant_thread && event.assistant_thread.action_token) || event.action_token,
  });
});

// --- Assistant (Agents & AI Apps) surface ---------------------------------
// The side-panel assistant. User messages here carry an action_token, which
// lets us run bot-token org-wide public search via assistant.search.context.
const assistant = new Assistant({
  threadStarted: async ({ say, setSuggestedPrompts }) => {
    try {
      await say("Hi! Ask me anything about this workspace — I'll search public channels and answer with cited sources.");
      await setSuggestedPrompts({
        title: "Try asking:",
        prompts: [
          { title: "Find a policy", message: "What's the policy on AI usage in Stardance?" },
          { title: "Catch up", message: "Summarize recent discussion about hardware projects." },
        ],
      });
    } catch (err) {
      console.error("assistant threadStarted failed:", err);
    }
  },
  userMessage: async ({ message, client: assistantClient, say, setStatus }) => {
    try {
      await setStatus("is thinking…");
      await handleAIHelp({
        channel_id: message.channel,
        thread_ts: message.thread_ts || message.ts,
        text: (message.text || "").replace(/<@[A-Z0-9]+>/g, "").trim(),
        slackClient: assistantClient,
        say,
        // In assistant threads the token is nested here (not at top level).
        actionToken: (message.assistant_thread && message.assistant_thread.action_token) || message.action_token,
      });
    } catch (err) {
      console.error("assistant userMessage failed:", err);
      await say("Sorry, something went wrong answering that.");
    }
  },
});
app.assistant(assistant);

(async () => {
  await app.start();
  if (!TEAM_ID) {
    try {
      const auth = await app.client.auth.test();
      TEAM_ID = auth.team_id || "";
    } catch (err) {
      console.error("Could not resolve TEAM_ID at startup:", err.message);
    }
  }
  console.log(`bot is running! TEAM_ID=${TEAM_ID || "(unset)"}`);
})();