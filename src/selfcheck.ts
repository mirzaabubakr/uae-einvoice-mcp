import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPintAeFields } from "./lib/checklist.js";
import { checkInvoiceCompliance } from "./lib/compliance.js";
import { getEinvoicingRequirements } from "./lib/requirements.js";
import { computeTinCheckDigit, makeSampleTin, validateTaxId } from "./lib/trn.js";
import { generatePintAeXml } from "./lib/xml.js";
import { PINT_AE_FIELDS } from "./lib/fields.js";

const sampleTin = makeSampleTin("23456789");
assert.equal(sampleTin.length, 10);
assert.equal(sampleTin[0], "1");
assert.equal(Number(sampleTin[9]), computeTinCheckDigit(sampleTin.slice(0, 9)));
assert.equal(validateTaxId(sampleTin).valid, true);
assert.equal(validateTaxId(`${sampleTin}12345`).valid, true);
assert.equal(validateTaxId("1234567890").valid, false);

assert.equal(PINT_AE_FIELDS.length, 51);

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(__dirname, "../examples/compliant-invoice.json"), "utf8"),
).invoiceData;

const good = checkInvoiceCompliance(fixture);
assert.equal(good.compliant, true, JSON.stringify(good.findings, null, 2));

const checklist = checkPintAeFields(fixture);
assert.equal(checklist.totalFields, 51);
assert.ok(checklist.completionPercent >= 90, JSON.stringify(checklist.gaps, null, 2));
assert.equal(checklist.complete, true, JSON.stringify(checklist.gaps, null, 2));

const xml = generatePintAeXml(fixture);
assert.equal(xml.generated, true);
assert.ok(xml.xml?.includes("CustomizationID"));
assert.ok(xml.xml?.includes("AccountingSupplierParty"));
assert.ok(xml.xml?.includes("<cbc:ID>INV-1001</cbc:ID>"));

const strictFail = generatePintAeXml({ documentType: "tax_invoice" }, { strict: true });
assert.equal(strictFail.generated, false);

const bad = checkInvoiceCompliance({ documentType: "tax_invoice" });
assert.equal(bad.compliant, false);
assert.ok(bad.findings.some((f) => f.severity === "error"));

const reqs = getEinvoicingRequirements("all", 60_000_000);
assert.equal(reqs.segment, "large");
assert.ok(reqs.phases.length === 1);

console.log("All self-checks passed.");
console.log("Sample TIN:", sampleTin);
console.log("Compliance score:", good.score);
console.log("Checklist completion %:", checklist.completionPercent);
console.log("XML bytes:", xml.xml?.length);
