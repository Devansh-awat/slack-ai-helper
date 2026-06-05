require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { App } = require("@slack/bolt");

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true
});

function searchWorkspace(query) {
  const rootDir = process.cwd();
  const results = [];
  const maxResults = 10;
  const maxLineLength = 200;

  function walk(dir) {
    if (results.length >= maxResults) return;

    let files;
    try {
      files = fs.readdirSync(dir);
    } catch (err) {
      return;
    }

    for (const file of files) {
      if (results.length >= maxResults) return;

      const fullPath = path.join(dir, file);
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch (err) {
        continue;
      }

      if (stat.isDirectory()) {
        if (file === "node_modules" || file === ".git" || file === ".github" || file === "dist" || file === "build") {
          continue;
        }
        walk(fullPath);
      } else if (stat.isFile()) {
        if (
          file === "package-lock.json" ||
          file === "yarn.lock" ||
          file === "pnpm-lock.yaml" ||
          file === ".env" ||
          file.endsWith(".png") ||
          file.endsWith(".jpg") ||
          file.endsWith(".jpeg") ||
          file.endsWith(".gif") ||
          file.endsWith(".ico") ||
          file.endsWith(".pdf") ||
          file.endsWith(".zip")
        ) {
          continue;
        }

        try {
          const content = fs.readFileSync(fullPath, "utf8");
          if (content.toLowerCase().includes(query.toLowerCase())) {
            const relativePath = path.relative(rootDir, fullPath);
            const lines = content.split("\n");
            const matchingLines = [];

            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(query.toLowerCase())) {
                let lineText = lines[i].trim();
                if (lineText.length > maxLineLength) {
                  lineText = lineText.substring(0, maxLineLength) + "...";
                }
                matchingLines.push({ line: i + 1, content: lineText });
              }
            }

            results.push({
              file: relativePath,
              matches: matchingLines.slice(0, 5)
            });
          }
        } catch (err) {
          // ignore read errors
        }
      }
    }
  }

  walk(rootDir);
  return results;
}

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
You have access to two tools:
1. search_workspace: Search the local codebase files for files/code.
2. search_channel_history: Search the last 100 messages in the current Slack channel to find previous messages, context, or what developers said. Use this when asked about previous discussions or context in the channel.

Citing sources:
- If you find information from local workspace files, cite the relative file path.
- If you find information from previous channel messages, cite the sender (using their <@USER_ID> if available) and reference what they said.

If the thread history does not have enough information to answer, use the appropriate search tool.
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
        name: "search_workspace",
        description: "Search the local workspace codebase files for code, configuration, or documentation matching the query.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The term or phrase to search for in the files.",
            },
          },
          required: ["query"],
        },
      },
    },
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
          if (toolCall.function.name === "search_workspace") {
            let args;
            try {
              args = JSON.parse(toolCall.function.arguments);
            } catch (err) {
              args = { query: toolCall.function.arguments };
            }
            const searchResults = searchWorkspace(args.query || "");

            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              name: "search_workspace",
              content: JSON.stringify(searchResults),
            });
          } else if (toolCall.function.name === "search_channel_history") {
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