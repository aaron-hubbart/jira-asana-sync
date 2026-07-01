// Shared customer validation — mirrors src/config.js in jira-asana-sync so the
// UI gets the same errors before anything is written to the cluster.
const REQUIRED = ["name", "jira_jql"];

function bad(v) {
  return !v || String(v).trim() === "" || v === "REPLACE_ME";
}

function validateCustomers(customers) {
  const errors = [];
  if (!Array.isArray(customers) || customers.length === 0) {
    errors.push({ index: -1, message: "at least one customer is required" });
    return errors;
  }
  customers.forEach((c, i) => {
    REQUIRED.forEach((f) => {
      if (bad(c[f])) {
        errors.push({ index: i, customer: c.name || "unnamed", field: f, message: "missing required field" });
      }
    });
    if (bad(c.asana_project_name) && bad(c.asana_project_gid)) {
      errors.push({
        index: i,
        customer: c.name || "unnamed",
        field: "asana_project_name",
        message: "provide asana_project_name (or an explicit asana_project_gid)",
      });
    }
  });
  return errors;
}

module.exports = { validateCustomers };
