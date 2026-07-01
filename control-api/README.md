# syncops-api

Control-plane API for [`jira-asana-sync`](../). The SyncOps front end calls this;
this service performs scoped operations against the GKE API server so the browser
never holds cluster credentials. See `../jira-asana-sync API & Deploy` for the full spec.

## Endpoints (`/api/v1`)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/config` | current `customers.yaml` + `resourceVersion` |
| POST | `/config:validate` | validate customers, no write |
| PUT | `/config` | validate + apply the ConfigMap (optimistic `resourceVersion`) |
| GET | `/cronjob` | schedule, `LOOKBACK_MINUTES`, suspend state |
| PATCH | `/cronjob` | patch schedule / `LOOKBACK_MINUTES` |
| GET | `/runs` | list recent Jobs + status |
| POST | `/runs` | create manual (`{"mode":"manual"}`) or dry-run Job |
| GET | `/runs/:name/logs` | SSE stream of the pod's JSON log lines |
| GET | `/status` | CronJob health + last run |

## Run locally

Point kubectl at the cluster, then:

```bash
npm install
npm run dev        # KUBECONFIG_LOCAL=true, REQUIRE_IAP=false, uses your kubeconfig

curl localhost:8080/api/v1/status
curl localhost:8080/api/v1/config
curl -XPOST localhost:8080/api/v1/runs -H 'content-type: application/json' -d '{"mode":"dry-run"}'
```

## Build & deploy (mirrors the sync's pipeline)

```bash
gcloud builds submit . --config cloudbuild.yaml --project tam-aaron-hubbart
kubectl apply -f k8s/rbac.yaml
kubectl apply -f k8s/deploy.yaml     # also deploys syncops-web + Ingress + IAP
```

## Auth

Behind IAP the load balancer injects a verified identity. This scaffold reads the
forwarded email and requires it to be present. **Before production, verify the
signed JWT** in `x-goog-iap-jwt-assertion` (audience + Google public keys) — see the
comment at the top of `src/server.js`.

## Notes

- `@kubernetes/client-node` method signatures vary by version; this targets the
  0.20–0.22 positional style. Adjust call sites if you pin a newer major.
- The ServiceAccount (`k8s/rbac.yaml`) is scoped to the `jira-asana-sync`
  namespace and has **no** access to `jira-asana-sync-secrets`.
