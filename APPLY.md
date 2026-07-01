# jira-asana-sync — updated files

These files replace their counterparts in `aaron-hubbart/jira-asana-sync` to add
**Asana-project-name resolution** and **automatic Tickets-section creation**.

## What to commit

Copy over the same paths in the repo:

```
src/config.js     ->  src/config.js     (validation: project name OR gid; defaults tickets_section)
src/asana.js      ->  src/asana.js      (adds resolveProjectGid() + ensureSection())
src/index.js      ->  src/index.js      (resolves target per customer before syncing)
customers.yaml    ->  customers.yaml    (new schema: asana_project_name)
README.md         ->  README.md         (updated prerequisites + config docs)
```

No new dependencies — `axios` and `js-yaml` are already in `package.json`.

## Behaviour

- A customer now needs only `name`, `jira_jql`, and `asana_project_name`.
- On each run, per customer: resolve the project name → GID, then find the
  `Tickets` section (name overridable via `tickets_section`), creating it if absent.
- Dry runs (`DRY_RUN=true`) resolve and look up but never create the section or tasks.
- Backwards compatible: set `asana_project_gid` / `asana_section_gid` to skip
  resolution; set `asana_workspace_gid` to disambiguate duplicate project names.

## Suggested commit

```
git checkout -b feat/resolve-asana-project-by-name
cp -f <these>/src/*.js src/
cp -f <these>/customers.yaml customers.yaml
cp -f <these>/README.md README.md
git commit -am "Resolve Asana project by name; auto-create Tickets section"
git push -u origin feat/resolve-asana-project-by-name
```
