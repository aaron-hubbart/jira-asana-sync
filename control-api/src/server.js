const express = require("express");
const k8s = require("./k8s");
const { validateCustomers } = require("./validate");

const app = express();
app.use(express.json({ limit: "1mb" }));

// --- Auth (Identity-Aware Proxy) --------------------------------------------
// Front this service with IAP on the GKE Ingress/LB. IAP injects a verified
// identity header. In production you should VERIFY the signed JWT in
// `x-goog-iap-jwt-assertion` with google-auth-library (OAuth2Client.getIapPublicKeys
// + verifySignedJwtWithCertsAsync) and check the audience. This scaffold trusts
// the email header IAP forwards and simply requires it to be present.
app.use((req, res, next) => {
  const raw = req.header("x-goog-authenticated-user-email") || "";
  const email = raw.replace(/^accounts\.google\.com:/, "");
  if (!email && process.env.REQUIRE_IAP !== "false") {
    return res.status(401).json({ error: { code: "unauthenticated", message: "IAP identity missing" } });
  }
  req.user = email || "dev@localhost";
  next();
});

function audit(req, action, extra) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), user: req.user, action, ...(extra || {}) }));
}

// Uniform error envelope. Maps k8s client errors to sensible HTTP codes.
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    const upstream = e.statusCode || (e.response && e.response.statusCode) || (e.body && e.body.code);
    const status = Number.isInteger(upstream) ? upstream : 502;
    const message = (e.body && e.body.message) || e.message || "upstream error";
    if (status >= 500) console.error(JSON.stringify({ level: "error", action: `${req.method} ${req.path}`, message }));
    res.status(status).json({ error: { code: e.code || "upstream_error", message } });
  });

const V = "/api/v1";

// Health (no auth needed for k8s probes — mount before auth if you prefer).
app.get("/healthz", (req, res) => res.json({ ok: true }));

// --- Config (customers.yaml ConfigMap) --------------------------------------
app.get(`${V}/config`, wrap(async (req, res) => {
  res.json(await k8s.getConfig());
}));

app.post(`${V}/config:validate`, wrap(async (req, res) => {
  const errors = validateCustomers(req.body.customers || []);
  res.status(errors.length ? 422 : 200).json({ valid: errors.length === 0, errors });
}));

app.put(`${V}/config`, wrap(async (req, res) => {
  const errors = validateCustomers(req.body.customers || []);
  if (errors.length) return res.status(422).json({ valid: false, errors });
  const out = await k8s.applyConfig(req.body.customers, req.body.resourceVersion);
  audit(req, "config.apply", { resourceVersion: out.resourceVersion, customers: req.body.customers.length });
  res.json(out);
}));

// --- CronJob (schedule + LOOKBACK_MINUTES) ----------------------------------
app.get(`${V}/cronjob`, wrap(async (req, res) => {
  res.json(await k8s.getCronJob());
}));

app.patch(`${V}/cronjob`, wrap(async (req, res) => {
  const out = await k8s.patchCronJob({ schedule: req.body.schedule, lookbackMinutes: req.body.lookbackMinutes });
  audit(req, "cronjob.patch", { schedule: req.body.schedule, lookbackMinutes: req.body.lookbackMinutes });
  res.json(out);
}));

// --- Runs (manual / dry-run Jobs) -------------------------------------------
app.get(`${V}/runs`, wrap(async (req, res) => {
  res.json(await k8s.listRuns());
}));

app.post(`${V}/runs`, wrap(async (req, res) => {
  const mode = req.body.mode === "dry-run" ? "dry-run" : "manual";
  const out = await k8s.createRun(mode);
  audit(req, "run.create", { name: out.name, mode });
  res.status(202).json(out);
}));

app.get(`${V}/runs/:name/logs`, wrap(async (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders && res.flushHeaders();
  await k8s.streamRunLogs(req.params.name, res);
}));

// --- Status -----------------------------------------------------------------
app.get(`${V}/status`, wrap(async (req, res) => {
  res.json(await k8s.getStatus());
}));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`syncops-api listening on :${port} (namespace ${process.env.SYNC_NAMESPACE || "jira-asana-sync"})`));
