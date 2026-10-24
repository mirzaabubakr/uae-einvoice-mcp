/**
 * Runs the official PINT AE Billing 1.0.4 Schematron (compiled XSLT published by OpenPeppol) with SaxonJS.
 *
 * The rules are not bundled: on first use they are downloaded from docs.peppol.eu (or read from
 * UAE_EINVOICE_PINT_AE_DIR, an unpacked resources.zip) and compiled once to SaxonJS SEF files in the cache.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import SaxonJS from "saxon-js";
import { extractZip } from "./zip.js";

export const PINT_AE_VERSION = "1.0.4";
export const PINT_AE_RESOURCES_URL = "https://docs.peppol.eu/poac/ae/pint-ae/resources.zip";

const RULESETS = ["PINT-UBL-validation-preprocessed", "PINT-jurisdiction-aligned-rules"] as const;
type Transaction = "trn-invoice" | "trn-creditnote";

export interface SchematronFinding {
  id: string;
  flag: string;
  ruleset: (typeof RULESETS)[number];
  location: string;
  message: string;
}

export interface SchematronResult {
  valid: boolean;
  rootElement: "Invoice" | "CreditNote" | null;
  customizationId: string | null;
  errors: SchematronFinding[];
  warnings: SchematronFinding[];
  rulesets: string[];
  durationMs: number;
  parseError?: string;
  source: string;
  note: string;
}

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

function cacheRoot(): string {
  if (process.env.UAE_EINVOICE_CACHE_DIR) return process.env.UAE_EINVOICE_CACHE_DIR;
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(base, "uae-einvoice-mcp", `pint-ae-${PINT_AE_VERSION}`);
}

async function downloadResources(target: string): Promise<void> {
  const res = await fetch(PINT_AE_RESOURCES_URL, { headers: { "user-agent": "uae-einvoice-mcp" } });
  if (!res.ok) throw new Error(`Download of ${PINT_AE_RESOURCES_URL} failed: HTTP ${res.status}`);
  const zip = Buffer.from(await res.arrayBuffer());
  for (const entry of extractZip(zip, (n) => /\/schematron\/[^/]+\.xslt$/.test(n))) {
    const out = join(target, entry.name);
    await mkdir(join(out, ".."), { recursive: true });
    await writeFile(out, entry.data);
  }
}

async function compileSef(xslt: string, sef: string): Promise<void> {
  const xslt3 = require.resolve("xslt3/xslt3.js");
  const tmp = `${sef}.${process.pid}.tmp`;
  await execFileAsync(process.execPath, [xslt3, `-xsl:${xslt}`, `-export:${tmp}`, "-nogo", "-relocate:on"], {
    maxBuffer: 16 * 1024 * 1024,
  });
  await rename(tmp, sef);
}

const prepared = new Map<Transaction, Promise<string[]>>();

/** Returns the SEF paths for a transaction, downloading and compiling on first use. */
function prepare(trn: Transaction): Promise<string[]> {
  let p = prepared.get(trn);
  if (!p) {
    p = (async () => {
      const root = cacheRoot();
      const local = process.env.UAE_EINVOICE_PINT_AE_DIR;
      const sourceDir = local ?? join(root, "resources");
      const xsltPath = (name: string) => join(sourceDir, trn, "schematron", `${name}.xslt`);
      if (!local && !RULESETS.every((n) => existsSync(xsltPath(n)))) {
        await downloadResources(sourceDir);
      }
      const sefDir = join(root, "sef", trn);
      await mkdir(sefDir, { recursive: true });
      const sefs: string[] = [];
      for (const name of RULESETS) {
        const sef = join(sefDir, `${name}.sef.json`);
        if (!existsSync(sef)) {
          if (!existsSync(xsltPath(name))) throw new Error(`Schematron XSLT not found: ${xsltPath(name)}`);
          await compileSef(xsltPath(name), sef);
        }
        sefs.push(sef);
      }
      return sefs;
    })();
    p.catch(() => prepared.delete(trn));
    prepared.set(trn, p);
  }
  return p;
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseSvrl(svrl: string, ruleset: SchematronFinding["ruleset"]): SchematronFinding[] {
  const out: SchematronFinding[] = [];
  const re = /<svrl:(failed-assert|successful-report)\b([^>]*)>([\s\S]*?)<\/svrl:\1>/g;
  for (const m of svrl.matchAll(re)) {
    const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(m[2])?.[1] ?? "";
    const text = /<svrl:text>([\s\S]*?)<\/svrl:text>/.exec(m[3])?.[1] ?? "";
    out.push({
      id: attr("id"),
      flag: attr("flag") || "fatal",
      ruleset,
      location: decode(attr("location")).replace(/\[namespace-uri\(\)='[^']*'\]/g, ""),
      message: decode(text).replace(/\s+/g, " ").trim(),
    });
  }
  return out;
}

function rootInfo(xml: string): { root: "Invoice" | "CreditNote" | null; customizationId: string | null } {
  const body = xml.replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->/g, "");
  const name = /<\s*(?:[\w-]+:)?([\w-]+)[\s>]/.exec(body)?.[1];
  const customizationId = /<(?:[\w-]+:)?CustomizationID[^>]*>([^<]*)</.exec(body)?.[1]?.trim() ?? null;
  return { root: name === "Invoice" || name === "CreditNote" ? name : null, customizationId };
}

export async function validatePintAeXml(xml: string): Promise<SchematronResult> {
  const started = Date.now();
  const { root, customizationId } = rootInfo(xml);
  const base = {
    rootElement: root,
    customizationId,
    rulesets: RULESETS.map((n) => `${n} (PINT AE ${PINT_AE_VERSION})`),
    source: PINT_AE_RESOURCES_URL,
    note: "Official PINT AE Schematron business rules. UBL 2.1 XSD schema validation, digital signatures and ASP-specific checks are not performed.",
  };
  if (!root) {
    return {
      ...base,
      valid: false,
      errors: [],
      warnings: [],
      durationMs: Date.now() - started,
      parseError: "Root element must be a UBL Invoice or CreditNote.",
    };
  }

  const sefs = await prepare(root === "CreditNote" ? "trn-creditnote" : "trn-invoice");
  const findings: SchematronFinding[] = [];
  for (const [i, sef] of sefs.entries()) {
    try {
      const out = SaxonJS.transform({ stylesheetFileName: sef, sourceText: xml, destination: "serialized" }, "sync");
      findings.push(...parseSvrl(out.principalResult, RULESETS[i]));
    } catch (err) {
      return {
        ...base,
        valid: false,
        errors: [],
        warnings: [],
        durationMs: Date.now() - started,
        parseError: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const errors = findings.filter((f) => f.flag === "fatal" || f.flag === "error");
  return {
    ...base,
    valid: errors.length === 0,
    errors,
    warnings: findings.filter((f) => !errors.includes(f)),
    durationMs: Date.now() - started,
  };
}

/** Pre-download and compile both transactions (used by the warm-up script and tests). */
export async function prepareSchematron(): Promise<void> {
  await prepare("trn-invoice");
  await prepare("trn-creditnote");
}

export async function readXmlInput(xml?: string, path?: string): Promise<string> {
  if (xml?.trim()) return xml;
  if (path) return readFile(path, "utf8");
  throw new Error("Provide xml (document text) or path (file path).");
}
