/**
 * Transaction-level scope helper for MD 243 of 2025 as amended by MD 197 of 2026.
 * Answers: must this transaction be e-invoiced, from when, and can it be done voluntarily?
 */
import { getEinvoicingRequirements, type MandatePhase } from "./requirements.js";

export type TransactionKind =
  | "b2b"
  | "b2g"
  | "b2c"
  | "intra_tax_group"
  | "sovereign_government"
  | "air_passenger"
  | "air_cargo"
  | "financial_exempt_or_zero";

export type ScopeVerdict = "mandatory" | "excluded" | "voluntary_only" | "out_of_scope";

export interface ScopeInput {
  transactionKind: TransactionKind;
  annualRevenueAed?: number;
  entityType?: "business" | "government";
  /** ISO date YYYY-MM-DD. Defaults to today for "is it mandatory yet?" */
  asOf?: string;
}

export interface ScopeResult {
  verdict: ScopeVerdict;
  inScopeForMandate: boolean;
  currentlyMandatory: boolean;
  transactionKind: TransactionKind;
  asOf: string;
  exclusion: {
    reason: string;
    legalBasis: string;
    duration: string | null;
    endsOn: string | null;
    voluntaryAllowed: boolean;
  } | null;
  phase: MandatePhase | null;
  aspAppointmentBy: string | null;
  mandatoryFrom: string | null;
  notes: string[];
  disclaimer: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseDay(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, d));
  return dt.toISOString().slice(0, 10);
}

function onOrAfter(asOf: string, start: string): boolean {
  return parseDay(asOf) >= parseDay(start);
}

export function checkEinvoicingScope(input: ScopeInput): ScopeResult {
  const asOf = input.asOf && ISO_DATE.test(input.asOf) ? input.asOf : todayIso();
  const entityType =
    input.entityType ?? (input.transactionKind === "sovereign_government" ? "government" : "business");
  const reqs = getEinvoicingRequirements(
    entityType === "government" ? "government" : "all",
    entityType === "government" ? undefined : input.annualRevenueAed,
  );
  const phase = reqs.phases.length === 1 ? reqs.phases[0] : null;
  const mandatoryFrom = phase?.goLiveDate ?? null;
  const aspAppointmentBy = phase?.aspAppointmentDeadline ?? null;
  const base = {
    transactionKind: input.transactionKind,
    asOf,
    phase,
    aspAppointmentBy,
    mandatoryFrom,
    disclaimer:
      "Informational only — not legal or tax advice. Confirm scope against MD 243 of 2025 as amended (including MD 197 of 2026) and current MoF / FTA notices.",
  };

  const excluded = (
    reason: string,
    legalBasis: string,
    duration: string | null,
    endsOn: string | null,
    extraNotes: string[] = [],
  ): ScopeResult => ({
    ...base,
    verdict: "excluded",
    inScopeForMandate: false,
    currentlyMandatory: false,
    exclusion: { reason, legalBasis, duration, endsOn, voluntaryAllowed: true },
    notes: [
      "You may still issue a PINT AE e-invoice voluntarily; the full rules then apply except penalties.",
      ...extraNotes,
    ],
  });

  switch (input.transactionKind) {
    case "b2c":
      return {
        ...base,
        verdict: "out_of_scope",
        inScopeForMandate: false,
        currentlyMandatory: false,
        exclusion: null,
        notes: [
          "The first waves focus on B2B and B2G. B2C supplies are generally outside the mandatory Electronic Invoicing System.",
          "Confirm any later B2C expansion against current MoF / FTA notices.",
        ],
      };
    case "intra_tax_group":
      return excluded(
        "Business transactions between members of the same VAT Tax Group.",
        "MD 243 of 2025 Art. 4(1)(f) as replaced by MD 197 of 2026",
        "24 months from 1 January 2027",
        addMonths("2027-01-01", 24),
        ["After the exclusion period, treat the supply as ordinary B2B unless MoF extends the exclusion."],
      );
    case "sovereign_government":
      return excluded(
        "Government entity transactions in a sovereign capacity that do not compete with the private sector.",
        "MD 243 of 2025 Art. 4(1)(a) (VAT Law alignment)",
        null,
        null,
        ["Commercial activity by a government entity that competes with the private sector is not covered by this exclusion."],
      );
    case "air_passenger":
      return excluded(
        "International passenger air transport (electronic ticket) and ancillary passenger services (Electronic Miscellaneous Document).",
        "MD 243 of 2025 Art. 4(1)(b)–(c)",
        null,
        null,
      );
    case "air_cargo":
      return excluded(
        "International air cargo where an airway bill is issued.",
        "MD 243 of 2025 Art. 4(1)(d)",
        "24 months from the date the Electronic Invoicing System becomes effective for the issuer",
        mandatoryFrom ? addMonths(mandatoryFrom, 24) : null,
      );
    case "financial_exempt_or_zero":
      return excluded(
        "Financial services that are VAT-exempt or zero-rated.",
        "MD 243 of 2025 Art. 4(1)(e); VAT Executive Regulation Art. 42",
        null,
        null,
      );
    case "b2b":
    case "b2g": {
      if (!phase) {
        return {
          ...base,
          verdict: "voluntary_only",
          inScopeForMandate: true,
          currentlyMandatory: false,
          exclusion: null,
          notes: [
            "In-scope B2B/B2G supply. Pass annualRevenueAed (or entityType=government) to resolve the exact ASP and go-live dates.",
            "Voluntary implementation has been available since 1 July 2026.",
          ],
        };
      }
      const currentlyMandatory = onOrAfter(asOf, phase.goLiveDate);
      return {
        ...base,
        verdict: currentlyMandatory ? "mandatory" : "voluntary_only",
        inScopeForMandate: true,
        currentlyMandatory,
        exclusion: null,
        notes: [
          currentlyMandatory
            ? `Mandatory for this cohort from ${phase.goLiveDate}.`
            : `Not yet mandatory. Appoint an ASP by ${phase.aspAppointmentDeadline}; go-live ${phase.goLiveDate}. Voluntary implementation is available from 1 July 2026.`,
          input.transactionKind === "b2g"
            ? "B2G supplies follow the supplier's cohort unless the buyer is a government entity acting in a sovereign capacity (use sovereign_government)."
            : "Confirm the buyer is VAT-registered / in-scope B2B, not a consumer (use b2c).",
        ],
      };
    }
  }
}
