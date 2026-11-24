# @einvoiceengine/sdk

TypeScript client without dependencies (Node 18+, Deno, Bun) and the `einv` command-line tool for the [E-Invoicing API](https://einvoiceengine.com): validate XRechnung, EN 16931, Peppol BIS, ZUGFeRD / Factur-X, Facturae and KSeF FA(3) invoices with their official rule sets, read them as JSON, convert and create them.

```sh
npm install @einvoiceengine/sdk
```

You need an API key: create a free test key at https://einvoiceengine.com/dashboard/keys.


## Client

```ts
import { EInvoicing, EInvoicingError } from "@einvoiceengine/sdk";

const einv = new EInvoicing({ apiKey: process.env.EINV_KEY!, lang: "de" });

const r = await einv.validate(xml);                 // string, Uint8Array or ArrayBuffer; PDFs are detected
if (!r.valid) for (const f of r.findings) console.log(f.ruleId, f.explanation, f.suggestion);

const cii = await einv.convert(xml, "cii");
const diff = await einv.compare(xml, cii.document);  // business-level, not billed
const proposals = await einv.analyze(rejected, "Abgelehnt: BR-DE-15");
const set = await einv.testdata("xrechnung-ubl");    // synthetic test invoices
const run = await einv.testSets.run(setId);            // stored test set: expectations + diff to the previous run
const session = await einv.widgetSession({ origin: "https://app.example.com" });
```

Every method maps to one endpoint of the [API](https://einvoiceengine.com/openapi.json). Errors are thrown as `EInvoicingError` with `status`, `code`, `message`, `details` and `requestId`. Responses with 429 or 5xx are retried with backoff (honouring `Retry-After`, 3 retries by default); calls that create something carry an `Idempotency-Key`, so a retry is never billed twice. `lang` sets the language of explanations and suggestions.

## Command line

```sh
export EINV_KEY=einv_test_…
einv validate invoice.xml other.pdf --lang de
einv convert invoice.xml --to zugferd-facturx --out invoice.pdf
einv compare erp-export.xml received.xml
einv explain BR-CO-16
einv testdata --target xrechnung-cii --out fixtures      # synthetic invoices + expected.json
einv ci out/invoices --rules 2026-11 --baseline einv-baseline.json
einv ci --test-set <id> --rules 2026-11                     # run a test set stored in your account
einv formats
```

Exit codes: `0` everything passed, `1` an invoice failed or two invoices differ, `2` usage or API error. `einv ci` works like [`einv-ci.mjs`](https://einvoiceengine.com/docs/ci): with `--update-baseline` it records today's results, afterwards only new failures fail the build.

Documentation: https://einvoiceengine.com/docs/sdk · License: MIT
