const axios = require("axios");

function makeClient({ jiraBaseUrl, jiraEmail, jiraToken }) {
  const auth = Buffer.from(`${jiraEmail}:${jiraToken}`).toString("base64");
  const http = axios.create({
    baseURL: jiraBaseUrl,
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    timeout: 30000,
  });

  async function searchIssues(jql) {
    const out = [];
    let startAt = 0;
    const pageSize = 100;
    while (true) {
      const res = await http.post("/rest/api/3/search", {
        jql,
        startAt,
        maxResults: pageSize,
        fields: ["summary", "status", "issuetype", "priority", "assignee", "updated", "description"],
      });
      out.push(...res.data.issues);
      if (res.data.issues.length < pageSize || startAt + pageSize >= res.data.total) break;
      startAt += pageSize;
    }
    return out;
  }

  return { searchIssues };
}

module.exports = { makeClient };
