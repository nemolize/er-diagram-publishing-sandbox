// Runs every ER-diagram tool against sample/schema.sql and writes results/summary.json and results/outputs/.
// Usage: node run.mjs [--reps 5] [--out results/summary.json]
// Needs: docker (postgres image, schemaspy image), tbls on PATH, `npm install --prefix tools`, tools/pyenv with pglast.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? dflt : process.argv[i + 1]; };
const reps = Number(arg("reps", "5"));
const outFile = path.resolve(here, arg("out", "results/summary.json"));
if (fs.existsSync(outFile)) { console.error(`refusing to overwrite ${outFile}`); process.exit(1); }

const pinned = fs.readFileSync(path.join(here, ".node-version"), "utf8").trim();
if (process.version !== `v${pinned}`) { console.error(`Node ${process.version} is not the pinned v${pinned}`); process.exit(1); }

const PG_IMAGE = "postgres:18-alpine";
const SCHEMASPY_IMAGE = "schemaspy/schemaspy:latest";
const CONTAINER = "er-diagram-bench-pg";
const PORT = 55434;
const DSN = `postgres://postgres:postgres@127.0.0.1:${PORT}/shop?sslmode=disable`;

// Ground truth: child -> parent, from the *_id columns of sample/schema.sql.
const DECLARED = ["order_items->orders", "order_items->products", "payments->orders"];
const UNDECLARED = [
  "addresses->users", "categories->categories", "products->categories", "product_images->products",
  "orders->users", "orders->addresses", "orders->coupons", "shipments->orders",
  "reviews->products", "reviews->users", "carts->users",
];

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", cwd: here, ...opts });
const run = (cmd, args, opts) => {
  const t0 = performance.now();
  const r = sh(cmd, args, opts);
  return { ms: performance.now() - t0, status: r.status, stdout: r.stdout, stderr: r.stderr };
};
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const firstLine = (s) => s.trim().split("\n")[0];

const mermaidBlock = (text) => /```mermaid\n([\s\S]*?)```/.exec(text)?.[1] ?? text;
function mermaidRelations(text) {
  const rel = new Set();
  const strip = (s) => s.replace(/^"?(?:public\.)?/, "").replace(/"?$/, "");
  for (const line of text.split("\n")) {
    let m = /^\s*"?([\w.]+)"?\s+([|}o]{1,2}[-.]{2}[|{o]{1,2})\s+"?([\w.]+)"?\s*:/.exec(line);
    if (!m) continue;
    const [, left, , right] = m;
    // tbls writes "child }o--|| parent"; the others write "parent ||--o{ child".
    const childFirst = m[2].startsWith("}") || m[2].startsWith("o}") ;
    rel.add(childFirst ? `${strip(left)}->${strip(right)}` : `${strip(right)}->${strip(left)}`);
  }
  return rel;
}
const score = (found) => ({
  declaredDrawn: DECLARED.filter((r) => found.has(r)).length,
  undeclaredDrawn: UNDECLARED.filter((r) => found.has(r)).length,
  extra: [...found].filter((r) => !DECLARED.includes(r) && !UNDECLARED.includes(r)),
});

function impliedCount(anomaliesHtml) {
  const html = fs.readFileSync(anomaliesHtml, "utf8");
  const section = html.slice(html.indexOf("Implied Parent Column"));
  const firstTable = section.slice(0, section.indexOf("</table>"));
  return firstTable.includes("Anomaly not detected") ? 0 : (firstTable.match(/<tr/g) || []).length - 1;
}

const results = {};
const outputs = path.join(here, "results", "outputs");
fs.mkdirSync(outputs, { recursive: true });
const failures = [];

function startDb() {
  sh("docker", ["rm", "-f", CONTAINER]);
  const r = run("docker", ["run", "-d", "--rm", "--name", CONTAINER, "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=shop", "-p", `127.0.0.1:${PORT}:5432`, PG_IMAGE]);
  if (r.status !== 0) throw new Error(`postgres did not start: ${r.stderr}`);
  for (let i = 0; i < 60; i++) {
    if (sh("docker", ["exec", CONTAINER, "pg_isready", "-U", "postgres", "-d", "shop"]).status === 0) {
      // the entrypoint restarts the server once after init; wait for it to settle
      if (sh("docker", ["exec", CONTAINER, "psql", "-U", "postgres", "-d", "shop", "-Atc", "select 1"]).status === 0) return;
    }
    spawnSync("sleep", ["1"]);
  }
  throw new Error("postgres never became ready");
}
const psqlFile = (db, file) => sh("docker", ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q"], { input: fs.readFileSync(path.join(here, file), "utf8") });

function measure(name, command, args, opts = {}) {
  const times = [];
  let last;
  for (let i = 0; i < reps; i++) {
    opts.before?.();
    last = run(command, args, opts.spawn);
    if (last.status !== 0) {
      failures.push({ tool: name, status: last.status, stderr: last.stderr.slice(0, 500) });
      return { times, last, failed: true };
    }
    times.push(last.ms);
  }
  return { times, last, failed: false };
}

try {
  startDb();
  const applied = psqlFile("shop", "sample/schema.sql");
  if (applied.status !== 0) throw new Error(`schema did not apply: ${applied.stderr}`);
  results.postgres = { image: PG_IMAGE, version: firstLine(sh("docker", ["exec", CONTAINER, "psql", "-U", "postgres", "-Atc", "select version()"]).stdout), imageId: firstLine(sh("docker", ["image", "inspect", PG_IMAGE, "--format", "{{.Id}}"]).stdout) };

  const tblsDir = path.join(here, "results", "tbls");
  {
    const m = measure("tbls", "tbls", ["doc", DSN, tblsDir, "--force", "--er-format", "mermaid"]);
    const text = fs.readFileSync(path.join(tblsDir, "README.md"), "utf8");
    fs.writeFileSync(path.join(outputs, "tbls.mmd"), mermaidBlock(text));
    results.tbls = {
      version: firstLine(sh("tbls", ["version"]).stdout), input: "live database", output: "Markdown with a Mermaid block (also SVG/PNG with --er-format)",
      medianMs: Math.round(median(m.times)), ...score(mermaidRelations(mermaidBlock(text))), failed: m.failed,
    };
  }
  // tbls with the undeclared relations listed in .tbls.yml
  {
    const m = measure("tbls-relations", "tbls", ["doc", "-c", "tbls-relations.yml", "--force"]);
    const text = fs.readFileSync(path.join(here, "results", "tbls-relations", "README.md"), "utf8");
    fs.writeFileSync(path.join(outputs, "tbls-relations.mmd"), mermaidBlock(text));
    results.tblsRelations = {
      input: "live database + 11 relations written in .tbls.yml", medianMs: Math.round(median(m.times)), ...score(mermaidRelations(mermaidBlock(text))), failed: m.failed,
    };
  }
  // pg-mermaid, live database
  {
    const out = path.join(here, "results", "pg-mermaid-database.md");
    const bin = path.join(here, "tools", "node_modules", ".bin", "pg-mermaid");
    const m = measure("pg-mermaid", bin, ["-d", "shop", "-U", "postgres", "-h", "127.0.0.1", "-p", String(PORT), "--output-path", out], { spawn: { env: { ...process.env, PGPASSWORD: "postgres" } } });
    const text = fs.readFileSync(out, "utf8");
    fs.writeFileSync(path.join(outputs, "pg-mermaid.mmd"), mermaidBlock(text));
    fs.rmSync(out);
    const pkg = JSON.parse(fs.readFileSync(path.join(here, "tools", "node_modules", "pg-mermaid", "package.json"), "utf8"));
    results.pgMermaid = {
      version: pkg.version, input: "live database", output: "Markdown with a Mermaid block",
      medianMs: Math.round(median(m.times)), ...score(mermaidRelations(mermaidBlock(text))), failed: m.failed,
    };
  }
  {
    const dir = path.join(here, "results", "schemaspy");
    const m = measure("schemaspy", "docker", ["run", "--rm", "-v", `${dir}:/output`, SCHEMASPY_IMAGE, "-t", "pgsql", "-host", "host.docker.internal", "-port", String(PORT), "-db", "shop", "-u", "postgres", "-p", "postgres", "-s", "public"], { before: () => { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); } });
    const dot = fs.readFileSync(path.join(dir, "diagrams", "summary", "relationships.real.large.dot"), "utf8");
    const found = new Set([...dot.matchAll(/"(\w+)":"\w+":\w -> "(\w+)":"\w+":\w/g)].map((x) => `${x[1]}->${x[2]}`));
    const log = m.last.stdout + m.last.stderr;
    results.schemaspy = {
      version: /SchemaSpy ([\d.]+) with/.exec(log)?.[1], image: SCHEMASPY_IMAGE, input: "live database (JDBC)", output: "HTML site with PNG/SVG diagrams, no Mermaid",
      medianMs: Math.round(median(m.times)), ...score(found), filesWritten: Number(sh("sh", ["-c", `find ${dir} -type f | wc -l`]).stdout.trim()),
      impliedRelationships: impliedCount(path.join(dir, "anomalies.html")),
      logErrors: log.split("\n").filter((l) => /^(ERROR|WARN) /.test(l)).map((l) => l.slice(0, 90)),
      failed: m.failed,
    };
    // the committed-size cost: keep only the diagram source, not the 200+ file site
    fs.copyFileSync(path.join(dir, "diagrams", "summary", "relationships.real.large.dot"), path.join(outputs, "schemaspy-relationships.dot"));
  }
  // SchemaSpy implied-relationship probe: same relation, parent key named like the child column
  {
    sh("docker", ["exec", CONTAINER, "psql", "-U", "postgres", "-c", "create database probe"]);
    psqlFile("probe", "sample/implied-probe.sql");
    const dir = path.join(here, "results", "schemaspy-probe");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const r = run("docker", ["run", "--rm", "-v", `${dir}:/output`, SCHEMASPY_IMAGE, "-t", "pgsql", "-host", "host.docker.internal", "-port", String(PORT), "-db", "probe", "-u", "postgres", "-p", "postgres", "-s", "public"]);
    if (r.status !== 0) failures.push({ tool: "schemaspy-probe", status: r.status, stderr: r.stderr.slice(0, 500) });
    results.schemaspyImpliedProbe = { impliedRelationships: impliedCount(path.join(dir, "anomalies.html")) };
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // pglast, schema file, no database
  {
    const py = path.join(here, "tools", "pyenv", "bin", "python");
    for (const [key, extra] of [["pglast", []], ["pglastInfer", ["--infer"]]]) {
      const m = measure(key, py, [path.join(here, "pglast-mermaid.py"), path.join(here, "sample/schema.sql"), ...extra]);
      fs.writeFileSync(path.join(outputs, `${key}.mmd`), m.last.stdout);
      results[key] = {
        version: (sh("uv", ["pip", "show", "--python", py, "pglast"]).stdout.split("\n").find((l) => l.startsWith("Version")) ?? "").replace("Version: ", ""),
        input: "schema file, no database", output: "Mermaid from a script of our own", scriptLines: fs.readFileSync(path.join(here, "pglast-mermaid.py"), "utf8").split("\n").length - 1,
        medianMs: Math.round(median(m.times)), ...score(mermaidRelations(m.last.stdout)), failed: m.failed,
      };
    }
  }
  // hand-written Mermaid
  {
    const text = fs.readFileSync(path.join(here, "sample/handwritten.mmd"), "utf8");
    fs.copyFileSync(path.join(here, "sample/handwritten.mmd"), path.join(outputs, "handwritten.mmd"));
    results.handwritten = { input: "typed by hand", output: "Mermaid", ...score(mermaidRelations(text)), failed: false };
  }
} finally {
  sh("docker", ["rm", "-f", CONTAINER]);
}

results.meta = { node: process.version, reps, date: new Date().toISOString(), truth: { declared: DECLARED.length, undeclared: UNDECLARED.length }, failures };
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results, null, 2));
