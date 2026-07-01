const { loadCustomers, loadEnv } = require("./config");
const state = require("./state");
const jiraModule = require("./jira");
const asanaModule = require("./asana");

function log(level, msg, extra) {
  const line = { ts: new Date().toISOString(), level, msg, ...(extra || {}) };
  console.log(JSON.stringify(line));
}

function buildJqlWithLookback(baseJql, minutes) {
  // minutes <= 0 => full sync (no time filter). Used for one-time backfills.
  return minutes > 0 ? `(${baseJql}) AND updated >= -${minutes}m` : baseJql;
}

function buildAsanaName(issue) {
  return `[${issue.key}] ${issue.fields.summary}`;
}

function buildAsanaNotes(issue, jiraBaseUrl) {
  const url = `${jiraBaseUrl}/browse/${issue.key}`;
  const type = issue.fields.issuetype?.name || "Issue";
  const priority = issue.fields.priority?.name || "None";
  const assignee = issue.fields.assignee?.displayName || "Unassigned";
  return [
    `Jira: ${url}`,
    `Type: ${type}`,
    `Priority: ${priority}`,
    `Assignee: ${assignee}`,
    "",
    "Synced by jira-asana-sync. Edits made here will not be pushed back to Jira.",
  ].join("\n");
}

async function processCustomer(customer, ctx) {
  const { jira, asana, db, env } = ctx;

  // Resolve the Asana target from the project NAME (unless GIDs are hard-coded).
  // Creates the Tickets section if it does not exist (skipped on dry runs).
  let projectGid, sectionGid;
  try {
    projectGid =
      customer.asana_project_gid ||
      (await asana.resolveProjectGid(customer.asana_project_name, customer.asana_workspace_gid));
    sectionGid =
      customer.asana_section_gid ||
      (await asana.ensureSection(projectGid, customer.tickets_section || "Tickets", { create: !env.dryRun }));
    log("info", "resolved asana target", {
      customer: customer.name,
      project: customer.asana_project_name || projectGid,
      projectGid,
      sectionGid: sectionGid || "(dry-run: would create)",
    });
    const cf = await asana.ensureCustomFields(projectGid, { create: !env.dryRun });
    if (cf.created && cf.created.length) {
      log("info", "created custom fields", { customer: customer.name, fields: cf.created });
    } else if (cf.wouldCreate && cf.wouldCreate.length) {
      log("info", "would create custom fields", { customer: customer.name, fields: cf.wouldCreate });
    }
  } catch (e) {
    log("error", "asana resolve failed", { customer: customer.name, error: e.message });
    return { created: 0, updated: 0, errors: 1 };
  }

  const jql = buildJqlWithLookback(customer.jira_jql, env.lookbackMinutes);
  log("info", "querying jira", { customer: customer.name, jql });

  let issues;
  try {
    issues = await jira.searchIssues(jql);
  } catch (e) {
    log("error", "jira search failed", { customer: customer.name, error: e.message });
    return { created: 0, updated: 0, errors: 1 };
  }

  let created = 0, updated = 0, errors = 0;

  for (const issue of issues) {
    const status = issue.fields.status?.name || "Unknown";
    try {
      let mapping = state.getMapping(db, issue.key);

      // Fall back to Asana search if DB has no record (handles fresh DB).
      if (!mapping) {
        const existingGid = await asana.findTaskByJiraKey(projectGid, issue.key);
        if (existingGid) {
          state.upsertMapping(db, issue.key, existingGid, null);
          mapping = state.getMapping(db, issue.key);
        }
      }

      if (!mapping) {
        if (env.dryRun) {
          log("info", "would create", { jiraKey: issue.key, customer: customer.name });
        } else {
          const taskGid = await asana.createTask({
            projectGid,
            sectionGid,
            name: buildAsanaName(issue),
            notes: buildAsanaNotes(issue, env.jiraBaseUrl),
            jiraKey: issue.key,
            jiraStatus: status,
          });
          state.upsertMapping(db, issue.key, taskGid, status);
          log("info", "created", { jiraKey: issue.key, taskGid });
        }
        created++;
      } else if (mapping.last_status !== status) {
        if (env.dryRun) {
          log("info", "would update status", { jiraKey: issue.key, from: mapping.last_status, to: status });
        } else {
          await asana.updateTaskStatus({
            projectGid,
            taskGid: mapping.asana_task_gid,
            jiraStatus: status,
          });
          state.upsertMapping(db, issue.key, mapping.asana_task_gid, status);
          log("info", "updated status", { jiraKey: issue.key, from: mapping.last_status, to: status });
        }
        updated++;
      }
    } catch (e) {
      errors++;
      log("error", "issue sync failed", { jiraKey: issue.key, customer: customer.name, error: e.message });
    }
  }

  return { created, updated, errors, total: issues.length };
}

async function main() {
  const env = loadEnv();
  const allCustomers = loadCustomers(env.configPath);
  const customers = env.onlyCustomer
    ? allCustomers.filter((c) => c.name === env.onlyCustomer)
    : allCustomers;
  if (env.onlyCustomer && customers.length === 0) {
    log("fatal", `ONLY_CUSTOMER '${env.onlyCustomer}' not found in customers.yaml`);
    process.exit(1);
  }
  const db = state.open(env.dbPath);
  const jira = jiraModule.makeClient(env);
  const asana = asanaModule.makeClient(env);

  log("info", "run started", { customers: customers.length, dryRun: env.dryRun, lookbackMinutes: env.lookbackMinutes, onlyCustomer: env.onlyCustomer || null, fullSync: env.lookbackMinutes <= 0 });

  const totals = { created: 0, updated: 0, errors: 0, total: 0 };
  for (const c of customers) {
    const r = await processCustomer(c, { jira, asana, db, env });
    log("info", "customer done", { customer: c.name, ...r });
    totals.created += r.created || 0;
    totals.updated += r.updated || 0;
    totals.errors += r.errors || 0;
    totals.total += r.total || 0;
  }

  state.setRunState(db, "last_run", new Date().toISOString());
  log("info", "run finished", totals);
  db.close();

  if (totals.errors > 0) process.exit(1);
}

main().catch((e) => {
  log("fatal", e.message, { stack: e.stack });
  process.exit(1);
});
