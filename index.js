require("dotenv").config();

const { App } = require("@slack/bolt");

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true
});

app.command("/ai-ping", async ({ command, ack, respond }) => {
  const start = Date.now();
  await ack();
  const latency = Date.now() - start;
  await respond({ text: `Pong!\nLatency: ${latency}ms` });
});

function convertMarkdownToMrkdwn(text) {
  if (!text) return "";
  return text
    // Replace markdown bold (**text**) with Slack bold (*text*)
    .replace(/\*\*(.*?)\*\*/g, "*$1*")
    // Replace markdown links ([text](url)) with Slack links (<url|text>)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");
}

async function handleAIHelp({ channel_id, thread_ts, text, slackClient, respond }) {
  if (!process.env.HACKAI_KEY) {
    const errorText = "Bot configuration error: HACKAI_KEY is missing.";
    if (respond) await respond({ text: errorText });
    else await slackClient.chat.postMessage({ channel: channel_id, thread_ts, text: errorText });
    return;
  }

  let threadText = "";
  if (thread_ts) {
    try {
      let replies;
      try {
        replies = await slackClient.conversations.replies({
          channel: channel_id,
          ts: thread_ts,
        });
      } catch (replyErr) {
        if (replyErr.code === "slack_webapi_platform_error" && replyErr.data.error === "not_in_channel") {
          await slackClient.conversations.join({ channel: channel_id });
          replies = await slackClient.conversations.replies({
            channel: channel_id,
            ts: thread_ts,
          });
        } else {
          throw replyErr;
        }
      }
      threadText = replies.messages
        .map((m) => {
          const sender = m.user ? `<@${m.user}>` : `Bot (${m.username || m.bot_id})`;
          return `${sender}: ${m.text}`;
        })
        .join("\n");
    } catch (error) {
      console.error("Failed to fetch thread replies:", error);
      threadText = "Could not fetch thread messages due to an error.";
    }
  }

  const systemPrompt = `You are a strict, highly concise Slack AI assistant helping users in this workspace.

You MUST follow these rules:
1. CONCISENESS: Keep your final response short, direct, and under 3 sentences. No fluff.
2. STRICT CITATIONS: You are FORBIDDEN from stating facts or answers without citing the source.
   - If citing messages: Reference the sender (e.g. "<@USER_ID>") and channel (e.g. "in #faq").
   - If citing bookmarks: Reference the tab title and provide the exact URL.
3. NO GUESSING OR HALLUCINATION: Never answer using your general training knowledge. If your tools do not return the exact answer, you MUST say: "I cannot find the answer to this in the Slack history or bookmarks." and stop. Do not guess.
4. TOOL EXECUTION: Always use the tools first to gather actual facts. Do not try to answer without using tools if the information is not in the thread history.

Tools at your disposal:
- search_channel_history: Searches messages in a specific channel.
- list_channels: Lists public channel names and IDs.
- list_channel_bookmarks: Lists bookmarks/tabs in a channel.
- read_web_page: Fetches text from a bookmark or document URL.

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
  ];

  let answerText = "";
  try {
    let loopCount = 0;
    let keepRunning = true;

    while (loopCount < 3 && keepRunning) {
      const res = await fetch("https://ai.hackclub.com/proxy/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.HACKAI_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "google/gemini-3.1-flash-lite",
          messages,
          tools
        })
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`API error (Status ${res.status}): ${errText}`);
      }

      const data = await res.json();
      const choice = data.choices[0];
      const message = choice.message;

      if (message.tool_calls && message.tool_calls.length > 0) {
        messages.push(message);

        for (const toolCall of message.tool_calls) {
          if (toolCall.function.name === "search_channel_history") {
            let args;
            try {
              args = JSON.parse(toolCall.function.arguments);
            } catch (err) {
              args = { query: toolCall.function.arguments };
            }

            const targetChannel = args.channel_id || channel_id;
            let searchResults = [];
            try {
              let history;
              try {
                history = await slackClient.conversations.history({
                  channel: targetChannel,
                  limit: 100,
                });
              } catch (historyErr) {
                // If bot is not in the public channel, try joining it
                if (historyErr.code === "slack_webapi_platform_error" && historyErr.data.error === "not_in_channel") {
                  await slackClient.conversations.join({ channel: targetChannel });
                  history = await slackClient.conversations.history({
                    channel: targetChannel,
                    limit: 100,
                  });
                } else {
                  throw historyErr;
                }
              }

              searchResults = history.messages
                .filter((m) => m.text && m.text.toLowerCase().includes(args.query.toLowerCase()))
                .map((m) => ({
                  user: m.user || m.bot_id || "Unknown",
                  text: m.text,
                  ts: m.ts,
                }));
            } catch (err) {
              console.error(`Failed to search channel history for ${targetChannel}:`, err);
              searchResults = { error: `Failed to search channel history: ${err.message}` };
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
              let res;
              try {
                res = await slackClient.bookmarks.list({
                  channel: args.channel_id,
                });
              } catch (bookmarkErr) {
                if (bookmarkErr.code === "slack_webapi_platform_error" && bookmarkErr.data.error === "not_in_channel") {
                  await slackClient.conversations.join({ channel: args.channel_id });
                  res = await slackClient.bookmarks.list({
                    channel: args.channel_id,
                  });
                } else {
                  throw bookmarkErr;
                }
              }

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
              searchResults = {
                error: `Failed to list bookmarks: ${err.message}. If this is a missing scope error, make sure the Slack App has 'bookmarks:read' scope enabled in the developer dashboard.`,
              };
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
          }
        }
        loopCount++;
      } else {
        answerText = message.content;
        keepRunning = false;
      }
    }

    if (!answerText) {
      answerText = "Sorry, I could not generate an answer or encountered a loop limit.";
    }
  } catch (error) {
    console.error("Error calling Gemini API:", error);
    answerText = `Error calling Gemini API: ${error.message}`;
  }

  const formattedAnswerText = convertMarkdownToMrkdwn(answerText);

  // Reply
  if (thread_ts) {
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

app.command("/ai-help", async ({ command, ack, respond, client: slackClient }) => {
  await ack();
  console.log("AI-HELP payload:", JSON.stringify(command, null, 2));
  await handleAIHelp({
    channel_id: command.channel_id,
    thread_ts: command.thread_ts,
    text: command.text,
    slackClient,
    respond,
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
  });
});

(async () => {
  await app.start();
  console.log("bot is running!");
})();