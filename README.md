# jira-asana-sync

One-way sync from Jira to Asana. Reads recently updated Jira issues per customer, creates Asana tasks in each customer's project under a "Tickets" section, and keeps a "Jira Status" custom field in sync. Runs as a Kubernetes CronJob on tam-ah-admin-cluster.

> **What changed:** you now configure a customer with just the **exact Asana project name**. On each run the sync resolves that name to a project GID and finds the **Tickets** section, **creating it if it doesn't exist**. You no longer have to look up project/section GIDs by hand. (Hard-coded GIDs are still honored if you prefer them.)

## How it works

Every 10 minutes the CronJob runs `node src/index.js`, which loops over `customers.yaml` and for each entry:

1. Resolves `asana_project_name` to a project GID (searching your workspaces), then finds the `Tickets` section, creating it if missing.
2. Runs the configured JQL with `AND updated >= -20m` appended.
3. For each issue, looks up the Asana task GID in a SQLite state DB. If missing, falls back to an Asana search by Jira Key custom field.
4. If no Asana task exists, creates one in the project, moves it into the Tickets section, sets the Jira Key and Jira Status fields. New status enum values are added on the fly.
5. If a task exists and the status changed since last run, updates the Jira Status field.

State lives in `/data/state.db` on a 1Gi PVC. Losing the PVC is recoverable, the search fallback rebuilds the map on the next run.

## Prerequisites

1. Jira API token: id.atlassian.com, Profile, Security, Create API token.
2. Asana PAT: app.asana.com/0/my-apps.
3. On each customer's Asana project, add two custom fields:
   - `Jira Key` (text)
   - `Jira Status` (single-select, no initial options needed)
4. Know the **exact name** of each customer's Asana project. That's it — the `Tickets` section is created automatically on the first run if it isn't already there.

## Configure `customers.yaml`

```yaml
customers:
  - name: Bank of America
    jira_jql: 'project = Support AND "Customer Domain" in ("bofa.com") AND (createdDate >= "2026-01-01" OR status not in (Resolved, Closed))'
    asana_project_name: "Bank of America — Support"
    # tickets_section: "Tickets"      # optional, this is the default
    # asana_workspace_gid: "1128..."  # optional, only if the name is ambiguous
    # asana_project_gid: "1214..."    # optional, skip name resolution entirely
    # asana_section_gid: "1216..."    # optional, skip section lookup entirely
```

Required per customer: `name`, `jira_jql`, and either `asana_project_name` or `asana_project_gid`.

If the same project name exists in more than one workspace you belong to, resolution fails with an "ambiguous" error — set `asana_workspace_gid` (or a hard `asana_project_gid`) for that customer. To find a workspace GID:

```pwsh
$pat = '<your asana PAT>'
$h = @{ Authorization = "Bearer $pat" }
Invoke-RestMethod -Headers $h -Uri 'https://app.asana.com/api/1.0/workspaces'
```

## Build and deploy

```pwsh
# From the repo root
cd jira-asana-sync

# Build via Cloud Build
gcloud builds submit . --config cloudbuild.yaml --project tam-aaron-hubbart

# Create namespace + config + PVC + secret
kb apply -f k8s/namespace-and-config.yaml
kb apply -f k8s/pvc.yaml

kb -n jira-asana-sync create secret generic jira-asana-sync-secrets `
  --from-literal=JIRA_BASE_URL='https://camunda.atlassian.net' `
  --from-literal=JIRA_EMAIL='aaron.hubbart@camunda.com' `
  --from-literal=JIRA_API_TOKEN='<token>' `
  --from-literal=ASANA_PAT='<pat>'

# Push the real customers.yaml into the ConfigMap
kb -n jira-asana-sync create configmap jira-asana-sync-config `
  --from-file=customers.yaml=.\customers.yaml `
  --dry-run=client -o yaml | kb apply -f -

# Deploy the CronJob
kb apply -f k8s/cronjob.yaml
```

## Verify

```pwsh
# Run once on demand
kb -n jira-asana-sync create job --from=cronjob/jira-asana-sync sync-manual-1
kb -n jira-asana-sync logs -l job-name=sync-manual-1 -f
```

Dry-run locally with podman (name resolution runs, but no tasks or sections are created):

```pwsh
podman build --no-cache --pull -f Containerfile -t jira-asana-sync:dev .
podman run --rm `
  -e JIRA_BASE_URL='https://camunda.atlassian.net' `
  -e JIRA_EMAIL='aaron.hubbart@camunda.com' `
  -e JIRA_API_TOKEN='<token>' `
  -e ASANA_PAT='<pat>' `
  -e DRY_RUN='true' `
  -e DB_PATH='/tmp/state.db' `
  -e CONFIG_PATH='/app/customers.yaml' `
  -v "${PWD}\customers.yaml:/app/customers.yaml:ro" `
  jira-asana-sync:dev
```

## Tuning

- `LOOKBACK_MINUTES` env var widens or narrows the JQL window. Default 20 in the CronJob, 60 in code. Keep this larger than the schedule interval so transient errors don't drop updates.
- Change the schedule in `k8s/cronjob.yaml`. Every 10 minutes is the default.

## Limits and caveats

- One-way only. Edits in Asana never go back to Jira.
- Project-name resolution scans your workspaces' projects once per run and caches the result. Duplicate project names across workspaces require `asana_workspace_gid`.
- New Jira status names become new enum options on the Asana field. They will not be deleted automatically if a workflow status is renamed.
- Asana free-tier rate limit is 150 requests per minute. With 8 customers and modest volume you will not hit this.
