const axios = require("axios");

const CUSTOM_FIELD_JIRA_KEY = "Jira Key";
const CUSTOM_FIELD_JIRA_STATUS = "Jira Status";

function makeClient({ asanaPat }) {
  const http = axios.create({
    baseURL: "https://app.asana.com/api/1.0",
    headers: {
      Authorization: `Bearer ${asanaPat}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    timeout: 30000,
  });

  // Cache custom field GIDs and enum option maps per project so we don't
  // re-fetch on every issue.
  const fieldCache = new Map();

  async function getProjectFields(projectGid) {
    if (fieldCache.has(projectGid)) return fieldCache.get(projectGid);
    const res = await http.get(`/projects/${projectGid}/custom_field_settings`, {
      params: { opt_fields: "custom_field.name,custom_field.gid,custom_field.resource_subtype,custom_field.enum_options.gid,custom_field.enum_options.name" },
    });
    const settings = res.data.data;
    const byName = {};
    for (const s of settings) {
      const cf = s.custom_field;
      byName[cf.name] = {
        gid: cf.gid,
        type: cf.resource_subtype,
        enumOptions: (cf.enum_options || []).reduce((acc, o) => {
          acc[o.name] = o.gid;
          return acc;
        }, {}),
      };
    }
    fieldCache.set(projectGid, byName);
    return byName;
  }

  async function ensureEnumOption(customFieldGid, optionName, cacheEntry) {
    if (cacheEntry.enumOptions[optionName]) return cacheEntry.enumOptions[optionName];
    const res = await http.post(`/custom_fields/${customFieldGid}/enum_options`, {
      data: { name: optionName },
    });
    const gid = res.data.data.gid;
    cacheEntry.enumOptions[optionName] = gid;
    return gid;
  }

  async function findTaskByJiraKey(projectGid, jiraKey) {
    const fields = await getProjectFields(projectGid);
    const keyField = fields[CUSTOM_FIELD_JIRA_KEY];
    if (!keyField) {
      throw new Error(`Project ${projectGid} is missing the '${CUSTOM_FIELD_JIRA_KEY}' custom field`);
    }
    // Use search to find a task in this project with matching custom field value.
    // search API path differs across workspaces; the safest portable approach is
    // to list tasks in the project and filter, but for projects with many tasks
    // we rely on the state DB as the primary lookup. This function is a fallback
    // used only when the DB has no record (e.g. first run, or restored cluster).
    const workspaceGid = await getProjectWorkspace(projectGid);
    const res = await http.get(`/workspaces/${workspaceGid}/tasks/search`, {
      params: {
        [`custom_fields.${keyField.gid}.value`]: jiraKey,
        "projects.any": projectGid,
        opt_fields: "gid,name",
      },
    });
    if (res.data.data && res.data.data.length > 0) return res.data.data[0].gid;
    return null;
  }

  const workspaceCache = new Map();
  async function getProjectWorkspace(projectGid) {
    if (workspaceCache.has(projectGid)) return workspaceCache.get(projectGid);
    const res = await http.get(`/projects/${projectGid}`, {
      params: { opt_fields: "workspace.gid" },
    });
    const wsGid = res.data.data.workspace.gid;
    workspaceCache.set(projectGid, wsGid);
    return wsGid;
  }

  async function createTask({ projectGid, sectionGid, name, notes, jiraKey, jiraStatus }) {
    const fields = await getProjectFields(projectGid);
    const keyField = fields[CUSTOM_FIELD_JIRA_KEY];
    const statusField = fields[CUSTOM_FIELD_JIRA_STATUS];
    if (!keyField) throw new Error(`Project ${projectGid} missing '${CUSTOM_FIELD_JIRA_KEY}'`);
    if (!statusField) throw new Error(`Project ${projectGid} missing '${CUSTOM_FIELD_JIRA_STATUS}'`);

    const statusOptionGid = await ensureEnumOption(statusField.gid, jiraStatus, statusField);

    const customFields = {
      [keyField.gid]: jiraKey,
      [statusField.gid]: statusOptionGid,
    };

    const createRes = await http.post("/tasks", {
      data: {
        name,
        notes,
        projects: [projectGid],
        custom_fields: customFields,
      },
    });
    const taskGid = createRes.data.data.gid;

    // Move into the Tickets section.
    await http.post(`/sections/${sectionGid}/addTask`, {
      data: { task: taskGid },
    });

    return taskGid;
  }

  async function updateTaskStatus({ projectGid, taskGid, jiraStatus }) {
    const fields = await getProjectFields(projectGid);
    const statusField = fields[CUSTOM_FIELD_JIRA_STATUS];
    if (!statusField) throw new Error(`Project ${projectGid} missing '${CUSTOM_FIELD_JIRA_STATUS}'`);
    const statusOptionGid = await ensureEnumOption(statusField.gid, jiraStatus, statusField);
    await http.put(`/tasks/${taskGid}`, {
      data: {
        custom_fields: { [statusField.gid]: statusOptionGid },
      },
    });
  }

  return { findTaskByJiraKey, createTask, updateTaskStatus };
}

module.exports = { makeClient };
