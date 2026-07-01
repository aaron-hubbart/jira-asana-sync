// Standalone Slack test — posts a sample "New ticket" and "Ticket update"
// message to a channel, without touching Jira or Asana.
//
// Local (PowerShell):
//   $env:SLACK_BOT_TOKEN='xoxb-...'; node src/slack-test.js "#boa-support"
//   (optional) $env:JIRA_BASE_URL='https://camunda.atlassian.net'  -> makes the Ticket ID a real link
//
// In-cluster (uses the real secret + scopes): kubectl apply -f k8s/slack-test-job.yaml
//
// Channel may be a name (#boa-support or boa-support) or an ID (C0123ABCD).
const slackModule = require("./slack");

function log(level, msg, extra) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(extra || {}) }));
}

async function main() {
  const channel = process.argv[2] || process.env.SLACK_TEST_CHANNEL;
  if (!channel) {
    log("fatal", "usage: node src/slack-test.js <#channel|CID>   (or set SLACK_TEST_CHANNEL)");
    process.exit(1);
  }
  const slackBotToken = process.env.SLACK_BOT_TOKEN;
  if (!slackBotToken) {
    log("fatal", "SLACK_BOT_TOKEN is not set");
    process.exit(1);
  }
  const jiraBaseUrl = (process.env.JIRA_BASE_URL || "https://example.atlassian.net").replace(/\/$/, "");

  // Fake issue with all the fields a real notification uses.
  const issue = {
    key: "TEST-123",
    fields: {
      summary: "Slack integration test ticket — please ignore",
      priority: { name: "High" },
      assignee: { displayName: "Aaron Hubbart" },
      reporter: { displayName: "SyncOps Bot" },
      status: { name: "Waiting for Support" },
    },
  };

  const slack = slackModule.makeClient({ slackBotToken, jiraBaseUrl });
  try {
    const ts1 = await slack.notify(channel, "new", issue);
    log("info", "posted new-ticket test", { channel, ts: ts1 });

    const ts2 = await slack.notify(channel, "update", issue, { from: "Waiting for Support", to: "In Progress" });
    log("info", "posted ticket-update test", { channel, ts: ts2 });

    log("info", "slack test OK — check the channel");
  } catch (e) {
    log("error", "slack test failed", { channel, error: e.message });
    log("info", "common causes: bad token, missing chat:write / channels:read / groups:read scope, or the bot is not a member of the channel");
    process.exit(1);
  }
}

main();
