# ER diagram tool comparison

Runner behind the article. Runs five ways of drawing an ER diagram for one schema file (`sample/schema.sql`: a small online shop, 12 tables, 3 declared foreign keys, 11 more relations that exist only as `*_id` column names) and scores each output against that list of 14 relations. The publishing places (committed file with a CI check, wiki, Pages, artifact) were run in a separate public repository, `nemolize/er-diagram-publishing-sandbox`; `results/publishing.json` lists each observation with its workflow run.

Needs macOS with Docker Desktop (SchemaSpy reaches Postgres through `host.docker.internal`), `tbls` 1.97.0 on `PATH`, `uv`, and the Node in `.node-version`. Both Docker images are pinned by digest in `run.mjs`.

```sh
npm install --prefix tools                          # pg-mermaid, pinned
uv venv tools/pyenv && uv pip install --python tools/pyenv/bin/python pglast==8.9
node run.mjs                                        # 5 repetitions per tool -> results/summary.json, results/outputs/
node run.mjs --reps 10 --out results/summary-10.json
```

- `run.mjs` starts a throwaway Postgres container, applies `sample/schema.sql`, runs every tool against it and removes the container. It refuses to overwrite an existing `--out` and a Node other than the one in `.node-version`.
- Every tool's output is reduced to a set of `child->parent` pairs and compared with the 14 known relations; a relation drawn that is not among the 14 is listed under `extra`. A failed tool run is recorded under `meta.failures`, never dropped.
- `medianMs` is the generation time only (SchemaSpy includes starting its Docker container); `idleBefore` lists the CPU idle share measured before each run (the runner waits for `--minidle`, default 0.75).
- `pglast-mermaid.py` is our own emitter on top of `pglast` (inline `REFERENCES` only); `--infer` adds a relation for each `<name>_id` column that has no declared foreign key, pointing at the table `<name>s`.
- `tbls-relations.yml` lists the 11 undeclared relations for `tbls`; `sample/handwritten.mmd` is the typed-by-hand diagram; `sample/schema-keyed.sql` is the same schema with primary keys renamed to `<singular>_id`, for SchemaSpy's inference. The three two-table key layouts probed are in `run.mjs`. `tbls-relations.yml` carries its own DSN, whose port must match `PORT` in `run.mjs`.
