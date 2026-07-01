// Thin wrapper over the Kubernetes API for the jira-asana-sync namespace.
//
// NOTE ON CLIENT VERSIONS: @kubernetes/client-node method signatures differ
// between major versions. This file targets the 0.20–0.22 positional style
// (e.g. readNamespacedConfigMap(name, namespace)). If you pin a newer release
// that switched to a single options object, adjust the call sites accordingly.
const k8s = require("@kubernetes/client-node");
const yaml = require("js-yaml");
const { PassThrough } = require("stream");

const NS = process.env.SYNC_NAMESPACE || "jira-asana-sync";
const CONFIGMAP = "jira-asana-sync-config";
const CRONJOB = "jira-asana-sync";
const CONTAINER = "sync";

const kc = new k8s.KubeConfig();
if (process.env.KUBECONFIG_LOCAL === "true") kc.loadFromDefault();
else kc.loadFromCluster();

const core = kc.makeApiClient(k8s.CoreV1Api);
const batch = kc.makeApiClient(k8s.BatchV1Api);
const logApi = new k8s.Log(kc);

function conflict(msg) {
  const e = new Error(msg);
  e.statusCode = 409;
  return e;
}

// ---- ConfigMap (customers.yaml) --------------------------------------------

async function getConfig() {
  const { body } = await core.readNamespacedConfigMap(CONFIGMAP, NS);
  const parsed = yaml.load((body.data && body.data["customers.yaml"]) || "customers: []") || {};
  return { resourceVersion: body.metadata.resourceVersion, customers: parsed.customers || [] };
}

async function applyConfig(customers, resourceVersion) {
  const body = {
    metadata: {
      name: CONFIGMAP,
      namespace: NS,
      // Sending resourceVersion makes the replace optimistic: a stale value
      // yields a 409 from the API server, so two editors can't clobber each other.
      ...(resourceVersion ? { resourceVersion } : {}),
    },
    data: { "customers.yaml": yaml.dump({ customers }, { lineWidth: -1 }) },
  };
  const { body: out } = await core.replaceNamespacedConfigMap(CONFIGMAP, NS, body);
  return { resourceVersion: out.metadata.resourceVersion, appliedAt: new Date().toISOString() };
}

// ---- CronJob (schedule + LOOKBACK_MINUTES) ---------------------------------

function syncContainer(cronjob) {
  const containers = cronjob.spec.jobTemplate.spec.template.spec.containers;
  return containers.find((c) => c.name === CONTAINER) || containers[0];
}

async function getCronJob() {
  const { body } = await batch.readNamespacedCronJob(CRONJOB, NS);
  const c = syncContainer(body);
  const lb = (c.env || []).find((e) => e.name === "LOOKBACK_MINUTES");
  return {
    schedule: body.spec.schedule,
    lookbackMinutes: lb ? Number(lb.value) : null,
    suspend: !!body.spec.suspend,
    lastScheduleTime: body.status && body.status.lastScheduleTime,
  };
}

async function patchCronJob({ schedule, lookbackMinutes }) {
  // Read-modify-replace: cleanest way to edit one env var in an array.
  const { body } = await batch.readNamespacedCronJob(CRONJOB, NS);
  if (schedule) body.spec.schedule = schedule;
  if (lookbackMinutes != null) {
    const c = syncContainer(body);
    c.env = c.env || [];
    const lb = c.env.find((e) => e.name === "LOOKBACK_MINUTES");
    if (lb) lb.value = String(lookbackMinutes);
    else c.env.push({ name: "LOOKBACK_MINUTES", value: String(lookbackMinutes) });
  }
  await batch.replaceNamespacedCronJob(CRONJOB, NS, body);
  return getCronJob();
}

// ---- Jobs (manual / dry-run runs) ------------------------------------------

async function anyActiveJob() {
  const { body } = await batch.listNamespacedJob(NS);
  return body.items.find((j) => (j.status && j.status.active) > 0);
}

function jobStatus(j) {
  const conds = (j.status && j.status.conditions) || [];
  if (conds.find((c) => c.type === "Complete" && c.status === "True")) return "Succeeded";
  if (conds.find((c) => c.type === "Failed" && c.status === "True")) return "Failed";
  return j.status && j.status.active ? "Running" : "Pending";
}

async function createRun(mode) {
  const dry = mode === "dry-run";
  // Honor the CronJob's concurrencyPolicy: Forbid.
  if (await anyActiveJob()) throw conflict("a sync Job is already active (concurrencyPolicy: Forbid)");

  const { body: cj } = await batch.readNamespacedCronJob(CRONJOB, NS);
  const suffix = Date.now().toString().slice(-6);
  const name = (dry ? "dry-run-" : "sync-manual-") + suffix;

  const job = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name,
      namespace: NS,
      labels: { "syncops/trigger": dry ? "dry-run" : "manual" },
      annotations: { "cronjob.kubernetes.io/instantiate": "manual" },
    },
    spec: JSON.parse(JSON.stringify(cj.spec.jobTemplate.spec)),
  };
  if (dry) {
    const c = job.spec.template.spec.containers.find((x) => x.name === CONTAINER) || job.spec.template.spec.containers[0];
    c.env = c.env || [];
    c.env.push({ name: "DRY_RUN", value: "true" });
  }

  await batch.createNamespacedJob(NS, job);
  return { name, trigger: dry ? "dry-run" : "manual", startedAt: new Date().toISOString(), status: "Running" };
}

async function listRuns() {
  const { body } = await batch.listNamespacedJob(NS);
  const runs = body.items
    .sort((a, b) => new Date(b.metadata.creationTimestamp) - new Date(a.metadata.creationTimestamp))
    .map((j) => ({
      name: j.metadata.name,
      trigger: (j.metadata.labels && j.metadata.labels["syncops/trigger"]) || "scheduled",
      startedAt: (j.status && j.status.startTime) || j.metadata.creationTimestamp,
      completedAt: j.status && j.status.completionTime,
      status: jobStatus(j),
    }));
  return { runs };
}

// ---- Log streaming (SSE) ---------------------------------------------------

async function streamRunLogs(jobName, res) {
  const { body: pods } = await core.listNamespacedPod(
    NS, undefined, undefined, undefined, undefined, `job-name=${jobName}`
  );
  if (!pods.items.length) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: "no pod for job yet" })}\n\n`);
    return res.end();
  }
  const pod = pods.items[0].metadata.name;
  const stream = new PassThrough();
  stream.on("data", (chunk) => {
    chunk.toString().split("\n").filter(Boolean).forEach((line) => res.write(`data: ${line}\n\n`));
  });
  const req = await logApi.log(NS, pod, CONTAINER, stream, { follow: true, tailLines: 1000 });
  const close = () => { try { req.abort(); } catch (_) {} };
  res.on("close", close);
  stream.on("end", () => { res.write(`event: done\ndata: {}\n\n`); res.end(); });
}

// ---- Status ----------------------------------------------------------------

async function getStatus() {
  const cronjob = await getCronJob();
  const { runs } = await listRuns();
  return { cronjob, lastRun: runs[0] || null };
}

module.exports = {
  getConfig, applyConfig,
  getCronJob, patchCronJob,
  createRun, listRuns, streamRunLogs,
  getStatus,
};
