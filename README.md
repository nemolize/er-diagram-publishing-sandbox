# er-diagram-publishing-sandbox

Throwaway repository for an article comparing where to publish an ER diagram generated from a schema file
(committed file with a CI check, wiki, GitHub Pages, workflow artifact).

- `schema/schema.sql` is the only hand-edited input.
- `docs/er.md` holds the Mermaid ER diagram that GitHub draws; `.github/workflows/` holds the experiments.
- `main` is protected by a ruleset (pull request and the `er-check` status check required).
