#!/usr/bin/env node
/**
 * einv — command-line tool for the E-Invoicing API.
 *
 *   einv validate <file…> [--rules 2026-11] [--lang de] [--json]
 *   einv convert <file> --to cii|ubl|peppol-bis-billing|zugferd-facturx [--out file]
 *   einv compare <a> <b>
 *   einv explain <rule-id>
 *   einv testdata --target xrechnung-ubl [--case name…] [--out dir]
 *   einv ci <folder> [--rules 2026-11] [--baseline file] [--update-baseline]
 *   einv ci --test-set <id> [--rules 2026-11] [--compare-rules latest]
 *   einv formats
 *
 * Environment: EINV_KEY (required), EINV_BASE (default https://einvoiceengine.com).
 * Exit codes: 0 ok, 1 an invoice failed / differs, 2 usage or API error.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { EInvoicing, EInvoicingError, type Lang, type Validation } from "./index.js";

const argv = process.argv.slice(2);
const cmd = argv[0];
const positional: string[] = [];
const flags: Record<string, string[]> = {};
for (let i = 1; i < argv.length; i++) {
  const a = argv[i]!;
  if (a.startsWith("--")) {
    const name = a.slice(2);
    const next = argv[i + 1];
    const value = next !== undefined && !next.startsWith("--") && !["json", "update-baseline", "allow-data-loss"].includes(name) ? (i++, next) : "true";
    (flags[name] ??= []).push(value);
  } else positional.push(a);
}
const flag = (n: string) => flags[n]?.[0];

function usage(msg?: string): never {
  if (msg) console.error(msg);
  console.error(readFileSync(new URL(import.meta.url)).toString().split("\n").slice(2, 16).map((l) => l.replace(/^ \* ?/, "")).join("\n"));
  process.exit(2);
}

const key = process.env.EINV_KEY;
if (!cmd || cmd === "help" || cmd === "--help") usage();
if (!key) usage("EINV_KEY is not set (a test key from the dashboard is enough).");
const client = new EInvoicing({ apiKey: key, baseUrl: process.env.EINV_BASE, lang: flag("lang") as Lang | undefined });

const files = (dir: string): string[] =>
  readdirSync(dir)
    .flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.(xml|pdf)$/i.test(f) ? [p] : [];
    })
    .sort();
const errorsOf = (v: Validation) => [...new Set(v.findings.filter((f) => f.severity === "error").map((f) => f.ruleId + (f.location?.line ? `@${f.location.line}` : "")))];

async function main(): Promise<number> {
  switch (cmd) {
    case "validate": {
      if (!positional.length) usage("einv validate <file…>");
      let failed = 0;
      for (const f of positional) {
        const v = await client.validate(readFileSync(f), { rules: flag("rules") });
        if (v.status !== "valid") failed++;
        if (flag("json")) console.log(JSON.stringify({ file: f, ...v }, null, 2));
        else {
          console.log(`${v.status === "valid" ? "OK  " : "FAIL"} ${v.status} ${v.detected.profile ?? v.detected.format ?? ""}  ${f}`);
          for (const x of v.findings.filter((x) => x.severity !== "info")) console.log(`     ${x.ruleId}${x.location?.line ? ` (line ${x.location.line})` : ""}: ${x.explanation}\n       → ${x.suggestion}`);
        }
      }
      return failed ? 1 : 0;
    }
    case "convert": {
      const [file] = positional;
      const to = flag("to");
      if (!file || !to) usage("einv convert <file> --to <target>");
      const r = await client.convert(readFileSync(file), to, { allowDataLoss: flag("allow-data-loss") === "true" });
      const out = flag("out") ?? `${basename(file).replace(/\.\w+$/, "")}-${to}.${r.target.encoding === "base64" ? "pdf" : "xml"}`;
      writeFileSync(out, r.target.encoding === "base64" ? Buffer.from(r.document, "base64") : r.document);
      console.log(`${r.validation.status} ${r.target.format} → ${out}`);
      return r.validation.status === "valid" ? 0 : 1;
    }
    case "compare": {
      const [a, b] = positional;
      if (!a || !b) usage("einv compare <a> <b>");
      const r = await client.compare(readFileSync(a), readFileSync(b));
      if (r.equal) console.log("equal: no business difference");
      for (const d of r.differences) console.log(`${d.kind.padEnd(8)} ${d.path}${d.sensitive ? " [amount/tax/party]" : ""}: ${JSON.stringify(d.a)} → ${JSON.stringify(d.b)}`);
      return r.equal ? 0 : 1;
    }
    case "explain": {
      const [id] = positional;
      if (!id) usage("einv explain <rule-id>");
      const r = await client.explainRule(id);
      console.log(`${r.ruleId}\n${r.explanation}\n→ ${r.suggestion}`);
      return 0;
    }
    case "formats": {
      for (const f of (await client.formats()).data) console.log(`${f.id.padEnd(22)} ${f.support.padEnd(10)} ${f.name}`);
      return 0;
    }
    case "testdata": {
      const target = flag("target") ?? "xrechnung-ubl";
      const out = flag("out") ?? "einv-testdata";
      const set = await client.testdata(target, flags.case);
      mkdirSync(out, { recursive: true });
      for (const c of set.cases) writeFileSync(join(out, c.filename), c.encoding === "base64" ? Buffer.from(c.document, "base64") : c.document);
      writeFileSync(join(out, "expected.json"), JSON.stringify(Object.fromEntries(set.cases.map((c) => [c.filename, c.expected])), null, 2) + "\n");
      console.log(`${set.cases.length} synthetic ${target} invoices in ${out}/ (expected results in expected.json)`);
      return set.cases.every((c) => c.matches) ? 0 : 1;
    }
    case "ci": {
      const setId = flag("test-set");
      if (setId) {
        // a test set stored in the account: expectations and run history live on the server
        const r = await client.testSets.run(setId, { rules: flag("rules"), compareRules: flag("compare-rules") });
        for (const d of r.results)
          console.log(`${d.outcome === "failed" ? "FAIL" : d.outcome === "passed" ? "OK  " : "NEW "} ${d.actual.status}${d.actual.rules.length ? ` ${d.actual.rules.join(",")}` : ""}  ${d.filename}${d.diff.change !== "unchanged" ? `  (${d.diff.change.replace(/_/g, " ")})` : ""}`);
        console.log(`${r.summary.documents} documents, ${r.summary.passed} passed, ${r.summary.failed} failed`);
        return r.passed ? 0 : 1;
      }
      const [dir] = positional;
      if (!dir || !existsSync(dir)) usage("einv ci <folder> [--rules v] [--baseline file] [--update-baseline]");
      const baselineFile = flag("baseline");
      const results: Record<string, { status: string; errors: string[] }> = {};
      for (const f of files(dir)) {
        const v = await client.validate(readFileSync(f), { rules: flag("rules") });
        results[relative(dir, f)] = { status: v.status, errors: errorsOf(v) };
      }
      if (flag("update-baseline") && baselineFile) {
        writeFileSync(baselineFile, JSON.stringify({ results }, null, 2) + "\n");
        console.log(`baseline written: ${baselineFile}`);
        return 0;
      }
      const base: Record<string, { status: string; errors: string[] }> | undefined = baselineFile && existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, "utf8")).results : undefined;
      let fresh = 0;
      for (const [f, r] of Object.entries(results)) {
        const was = base?.[f];
        const ids = (x: { errors: string[] }) => new Set(x.errors.map((e) => e.split("@")[0]));
        const isNew = r.status !== "valid" && (!base || !was || was.status === "valid" || [...ids(r)].some((i) => !ids(was).has(i)));
        if (isNew) fresh++;
        console.log(`${r.status === "valid" ? "OK  " : isNew ? "FAIL" : "KNOWN"} ${r.status}${r.errors.length ? ` ${r.errors.join(",")}` : ""}  ${f}`);
      }
      console.log(`${Object.keys(results).length} checked, ${fresh} ${base ? "new " : ""}failures`);
      return fresh ? 1 : 0;
    }
    default:
      usage(`unknown command: ${cmd}`);
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof EInvoicingError ? `error ${e.status} ${e.code}: ${e.message}` : String(e));
    process.exit(2);
  },
);
