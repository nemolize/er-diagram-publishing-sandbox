// Runs every ER-diagram tool against sample/schema.sql and writes results/summary.json and results/outputs/.
// Usage: node run.mjs [--reps 5] [--minidle 0.75] [--out results/summary.json]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? dflt : process.argv[i + 1]; };
const reps = Number(arg("reps", "5"));
const minIdle = Number(arg("minidle", "0.75"));
const outFile = path.resolve(here, arg("out", "results/summary.json"));
if (fs.existsSync(outFile)) { console.error(`refusing to overwrite ${outFile}`); process.exit(1); }

const pinned = fs.readFileSync(path.join(here, ".node-version"), "utf8").trim();
if (process.version !== `v${pinned}`) { console.error(`Node ${process.version} is not the pinned v${pinned}`); process.exit(1); }

const PG_IMAGE = "postgres@sha256:1018733457011bf88d81db98cf43aac6d5150afc18787dbe204771fedf80ff95"; // postgres:18-alpine
const SCHEMASPY_IMAGE = "schemaspy/schemaspy@sha256:c8f98116a5cfe4b00b379eeb23b2022cdea4c9192cbccb843a75049e752479b7";
const CONTAINER = "er-diagram-bench-pg";
const PORT = 55434;
const DSN = `postgres://postgres:postgres@127.0.0.1:${PORT}/shop?sslmode=disable`;

const DECLARED = ["order_items->orders", "order_items->products", "payments->orders"];
const UNDECLARED = [
  "addresses->users", "categories->categories", "products->categories", "product_images->products",
  "orders->users", "orders->addresses", "orders->coupons", "shipments->orders",
  "reviews->products", "reviews->users", "carts->users",
];

const PROBES = {
  idKeyedChild: "CREATE TABLE customers (customer_id bigserial PRIMARY KEY); CREATE TABLE invoices (id bigserial PRIMARY KEY, customer_id bigint NOT NULL);",
  namedKeyedChild: "CREATE TABLE customers (customer_id bigserial PRIMARY KEY); CREATE TABLE invoices (invoice_id bigserial PRIMARY KEY, customer_id bigint NOT NULL);",
  idKeyedParent: "CREATE TABLE customers (id bigserial PRIMARY KEY); CREATE TABLE invoices (invoice_id bigserial PRIMARY KEY, customer_id bigint NOT NULL);",
};

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", cwd: here, ...opts });
const run = (cmd, args, opts) => {
  const t0 = performance.now();
  const r = sh(cmd, args, opts);
  return { ms: performance.now() - t0, status: r.status, stdout: r.stdout, stderr: r.stderr };
};
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const firstLine = (s) => s.trim().split("\n")[0];
const medianMs = (m) => (m.times.length ? Math.round(median(m.times)) : null);

const cpuTimes = () => os.cpus().reduce((a, c) => ({ idle: a.idle + c.times.idle, all: a.all + Object.values(c.times).reduce((x, y) => x + y, 0) }), { idle: 0, all: 0 });
async function waitQuiet() {
  for (let i = 0; i < 120; i++) {
    const a = cpuTimes();
    await new Promise((r) => setTimeout(r, 1000));
    const b = cpuTimes();
    const idle = (b.idle - a.idle) / (b.all - a.all);
    if (idle >= minIdle) return Number(idle.toFixed(3));
  }
  throw new Error(`the machine never reached ${minIdle} idle in 120 s; close other apps and rerun`);
}

const mermaidBlock = (text) => /```mermaid\n([\s\S]*?)```/.exec(text)?.[1] ?? text;
function mermaidRelations(text) {
  const rel = new Set();
  const strip = (s) => s.replace(/^"?(?:public\.)?/, "").replace(/"?$/, "");
  for (const line of text.split("\n")) {
    const m = /^\s*"?([\w.]+)"?\s+([|}o]{1,2}[-.]{2}[|{o]{1,2})\s+"?([\w.]+)"?\s*:/.exec(line);
    if (!m) continue;
    const [, left, , right] = m;
    // tbls writes "child }o--|| parent"; the others write "parent ||--o{ child".
    const childFirst = m[2].startsWith("}");
    rel.add(childFirst ? `${strip(left)}->${strip(right)}` : `${strip(right)}->${strip(left)}`);
  }
  return rel;
}
const dotEdges = (file) => (fs.existsSync(file) ? [...fs.readFileSync(file, "utf8").matchAll(/"(\w+)":"\w+":\w -> "(\w+)":"\w+":\w/g)].map((x) => `${x[1]}->${x[2]}`) : []);
const score = (found) => ({
  declaredDrawn: DECLARED.filter((r) => found.has(r)).length,
  undeclaredDrawn: UNDECLARED.filter((r) => found.has(r)).length,
  extra: [...found].filter((r) => !DECLARED.includes(r) && !UNDECLARED.includes(r)),
});

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
const psql = (db, sql) => sh("docker", ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q"], { input: sql });
function createDb(db, sql) {
  for (const r of [sh("docker", ["exec", CONTAINER, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-qc", `create database ${db}`]), psql(db, sql)]) {
    if (r.status !== 0) throw new Error(`database ${db} was not set up: ${r.stderr}`);
  }
}

async function measure(name, command, args, opts = {}) {
  const times = [];
  const idleBefore = [];
  let last;
  for (let i = 0; i < reps; i++) {
    opts.before?.();
    idleBefore.push(await waitQuiet());
    last = run(command, args, opts.spawn);
    if (last.status !== 0) {
      failures.push({ tool: name, status: last.status, stderr: last.stderr.slice(0, 500) });
      return { times, idleBefore, last, failed: true };
    }
    times.push(last.ms);
  }
  return { times, idleBefore, last, failed: false };
}
const timing = (m) => ({ medianMs: medianMs(m), idleBefore: m.idleBefore, failed: m.failed });

const spyArgs = (dir, db) => ["run", "--rm", "-v", `${dir}:/output`, SCHEMASPY_IMAGE, "-t", "pgsql", "-host", "host.docker.internal", "-port", String(PORT), "-db", db, "-u", "postgres", "-p", "postgres", "-s", "public"];
const impliedEdges = (dir) => dotEdges(path.join(dir, "diagrams", "summary", "relationships.implied.large.dot"));
const dirBytes = (dir) => Number(sh("sh", ["-c", `du -sk ${dir} | cut -f1`]).stdout.trim()) * 1024;
const fileCount = (dir) => Number(sh("sh", ["-c", `find ${dir} -type f | wc -l`]).stdout.trim());

try {
  startDb();
  const shop = fs.readFileSync(path.join(here, "sample/schema.sql"), "utf8");
  const applied = psql("shop", shop);
  if (applied.status !== 0) throw new Error(`schema did not apply: ${applied.stderr}`);
  results.postgres = { image: PG_IMAGE, version: firstLine(sh("docker", ["exec", CONTAINER, "psql", "-U", "postgres", "-Atc", "select version()"]).stdout) };

  const tblsDir = path.join(here, "results", "tbls");
  const tblsVersion = firstLine(sh("tbls", ["version"]).stdout);
  for (const [key, label, args, dir, input] of [
    ["tbls", "tbls", ["doc", DSN, tblsDir, "--force", "--er-format", "mermaid"], tblsDir, "live database"],
    ["tblsRelations", "tbls-relations", ["doc", "-c", "tbls-relations.yml", "--force"], path.join(here, "results", "tbls-relations"), "live database + 11 relations written in .tbls.yml"],
  ]) {
    const m = await measure(label, "tbls", args);
    results[key] = { version: tblsVersion, input, output: "Markdown with a Mermaid block (also SVG/PNG with --er-format)", ...timing(m) };
    if (m.failed) continue;
    const text = fs.readFileSync(path.join(dir, "README.md"), "utf8");
    fs.writeFileSync(path.join(outputs, `${label}.mmd`), mermaidBlock(text));
    Object.assign(results[key], score(mermaidRelations(mermaidBlock(text))), { filesWritten: fileCount(dir) });
  }
  {
    const out = path.join(here, "results", "pg-mermaid-database.md");
    const bin = path.join(here, "tools", "node_modules", ".bin", "pg-mermaid");
    const m = await measure("pg-mermaid", bin, ["-d", "shop", "-U", "postgres", "-h", "127.0.0.1", "-p", String(PORT), "--output-path", out], { spawn: { env: { ...process.env, PGPASSWORD: "postgres" } } });
    const pkg = JSON.parse(fs.readFileSync(path.join(here, "tools", "node_modules", "pg-mermaid", "package.json"), "utf8"));
    results.pgMermaid = { version: pkg.version, input: "live database", output: "Markdown with a Mermaid block", ...timing(m) };
    if (!m.failed) {
      const text = fs.readFileSync(out, "utf8");
      fs.writeFileSync(path.join(outputs, "pg-mermaid.mmd"), mermaidBlock(text));
      fs.rmSync(out);
      Object.assign(results.pgMermaid, score(mermaidRelations(mermaidBlock(text))));
    }
  }
  {
    const dir = path.join(here, "results", "schemaspy");
    const m = await measure("schemaspy", "docker", spyArgs(dir, "shop"), { before: () => { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); } });
    results.schemaspy = { image: SCHEMASPY_IMAGE, input: "live database (JDBC)", output: "HTML site with PNG/SVG diagrams, no Mermaid", ...timing(m) };
    if (!m.failed) {
      const log = m.last.stdout + m.last.stderr;
      fs.writeFileSync(path.join(outputs, "schemaspy.log"), log);
      const found = new Set([...dotEdges(path.join(dir, "diagrams", "summary", "relationships.real.large.dot")), ...impliedEdges(dir)]);
      Object.assign(results.schemaspy, score(found), {
        version: /SchemaSpy ([\d.]+) with/.exec(log)?.[1], filesWritten: fileCount(dir), bytesWritten: dirBytes(dir),
        impliedEdges: impliedEdges(dir).length, logProblems: log.split("\n").filter((l) => /\b(ERROR|WARN)\b +-/.test(l)).map((l) => l.slice(0, 110)),
      });
      fs.copyFileSync(path.join(dir, "diagrams", "summary", "relationships.real.large.dot"), path.join(outputs, "schemaspy-relationships.dot"));
    }
  }
  results.schemaspyImplied = {};
  const variants = { ...Object.fromEntries(Object.entries(PROBES).map(([k, sql]) => [k, sql])), keyedSample: fs.readFileSync(path.join(here, "sample/schema-keyed.sql"), "utf8") };
  for (const [name, sql] of Object.entries(variants)) {
    const db = name.toLowerCase();
    createDb(db, sql);
    const dir = path.join(here, "results", `schemaspy-${db}`);
    fs.mkdirSync(dir, { recursive: true });
    const r = run("docker", spyArgs(dir, db));
    if (r.status !== 0) { failures.push({ tool: `schemaspy-${name}`, status: r.status, stderr: r.stderr.slice(0, 500) }); results.schemaspyImplied[name] = { failed: true }; continue; }
    const edges = impliedEdges(dir);
    results.schemaspyImplied[name] = name === "keyedSample" ? { edges: edges.length, ...score(new Set(edges)) } : { edges };
    if (name === "keyedSample") fs.writeFileSync(path.join(outputs, "schemaspy-keyed-implied.txt"), edges.join("\n") + "\n");
  }
  {
    const py = path.join(here, "tools", "pyenv", "bin", "python");
    const pglastVersion = (sh("uv", ["pip", "show", "--python", py, "pglast"]).stdout.split("\n").find((l) => l.startsWith("Version")) ?? "").replace("Version: ", "");
    for (const [key, extra] of [["pglast", []], ["pglastInfer", ["--infer"]]]) {
      const m = await measure(key, py, [path.join(here, "pglast-mermaid.py"), path.join(here, "sample/schema.sql"), ...extra]);
      results[key] = { version: pglastVersion, input: "schema file, no database", output: "Mermaid from a script of our own", scriptLines: fs.readFileSync(path.join(here, "pglast-mermaid.py"), "utf8").split("\n").length - 1, ...timing(m) };
      if (m.failed) continue;
      fs.writeFileSync(path.join(outputs, `${key}.mmd`), m.last.stdout);
      Object.assign(results[key], score(mermaidRelations(m.last.stdout)));
    }
  }
  {
    const text = fs.readFileSync(path.join(here, "sample/handwritten.mmd"), "utf8");
    fs.copyFileSync(path.join(here, "sample/handwritten.mmd"), path.join(outputs, "handwritten.mmd"));
    results.handwritten = { input: "typed by hand", output: "Mermaid", ...score(mermaidRelations(text)), failed: false };
  }
} finally {
  sh("docker", ["rm", "-f", CONTAINER]);
}

results.meta = {
  node: process.version, reps, minIdle, date: new Date().toISOString(), truth: { declared: DECLARED.length, undeclared: UNDECLARED.length }, failures,
  env: {
    os: `${os.type()} ${os.release()} ${os.arch()}`, macos: firstLine(sh("sw_vers", ["-productVersion"]).stdout), cpu: os.cpus()[0].model, cores: os.cpus().length, memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    docker: firstLine(sh("docker", ["version", "--format", "{{.Server.Version}}"]).stdout), python: firstLine(sh(path.join(here, "tools", "pyenv", "bin", "python"), ["--version"]).stdout),
  },
};
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results, null, 2));
