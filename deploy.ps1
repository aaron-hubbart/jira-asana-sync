# sync image (repo root — Containerfile + src\)
gcloud builds submit . --config cloudbuild.yaml --project tam-aaron-hubbart
# control API
cd control-api
gcloud builds submit . --config cloudbuild.yaml --project tam-aaron-hubbart --substitutions=SHORT_SHA=manual
cd ../syncops-web
gcloud builds submit . --config cloudbuild.yaml --project tam-aaron-hubbart --substitutions=SHORT_SHA=manual

kb -n jira-asana-sync rollout restart deploy/syncops-api deploy/syncops-web
kb -n jira-asana-sync rollout status deploy/syncops-api
kb -n jira-asana-sync rollout status deploy/syncops-web
 