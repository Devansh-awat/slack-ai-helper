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
    } catch (error) {
      console.error("Failed to fetch thread replies:", error);
      threadText = "Could not fetch thread messages due to an error.";
    }
  }

  const systemPrompt = `You are a Slack AI assistant helping developers in a workspace thread.
You have access to the following tools:
1. search_channel_history: Search the last 100 messages in the current Slack channel to find previous messages, context, or what developers said. Use this when asked about previous discussions or context in the current channel.
2. search_slack_workspace: Search all public channels and messages in the entire Slack workspace. Use this when asked to search Slack generally, look up past messages in other channels, or find discussions outside the current channel.
3. list_channels: List all public channels in the Slack workspace to find channel names and IDs. Useful to find channels like #welcome, #faq, etc.
4. list_channel_bookmarks: List all bookmarks/tabs at the top of a specific Slack channel by its ID. Use this to find FAQ links, spreadsheets, or documents pinned as tabs.
5. read_web_page: Fetch the content of a public URL. Use this to read the content of bookmarks or links you find.

Citing sources:
- If you find information from Slack messages, cite the sender (using their <@USER_ID> if available) and provide the message permalink URL as the source.
- If you find information from bookmarks, docs, or web links, cite the bookmark title and provide the URL.

If the thread history does not have enough information to answer, use the appropriate search/list tools to locate the answer.
If you are still not confident in your answer or cannot find the answer, you MUST say so clearly and NOT hallucinate an answer.

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
        description: "Search the recent messages in the current Slack channel for matching context or previous messages.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The term or phrase to search for in the recent message history.",
            },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_slack_workspace",
        description: "Search all public channels and messages in the entire Slack workspace for context, discussions, or answers.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The search query term or phrase.",
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

            let searchResults = [];
            try {
              const history = await slackClient.conversations.history({
                channel: channel_id,
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
              console.error("Failed to search channel history:", err);
            }

            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              name: "search_channel_history",
              content: JSON.stringify(searchResults),
            });
          } else if (toolCall.function.name === "search_slack_workspace") {
            let args;
            try {
              args = JSON.parse(toolCall.function.arguments);
            } catch (err) {
              args = { query: toolCall.function.arguments };
            }

            let searchResults = [];
            try {
              const res = await slackClient.search.messages({
                query: args.query,
                count: 10,
              });
              if (res.ok && res.messages && res.messages.matches) {
                searchResults = res.messages.matches.map((m) => ({
                  channel: m.channel ? `#${m.channel.name}` : "Unknown",
                  user: m.username || m.user || "Unknown",
                  text: m.text,
                  permalink: m.permalink,
                  ts: m.ts,
                }));
              }
            } catch (err) {
              console.error("Failed to search Slack workspace:", err);
              searchResults = {
                error: `Failed to search Slack workspace: ${err.message}. If this is a missing scope error, make sure the Slack App has the 'search:read' scope enabled in the developer dashboard and the app is reinstalled.`,
              };
            }

            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              name: "search_slack_workspace",
              content: JSON.stringify(searchResults),
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