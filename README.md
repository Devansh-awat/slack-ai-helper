ai help bot for slack

it answers questions grounded in the workspace's own messages, bookmarks and faq canvases, and replies with cited sources and links to the messages it used.

how to use

open the assistant panel and ask it anything, or mention @ai help bot in a channel or thread and it will look at the thread and answer.

commands

/ai-help shows how to use the bot
/ai-stats shows how many questions it has answered
/ai-ping checks that the bot is online

how it works

it searches public channels using slack's assistant.search.context with the bot token, can read channel bookmarks and faq canvases, and uses an llm to write a short answer with citations. if no action token is available it falls back to a user token search.

running

needs node. runs as a systemd service called slackbot.service. config lives in a .env file with slack_bot_token, slack_app_token and hackai_key, plus an optional slack_user_token for the search fallback.
