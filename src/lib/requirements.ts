/**
 * UAE e-invoicing mandate timeline and high-level requirements.
 * Based on Cabinet Decision / Ministerial Decisions (MD 243 & 244 of 2025)
 * and MoF Electronic Invoicing Guidelines (v1.0, Feb 2026).
 *
 * Dates can shift — treat this as guidance and verify against official MoF/FTA notices.
 */

export type BusinessSegment =
  | "large"
  | "sme"
  | "government"
  | "all";

export interface MandatePhase {
  segment: Exclude<BusinessSegment, "all">;
  label: string;
  revenueThresholdAed: number | null;
  aspAppointmentDeadline: string;
  goLiveDate: string;
  notes: string[];
}

export interface RequirementsResult {
  asOf: string;
  disclaimer: string;
  segment: BusinessSegment;
  phases: MandatePhase[];
  technicalBaseline: string[];
  keyIdentifiers: Record<string, string>;
  nextActions: string[];
}

const PHASES: MandatePhase[] = [
  {
    segment: "large",
    label: "Large businesses (revenue ≥ AED 50 million)",
    revenueThresholdAed: 50_000_000,
    aspAppointmentDeadline: "2026-10-30",
    goLiveDate: "2027-01-01",
    notes: [
      "Appoint a Ministry of Finance Accredited Service Provider (ASP) by the appointment deadline.",
      "Mandatory electronic invoicing via Peppol / PINT AE from go-live.",
      "Pilot / early adoption window opened in 2026 via EmaraTax.",
    ],
  },
  {
    segment: "sme",
    label: "Other in-scope persons (revenue < AED 50 million)",
    revenueThresholdAed: null,
    aspAppointmentDeadline: "2027-03-31",
    goLiveDate: "2027-07-01",
    notes: [
      "Includes many B2B traders even below the VAT registration threshold if they fall in scope.",
      "Entities without any FTA tax registration must still obtain a TIN for Peppol participation.",
    ],
  },
  {
    segment: "government",
    label: "Government entities",
    revenueThresholdAed: null,
    aspAppointmentDeadline: "2027-10-01",
    goLiveDate: "2027-10-01",
    notes: [
      "Government entities follow a later mandatory wave (verify current MD / circulars).",
    ],
  },
];

const TECHNICAL_BASELINE = [
  "Document format: UBL 2.1 XML conforming to PINT AE (Peppol International Invoice — UAE).",
  "Typical specification identifier: urn:peppol:pint:billing-1@ae-1 (confirm against current PINT AE release).",
  "Transport: Peppol AS4 via an Accredited Service Provider (ASP) — not direct FTA file upload from ERP.",
  "Tax invoice mandatory fields: 51 data elements (MoF mandatory-fields document); commercial e-invoice: 49.",
  "Seller electronic address / participant ID uses scheme 0235 + 10-digit TIN (first 10 digits of TRN).",
  "Currency and amounts must be consistent; DocumentCurrencyCode is typically AED for domestic supplies.",
  "Invoice type codes commonly include 380 (invoice) and 381 (credit note).",
  "Validate against UBL 2.1 XSD and PINT AE Schematron rules before transmission.",
];

export function getEinvoicingRequirements(
  segment: BusinessSegment = "all",
  annualRevenueAed?: number,
): RequirementsResult {
  let phases = PHASES;
  let resolved: BusinessSegment = segment;

  if (segment === "all" && typeof annualRevenueAed === "number") {
    resolved = annualRevenueAed >= 50_000_000 ? "large" : "sme";
    phases = PHASES.filter((p) => p.segment === resolved);
  } else if (segment !== "all") {
    phases = PHASES.filter((p) => p.segment === segment);
  }

  const primary = phases[0];
  const nextActions: string[] = [
    "Confirm whether your entity is in scope under MD 243/244 of 2025.",
    "Obtain or verify your TIN (first 10 digits of your TRN) in EmaraTax.",
    "Shortlist and appoint an MoF Accredited Service Provider before your appointment deadline.",
    "Map ERP invoice fields to the PINT AE data dictionary (51 tax-invoice fields).",
    "Run sample invoices through ASP validation (XSD + Schematron) in the pilot window.",
  ];

  if (primary) {
    nextActions.unshift(
      `Target ASP appointment by ${primary.aspAppointmentDeadline} and go-live by ${primary.goLiveDate} for: ${primary.label}.`,
    );
  }

  return {
    asOf: "2026-09-08",
    disclaimer:
      "Informational summary only — not legal or tax advice. Verify dates and obligations against official UAE MoF / FTA publications.",
    segment: resolved,
    phases,
    technicalBaseline: TECHNICAL_BASELINE,
    keyIdentifiers: {
      TRN: "15-digit Tax Registration Number (VAT)",
      TIN: "First 10 digits of TRN — Peppol endpoint identifier body",
      PeppolParticipantId: "0235:<TIN>",
      Specification: "PINT AE on UBL 2.1",
    },
    nextActions,
  };
}
