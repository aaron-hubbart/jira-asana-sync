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

  // ---------------------------------------------------------------------------
  // Project-name resolution + Tickets-section bootstrap.
  // A customer entry only has to name its Asana project; we discover the GID
  // (and the Tickets section GID, creating the section if needed) here.
  // ---------------------------------------------------------------------------

  async function listWorkspaces() {
    const res = await http.get("/workspaces", { params: { opt_fields: "gid,name", limit: 100 } });
    return res.data.data;
  }

  const projectByName = new Map(); // `${ws||"*"}|${name}` -> gid

  async function resolveProjectGid(projectName, workspaceGid) {
    const cacheKey = `${workspaceGid || "*"}|${projectName}`;
    if (projectByName.has(cacheKey)) return projectByName.get(cacheKey);

    const workspaces = workspaceGid ? [{ gid: workspaceGid }] : await listWorkspaces();
    const matches = [];
    for (const ws of workspaces) {
      let offset = null;
      do {
        const params = { limit: 100, archived: false, opt_fields: "gid,name" };
        if (offset) params.offset = offset;
        const res = await http.get(`/workspaces/${ws.gid}/projects`, { params });
        for (const p of res.data.data) {
          if (p.name === projectName) matches.push({ gid: p.gid, workspace: ws.gid });
        }
        offset = res.data.next_page ? res.data.next_page.offset : null;
      } while (offset);
    }

    if (matches.length === 0) {
      throw new Error(
        `No Asana project named '${projectName}'` +
          (workspaceGid ? ` in workspace ${workspaceGid}` : " in any of your workspaces")
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous Asana project name '${projectName}' (${matches.length} matches). ` +
          `Pin it with 'asana_workspace_gid' or an explicit 'asana_project_gid'.`
      );
    }
    projectByName.set(cacheKey, matches[0].gid);
    return matches[0].gid;
  }

  const sectionByName = new Map(); // `${projectGid}|${name}` -> gid

  // Returns the section GID, creating the section when it does not exist.
  // Pass { create: false } (e.g. during a dry run) to look up only.
  async function ensureSection(projectGid, sectionName = "Tickets", { create = true } = {}) {
    const cacheKey = `${projectGid}|${sectionName}`;
    if (sectionByName.has(cacheKey)) return sectionByName.get(cacheKey);

    const res = await http.get(`/projects/${projectGid}/sections`, {
      params: { opt_fields: "gid,name", limit: 100 },
    });
    const found = (res.data.data || []).find((s) => s.name === sectionName);
    if (found) {
      sectionByName.set(cacheKey, found.gid);
      return found.gid;
    }
    if (!create) return null;

    const createRes = await http.post(`/projects/${projectGid}/sections`, {
      data: { name: sectionName },
    });
    const gid = createRes.data.data.gid;
    sectionByName.set(cacheKey, gid);
    return gid;
  }

  // ---------------------------------------------------------------------------
  // Custom fields + tasks (unchanged behaviour).
  // ---------------------------------------------------------------------------

  const fieldCache = new Map();

  async function getProjectFields(projectGid) {
    if (fieldCache.has(projectGid)) return fieldCache.get(projectGid);
    const res = await http.get(`/projects/${projectGid}/custom_field_settings`, {
      params: {
        opt_fields:
          "custom_field.name,custom_field.gid,custom_field.resource_subtype,custom_field.enum_options.gid,custom_field.enum_options.name",
      },
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
      // Field not present yet (e.g. dry run, or brand-new project) — can't search,
      // so treat as "no existing task". On real runs ensureCustomFields creates it first.
      return null;
    }
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

  // Ensure the two custom fields the sync needs exist on the project.
  // Fields are workspace-scoped, so we find-or-create by name at the workspace
  // level (avoids duplicates across customer projects) then attach to the project.
  async function listWorkspaceCustomFields(wsGid) {
    const out = [];
    let offset = null;
    do {
      const params = { limit: 100, opt_fields: "name,resource_subtype,gid" };
      if (offset) params.offset = offset;
      const res = await http.get(`/workspaces/${wsGid}/custom_fields`, { params });
      out.push(...res.data.data);
      offset = res.data.next_page ? res.data.next_page.offset : null;
    } while (offset);
    return out;
  }

  async function findOrCreateWorkspaceField(wsGid, name, subtype) {
    const existing = (await listWorkspaceCustomFields(wsGid)).find(
      (f) => f.name === name && f.resource_subtype === subtype
    );
    if (existing) return existing.gid;
    const data = { workspace: wsGid, name, resource_subtype: subtype, type: subtype };
    if (subtype === "enum") data.enum_options = []; // options are added on the fly as statuses appear
    try {
      const res = await http.post(`/custom_fields`, { data });
      return res.data.data.gid;
    } catch (e) {
      // Some workspaces reject an enum created with no options — retry with a seed.
      if (subtype === "enum") {
        const res = await http.post(`/custom_fields`, { data: { ...data, enum_options: [{ name: "Unmapped" }] } });
        return res.data.data.gid;
      }
      throw e;
    }
  }

  async function ensureCustomFields(projectGid, { create = true } = {}) {
    const fields = await getProjectFields(projectGid);
    const need = [];
    if (!fields[CUSTOM_FIELD_JIRA_KEY]) need.push([CUSTOM_FIELD_JIRA_KEY, "text"]);
    if (!fields[CUSTOM_FIELD_JIRA_STATUS]) need.push([CUSTOM_FIELD_JIRA_STATUS, "enum"]);
    if (need.length === 0) return { created: [] };
    if (!create) return { created: [], wouldCreate: need.map((n) => n[0]) };

    const wsGid = await getProjectWorkspace(projectGid);
    const created = [];
    for (const [name, subtype] of need) {
      const gid = await findOrCreateWorkspaceField(wsGid, name, subtype);
      await http.post(`/projects/${projectGid}/addCustomFieldSetting`, {
        data: { custom_field: gid, is_important: false },
      });
      created.push(name);
    }
    fieldCache.delete(projectGid); // refresh so the new fields (gids + enum options) are picked up
    return { created };
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
      data: { name, notes, projects: [projectGid], custom_fields: customFields },
    });
    const taskGid = createRes.data.data.gid;

    // Move into the Tickets section.
    await http.post(`/sections/${sectionGid}/addTask`, { data: { task: taskGid } });

    return taskGid;
  }

  async function updateTaskStatus({ projectGid, taskGid, jiraStatus }) {
    const fields = await getProjectFields(projectGid);
    const statusField = fields[CUSTOM_FIELD_JIRA_STATUS];
    if (!statusField) throw new Error(`Project ${projectGid} missing '${CUSTOM_FIELD_JIRA_STATUS}'`);
    const statusOptionGid = await ensureEnumOption(statusField.gid, jiraStatus, statusField);
    await http.put(`/tasks/${taskGid}`, {
      data: { custom_fields: { [statusField.gid]: statusOptionGid } },
    });
  }

  return {
    resolveProjectGid,
    ensureSection,
    ensureCustomFields,
    findTaskByJiraKey,
    createTask,
    updateTaskStatus,
  };
}

module.exports = { makeClient };
