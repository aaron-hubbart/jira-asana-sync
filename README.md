# jira-asana-sync

One-way sync from Jira to Asana. Reads recently updated Jira issues per customer, creates Asana tasks in each customer's existing project under a "Tickets" section, and keeps a "Jira Status" custom field in sync. Runs as a Kubernetes CronJob on tam-ah-admin-cluster.

## How it works

Every 10 minutes the CronJob runs `node src/index.js`, which loops over `customers.yaml` and for each entry:

1. Runs the configured JQL with `AND updated >= -20m` appended.
2. For each issue, looks up the Asana task GID in a SQLite state DB. If missing, falls back to an Asana search by Jira Key custom field.
3. If no Asana task exists, creates one in the project, moves it into the Tickets section, sets the Jira Key and Jira Status fields. New status enum values are added on the fly.
4. If a task exists and the status changed since last run, updates the Jira Status field.

State lives in `/data/state.db` on a 1Gi PVC. Losing the PVC is recoverable, the search fallback rebuilds the map on the next run.

## Prerequisites

1. Jira API token: id.atlassian.com, Profile, Security, Create API token.
2. Asana PAT: app.asana.com/0/my-apps.
3. On each customer's Asana project, add two custom fields:
   - `Jira Key` (text)
   - `Jira Status` (single-select, no initial options needed)
4. Each customer's Asana project must already have a section named `Tickets`.

## Get the Asana GIDs you need

```pwsh
$pat = '<your asana PAT>'
$h = @{ Authorization = "Bearer $pat" }

# List your projects to find project GIDs
Invoke-RestMethod -Headers $h `
  -Uri 'https://app.asana.com/api/1.0/users/me/workspaces'

Invoke-RestMethod -Headers $h `
  -Uri 'https://app.asana.com/api/1.0/workspaces/<WORKSPACE_GID>/projects?archived=false'

# For a given project, find the Tickets section GID
Invoke-RestMethod -Headers $h `
  -Uri 'https://app.asana.com/api/1.0/projects/<PROJECT_GID>/sections'
```

Fill `customers.yaml` with the GIDs.

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

# Or run a dry-run first
kb -n jira-asana-sync create job dry-run --from=cronjob/jira-asana-sync `
  --dry-run=client -o yaml |
  ConvertFrom-Yaml |  # if you have powershell-yaml; otherwise edit manually
  Out-Null
```

Simpler dry-run: build locally with podman and run with `DRY_RUN=true`.

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
- Comments, attachments, and assignee changes in Jira are not synced. Add them if you need them, the structure is there.
- New Jira status names become new enum options on the Asana field. They will not be deleted automatically if a workflow status is renamed.
- Asana free-tier rate limit is 150 requests per minute. With 8 customers and modest volume you will not hit this.
