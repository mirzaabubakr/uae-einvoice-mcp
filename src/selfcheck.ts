import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPintAeFields } from "./lib/checklist.js";
import { checkInvoiceCompliance } from "./lib/compliance.js";
import { COMMERCIAL_INVOICE_FIELDS, TAX_INVOICE_FIELDS } from "./lib/fields.js";
import { getEinvoicingRequirements } from "./lib/requirements.js";
import { computeTinCheckDigit, makeSampleTin, makeSampleTrn, validateTaxId } from "./lib/trn.js";
import { generatePintAeXml } from "./lib/xml.js";

const sampleTin = makeSampleTin("23456789");
assert.equal(sampleTin.length, 10);
assert.equal(sampleTin[0], "1");
assert.equal(Number(sampleTin[9]), computeTinCheckDigit(sampleTin.slice(0, 9)));
assert.equal(validateTaxId(sampleTin).valid, true);
assert.equal(validateTaxId(makeSampleTrn(sampleTin)).valid, true);
assert.equal(validateTaxId(`${sampleTin}12345`).valid, false, "TRN must end with 03");
assert.equal(validateTaxId("1234567890").valid, true, "check digit mismatch is a warning");
assert.ok(validateTaxId("1234567890").warnings.some((w) => w.includes("check digit")));
assert.equal(validateTaxId("2234567890").valid, false);

assert.equal(TAX_INVOICE_FIELDS.length, 51);
assert.equal(COMMERCIAL_INVOICE_FIELDS.length, 49);
assert.equal(TAX_INVOICE_FIELDS[4].term, "BTAE-02");
assert.equal(TAX_INVOICE_FIELDS[50].term, "IBT-154");
assert.equal(COMMERCIAL_INVOICE_FIELDS[14].term, "IBT-032");
assert.equal(COMMERCIAL_INVOICE_FIELDS[48].term, "IBT-154");

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(__dirname, "../examples/compliant-invoice.json"), "utf8"),
).invoiceData;

const good = checkInvoiceCompliance(fixture);
assert.equal(good.compliant, true, JSON.stringify(good.findings, null, 2));

const checklist = checkPintAeFields(fixture);
assert.equal(checklist.totalFields, 51);
assert.equal(checklist.complete, true, JSON.stringify(checklist.gaps, null, 2));

const xml = generatePintAeXml(fixture, { strict: true });
assert.equal(xml.generated, true, JSON.stringify(xml.gaps, null, 2));
for (const fragment of [
  "<cbc:CustomizationID>urn:peppol:pint:billing-1@ae-1</cbc:CustomizationID>",
  "<cbc:ProfileExecutionID>00000000</cbc:ProfileExecutionID>",
  "<cbc:UUID>6f1d2c3a-8b4e-4f7a-9c2d-1e0f3a5b7c9d</cbc:UUID>",
  '<cbc:EndpointID schemeID="0235">1234567893</cbc:EndpointID>',
  "<cbc:CountrySubentity>DXB</cbc:CountrySubentity>",
  'schemeAgencyID="TL"',
  "<cbc:PaymentMeansCode",
  "<cbc:Description>",
  "<cbc:BaseQuantity",
  "<cac:ItemPriceExtension>",
  '<cbc:Amount currencyID="AED">1050</cbc:Amount>',
]) {
  assert.ok(xml.xml?.includes(fragment), `generated XML is missing ${fragment}`);
}

const strictFail = generatePintAeXml({ documentType: "tax_invoice" }, { strict: true });
assert.equal(strictFail.generated, false);

const bad = checkInvoiceCompliance({ documentType: "tax_invoice" });
assert.equal(bad.compliant, false);
assert.ok(bad.findings.some((f) => f.severity === "error"));

const commercial = checkPintAeFields({ ...fixture, documentType: "commercial_invoice", typeCode: undefined });
assert.equal(commercial.fieldList, "commercial_invoice");
assert.equal(commercial.totalFields, 49);

const reqs = getEinvoicingRequirements("all", 60_000_000);
assert.equal(reqs.segment, "large");
assert.ok(reqs.phases.length === 1);

console.log("All self-checks passed.");
console.log("Sample TIN:", sampleTin);
console.log("Compliance score:", good.score);
console.log("Checklist completion %:", checklist.completionPercent);
console.log("XML bytes:", xml.xml?.length);
