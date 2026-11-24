/**
 * Client for the E-Invoicing API. Works in Node 18+, Deno, Bun and browsers that are allowed
 * to hold the key (never ship a live key to a browser; use the widget sessions instead).
 *
 *   const einv = new EInvoicing({ apiKey: process.env.EINV_KEY! });
 *   const r = await einv.validate(xml);
 *   if (!r.valid) for (const f of r.findings) console.log(f.ruleId, f.explanation);
 *
 * Retries 429 and 5xx responses with backoff (honouring Retry-After); POST calls that change
 * data get an Idempotency-Key, so a retry is never billed twice.
 */
export type Lang = "en" | "de" | "fr" | "es" | "it" | "pl" | "nl" | "pt";
export type Document = string | Uint8Array | ArrayBuffer;

export interface Finding {
  severity: "error" | "warning" | "info";
  ruleId: string;
  message: string;
  messageTranslation?: string;
  explanation: string;
  suggestion: string;
  location?: { path: string; line?: number; column?: number };
  businessTerms: { id: string; name: string }[];
  source: { name: string; url: string };
  fields?: string[];
}
export interface Validation {
  id: string;
  object: "validation";
  status: "valid" | "invalid" | "unsupported";
  valid: boolean;
  invoiceId: string | null;
  stored: boolean;
  livemode: boolean;
  detected: { format?: string; syntax?: string; profile?: string; version?: string };
  summary: { errors: number; warnings: number; infos: number };
  findings: Finding[];
  ruleset?: { configuration: string; version: string };
}
export interface TestExpectation {
  status: "valid" | "invalid" | "unsupported";
  /** for invalid: the exact rule ids expected to fail (empty: any failure) */
  rules: string[];
}
/** { status, rules }, "valid" / "unsupported", rule ids expected to fail, or null (no expectation) */
export type ExpectationInput = TestExpectation | { status: "valid" | "unsupported" } | "valid" | "unsupported" | string[] | null;
export interface TestSetDocument {
  id: string;
  filename: string;
  mediaType: string;
  source: "upload" | "generated";
  generatedCase: string | null;
  expected: TestExpectation | null;
}
export interface TestSetSummary {
  id: string;
  name: string;
  description: string | null;
  documents: number;
  lastRun: { id: string; passed: boolean; createdAt: string } | null;
}
export interface TestSet extends Omit<TestSetSummary, "documents"> {
  documents: TestSetDocument[];
}
export interface TestSetRun {
  id: string;
  testSetId: string;
  testSetName: string;
  previousRunId: string | null;
  rules: string;
  compareRules: string | null;
  ruleset: string | null;
  passed: boolean;
  summary: {
    documents: number;
    passed: number;
    failed: number;
    noExpectation: number;
    errors: number;
    diff: { previousRunId: string | null; newFailures: number; fixed: number; changed: number; unchanged: number; newDocuments: number; removedDocuments: string[] };
    ruleSetChanges: number | null;
  };
  results: {
    documentId: string;
    filename: string;
    expected: TestExpectation | null;
    actual: { status: string; rules: string[]; warnings: string[]; findings: { severity: string; ruleId: string; message: string; line?: number }[]; error?: { code: string; message: string } };
    outcome: "passed" | "failed" | "no_expectation";
    missing: string[];
    unexpected: string[];
    diff: { change: "new_document" | "new_failures" | "fixed" | "changed" | "unchanged"; newFailures: string[]; fixed: string[]; previousStatus: string | null };
    compare?: { rules: string; status: string; failing: string[]; changed: boolean };
  }[];
  createdAt: string;
}

export interface Options {
  apiKey: string;
  /** default https://einvoiceengine.com */
  baseUrl?: string;
  /** language of explanations and suggestions */
  lang?: Lang;
  /** retries for 429 and 5xx (default 3) */
  retries?: number;
  fetch?: typeof fetch;
}

export class EInvoicingError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "EInvoicingError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isBinary = (d: Document) => typeof d !== "string";
const bytes = (d: Document): Uint8Array => (typeof d === "string" ? new TextEncoder().encode(d) : d instanceof Uint8Array ? d : new Uint8Array(d));
const isPdf = (d: Document) => {
  const b = bytes(d);
  return b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;
};
const b64 = (d: Document) => {
  const b = bytes(d);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const asJsonDoc = (d: Document) => (isBinary(d) || isPdf(d) ? { document: b64(d), encoding: "base64" } : { document: d as string, encoding: "utf8" });
const uuid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export class EInvoicing {
  private readonly base: string;
  private readonly f: typeof fetch;
  constructor(private readonly opts: Options) {
    if (!opts.apiKey) throw new Error("apiKey is required");
    this.base = (opts.baseUrl ?? "https://einvoiceengine.com").replace(/\/$/, "");
    this.f = opts.fetch ?? fetch;
  }

  /** Low-level request; returns parsed JSON (or text for non-JSON responses). */
  async request<T = unknown>(method: string, path: string, init: { query?: Record<string, string | number | boolean | undefined>; json?: unknown; body?: Document; contentType?: string; idempotent?: boolean } = {}): Promise<T> {
    const q = Object.entries(init.query ?? {}).filter(([, v]) => v !== undefined);
    const url = `${this.base}${path}${q.length ? `?${q.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&")}` : ""}`;
    const headers: Record<string, string> = { authorization: `Bearer ${this.opts.apiKey}`, "user-agent": "einv-sdk/0.1" };
    if (this.opts.lang) headers["accept-language"] = this.opts.lang;
    let body: BodyInit | undefined;
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.json);
    } else if (init.body !== undefined) {
      headers["content-type"] = init.contentType ?? (isPdf(init.body) ? "application/pdf" : "application/xml");
      body = bytes(init.body) as BodyInit;
    }
    if (init.idempotent) headers["idempotency-key"] = uuid();
    const retries = this.opts.retries ?? 3;
    for (let attempt = 0; ; attempt++) {
      const r = await this.f(url, { method, headers, body });
      if ((r.status === 429 || r.status >= 500) && attempt < retries) {
        const after = Number(r.headers.get("retry-after"));
        await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 2 ** attempt * 500);
        continue;
      }
      const type = r.headers.get("content-type") ?? "";
      const data = type.includes("json") ? await r.json() : await r.text();
      if (!r.ok) {
        const e = (data as { error?: { code: string; message: string; details?: unknown; requestId?: string } }).error;
        throw new EInvoicingError(r.status, e?.code ?? "http_error", e?.message ?? `HTTP ${r.status}`, e?.details, e?.requestId);
      }
      return data as T;
    }
  }

  /** Validate with the official rules of the detected format. */
  validate(doc: Document, o: { store?: boolean; rules?: string } = {}) {
    return this.request<Validation>("POST", "/v1/invoices/validate", { body: doc, query: { store: o.store ?? false, rules: o.rules }, idempotent: true });
  }
  /** Parse into the EN 16931 JSON model. */
  parse(doc: Document, o: { store?: boolean } = {}) {
    return this.request<{ invoice: Record<string, unknown>; detected: Validation["detected"]; warnings: unknown[] }>("POST", "/v1/invoices/parse", { body: doc, query: { store: o.store ?? false }, idempotent: true });
  }
  /** Convert, e.g. target "cii", "ubl", "peppol-bis-billing", "zugferd-facturx" (document returned base64 for PDF). */
  convert(doc: Document, target: string, o: { allowDataLoss?: boolean; store?: boolean } = {}) {
    return this.request<{ document: string; target: { format: string; mediaType: string; encoding?: "base64" }; validation: Validation; dataLoss?: unknown }>("POST", "/v1/invoices/convert", {
      body: doc,
      query: { target, allowDataLoss: o.allowDataLoss, store: o.store ?? false },
      idempotent: true,
    });
  }
  /** Create an invoice from canonical JSON. */
  generate(invoice: Record<string, unknown>, target: string, o: { profile?: string; store?: boolean } = {}) {
    return this.request<{ document: string; target: { format: string; mediaType: string; encoding?: "base64" }; validation: Validation }>("POST", "/v1/invoices/generate", {
      json: { invoice, target, profile: o.profile },
      query: { store: o.store ?? false },
      idempotent: true,
    });
  }
  /** Business-level comparison (not billed). */
  compare(a: Document, b: Document) {
    return this.request<{ equal: boolean; differences: { path: string; kind: string; a?: unknown; b?: unknown; sensitive: boolean }[] }>("POST", "/v1/invoices/compare", { json: { a: asJsonDoc(a), b: asJsonDoc(b) } });
  }
  /** Repair proposals for a rejected invoice (not billed). */
  analyze(doc: Document, rejectionMessage?: string) {
    return this.request<{ proposals: { id: string; ruleId: string; field: string; current: unknown; proposed?: unknown; category: string; confidence: string; explanation: string }[]; fixable: boolean }>(
      "POST",
      "/v1/invoices/fix/analyze",
      { json: { ...asJsonDoc(doc), message: rejectionMessage } },
    );
  }
  /** Apply changes or accepted proposals; amounts and tax only with confirmAmounts after a person confirmed them. */
  fix(doc: Document, o: { changes?: { field: string; value: unknown }[]; accept?: string[]; applySafe?: boolean; confirmAmounts?: boolean; store?: boolean }) {
    return this.request<{ document: string; validation: Validation; applied: unknown[] }>("POST", "/v1/invoices/fix", {
      json: { ...asJsonDoc(doc), changes: o.changes, accept: o.accept, applySafe: o.applySafe, confirmAmounts: o.confirmAmounts },
      query: { store: o.store ?? false },
      idempotent: true,
    });
  }
  /** Synthetic test invoices (not billed). */
  testdata(target: string, cases?: string[]) {
    return this.request<{ cases: { name: string; filename: string; encoding: "utf8" | "base64"; document: string; expected: { status: string; rules: string[] }; actual: { status: string; rules: string[] }; matches: boolean }[] }>(
      "POST",
      "/v1/testdata",
      { json: { target, cases } },
    );
  }
  explainRule(ruleId: string) {
    return this.request<{ ruleId: string; explanation: string; suggestion: string }>("GET", `/v1/rules/${encodeURIComponent(ruleId)}`);
  }
  formats() {
    return this.request<{ data: { id: string; name: string; support: string }[] }>("GET", "/v1/formats");
  }
  usage() {
    return this.request<Record<string, unknown>>("GET", "/v1/usage");
  }
  monitoring(days = 30) {
    return this.request<Record<string, unknown>>("GET", "/v1/monitoring", { query: { days } });
  }
  invoice(id: string) {
    return this.request<Record<string, unknown>>("GET", `/v1/invoices/${encodeURIComponent(id)}`);
  }
  evidence(invoiceId: string) {
    return this.request<Record<string, unknown>>("GET", `/v1/invoices/${encodeURIComponent(invoiceId)}/evidence`);
  }
  /** Session for the embedded widget; call on your server and pass only `url` to the browser. */
  widgetSession(o: { origin: string; maxDocuments?: number; ttlMinutes?: number; lang?: Lang; accent?: string; theme?: "light" | "dark" | "auto" }) {
    return this.request<{ url: string; token: string; expiresAt: string }>("POST", "/v1/widget/sessions", { json: o });
  }
  /**
   * Stored test sets for regression testing (scope `validate`; a CI key works). A run checks every
   * document against its expected result and against the previous run; it is billed like validating
   * the documents one by one with the same key.
   */
  readonly testSets = {
    list: () => this.request<{ data: TestSetSummary[] }>("GET", "/v1/test-sets"),
    create: (s: { name: string; description?: string }) => this.request<TestSet>("POST", "/v1/test-sets", { json: s }),
    get: (id: string) => this.request<TestSet>("GET", `/v1/test-sets/${encodeURIComponent(id)}`),
    delete: (id: string) => this.request<void>("DELETE", `/v1/test-sets/${encodeURIComponent(id)}`),
    /** Upload documents; `expected` is "valid", an array of rule ids expected to fail, or { status, rules }. */
    addDocuments: (id: string, docs: { filename: string; document: Document; expected?: ExpectationInput }[]) =>
      this.request<{ added: number; documentIds: string[]; set: TestSet }>("POST", `/v1/test-sets/${encodeURIComponent(id)}/documents`, {
        json: { documents: docs.map((d) => ({ filename: d.filename, expected: d.expected, ...asJsonDoc(d.document) })) },
      }),
    /** Add synthetic invoices from the test-data generator; their expectation is the official result at generation. */
    generate: (id: string, target: string, cases?: string[]) =>
      this.request<{ added: number; documentIds: string[]; set: TestSet }>("POST", `/v1/test-sets/${encodeURIComponent(id)}/documents`, { json: { generate: { target, cases } } }),
    removeDocument: (id: string, documentId: string) => this.request<void>("DELETE", `/v1/test-sets/${encodeURIComponent(id)}/documents/${encodeURIComponent(documentId)}`),
    setExpectation: (id: string, documentId: string, expected: ExpectationInput) =>
      this.request<TestSetDocument>("PATCH", `/v1/test-sets/${encodeURIComponent(id)}/documents/${encodeURIComponent(documentId)}`, { json: { expected } }),
    /** Take the expectations from a run's results (default: the latest run). */
    acceptResults: (id: string, o: { runId?: string; documentIds?: string[] } = {}) =>
      this.request<{ updated: number; runId: string; set: TestSet }>("POST", `/v1/test-sets/${encodeURIComponent(id)}/expectations/accept`, { json: o }),
    run: (id: string, o: { rules?: string; compareRules?: string } = {}) => this.request<TestSetRun>("POST", `/v1/test-sets/${encodeURIComponent(id)}/runs`, { json: o, idempotent: true }),
    runs: (id: string, limit = 20) => this.request<{ data: Omit<TestSetRun, "results" | "testSetName">[] }>("GET", `/v1/test-sets/${encodeURIComponent(id)}/runs`, { query: { limit } }),
    getRun: (id: string, runId: string) => this.request<TestSetRun>("GET", `/v1/test-sets/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`),
    /** Markdown summary of a run (for CI job summaries and pull-request comments). */
    runMarkdown: (id: string, runId: string) => this.request<string>("GET", `/v1/test-sets/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`, { query: { format: "markdown" } }),
  };

  /** Partner API (key with the `partner` scope). */
  readonly partner = {
    createCustomer: (c: { name: string; externalRef?: string; monthlyDocumentLimit?: number | null }) => this.request<{ id: string }>("POST", "/v1/partner/customers", { json: c }),
    customers: () => this.request<{ data: unknown[] }>("GET", "/v1/partner/customers"),
    createCustomerKey: (id: string, k: { name?: string; livemode?: boolean; scopes?: string[] } = {}) => this.request<{ secret: string }>("POST", `/v1/partner/customers/${encodeURIComponent(id)}/keys`, { json: k }),
    usage: (period?: string) => this.request<{ data: unknown[] }>("GET", "/v1/partner/usage", { query: { period } }),
  };
}
