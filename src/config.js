const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

function loadCustomers(configPath) {
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = yaml.load(raw);
  if (!parsed || !Array.isArray(parsed.customers)) {
    throw new Error("customers.yaml must contain a top-level 'customers' list");
  }
  for (const c of parsed.customers) {
    for (const k of ["name", "jira_jql", "asana_project_gid", "asana_section_gid"]) {
      if (!c[k] || c[k] === "REPLACE_ME") {
        throw new Error(`Customer '${c.name || "unnamed"}' is missing '${k}'`);
      }
    }
  }
  return parsed.customers;
}

function loadEnv() {
  const required = [
    "JIRA_BASE_URL",
    "JIRA_EMAIL",
    "JIRA_API_TOKEN",
    "ASANA_PAT",
  ];
  for (const k of required) {
    if (!process.env[k]) throw new Error(`Missing env var ${k}`);
  }
  return {
    jiraBaseUrl: process.env.JIRA_BASE_URL.replace(/\/$/, ""),
    jiraEmail: process.env.JIRA_EMAIL,
    jiraToken: process.env.JIRA_API_TOKEN,
    asanaPat: process.env.ASANA_PAT,
    lookbackMinutes: parseInt(process.env.LOOKBACK_MINUTES || "60", 10),
    dbPath: process.env.DB_PATH || "/data/state.db",
    dryRun: process.env.DRY_RUN === "true",
    configPath: process.env.CONFIG_PATH || path.join(__dirname, "..", "customers.yaml"),
  };
}

module.exports = { loadCustomers, loadEnv };
