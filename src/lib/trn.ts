/**
 * UAE Tax Registration Number (TRN) and Tax Identification Number (TIN) helpers.
 *
 * - TRN: 15 digits issued by the FTA for VAT-registered entities; PINT AE rule ibr-132-ae
 *   requires it to start with 1 and end with 03
 * - TIN: first 10 digits of the TRN; used as the Peppol participant identifier
 *   under scheme 0235 (format: 0235:TIN); ibr-148-ae requires the form 1XXXXXXXXX
 *
 * TIN structure (Peppol Participant Identifier Schemes v9.7, AE:TIN / ISO 6523 scheme 0235):
 * - digit 1: UAE country identifier — must be "1"
 * - digits 2–9: FTA business identifier
 * - digit 10: Luhn check digit (odd-placed digits from the left ×2)
 */

export function isTrnFormat(value: string): boolean {
  return /^1\d{12}03$/.test(value);
}

export function isTinFormat(value: string): boolean {
  return /^1\d{9}$/.test(value);
}

export type IdentifierKind = "trn" | "tin" | "unknown";

export interface TrnValidationResult {
  input: string;
  normalized: string;
  kind: IdentifierKind;
  valid: boolean;
  errors: string[];
  warnings: string[];
  tin: string | null;
  trn: string | null;
  peppolParticipantId: string | null;
  details: {
    startsWithUaeCountryCode: boolean;
    formatOk: boolean;
    checksumOk: boolean | null;
  };
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Peppol AE:TIN Luhn variant: odd-placed digits (1-indexed from the left) ×2;
 * if product ≥ 10, sum its digits; even-placed ×1. Check digit is sum % 10.
 */
export function computeTinCheckDigit(nineDigits: string): number {
  if (!/^\d{9}$/.test(nineDigits)) {
    throw new Error("TIN body must be exactly 9 digits");
  }

  let sum = 0;
  for (let i = 0; i < nineDigits.length; i++) {
    const digit = Number(nineDigits[i]);
    const position = i + 1; // 1-indexed from the left
    let value = position % 2 === 1 ? digit * 2 : digit;
    if (value >= 10) {
      value = Math.floor(value / 10) + (value % 10);
    }
    sum += value;
  }

  return sum % 10;
}

export function isValidTinChecksum(tin: string): boolean {
  if (!/^\d{10}$/.test(tin)) return false;
  const expected = computeTinCheckDigit(tin.slice(0, 9));
  return Number(tin[9]) === expected;
}

export function tinToPeppolId(tin: string): string {
  return `0235:${tin}`;
}

export function validateTaxId(raw: string): TrnValidationResult {
  const normalized = digitsOnly(raw.trim());
  const errors: string[] = [];
  const warnings: string[] = [];

  let kind: IdentifierKind = "unknown";
  if (normalized.length === 15) kind = "trn";
  else if (normalized.length === 10) kind = "tin";

  const formatOk =
    (kind === "trn" && /^\d{15}$/.test(normalized)) ||
    (kind === "tin" && /^\d{10}$/.test(normalized));

  if (!normalized) {
    errors.push("Value is empty after removing non-digit characters.");
  } else if (kind === "unknown") {
    errors.push(
      `Expected a 10-digit TIN or 15-digit TRN; got ${normalized.length} digit(s).`,
    );
  }

  const tinCandidate =
    kind === "trn"
      ? normalized.slice(0, 10)
      : kind === "tin"
        ? normalized
        : null;

  const startsWithUaeCountryCode = tinCandidate?.startsWith("1") ?? false;
  if (tinCandidate && !startsWithUaeCountryCode) {
    errors.push(
      "TIN/TRN must start with 1 (UAE country identifier per GCC / Peppol AE:TIN).",
    );
  }

  if (kind === "trn" && formatOk && !normalized.endsWith("03")) {
    errors.push("A UAE VAT TRN must end with 03 (PINT AE rule ibr-132-ae).");
  }

  let checksumOk: boolean | null = null;
  if (tinCandidate && /^\d{10}$/.test(tinCandidate)) {
    checksumOk = isValidTinChecksum(tinCandidate);
    if (!checksumOk) {
      warnings.push(
        `TIN check digit does not match the Peppol AE:TIN Luhn description (expected ${computeTinCheckDigit(tinCandidate.slice(0, 9))}, got ${tinCandidate[9]}). PINT AE Schematron does not enforce it — confirm the number on EmaraTax.`,
      );
    }
  }

  if (kind === "trn" && formatOk) {
    warnings.push(
      "Full 15-digit TRN format checked locally only — live FTA register lookup is not performed.",
    );
  }

  const valid = errors.length === 0 && formatOk;

  const trn = kind === "trn" && formatOk ? normalized : null;

  return {
    input: raw,
    normalized,
    kind,
    valid,
    errors,
    warnings,
    tin: tinCandidate,
    trn,
    peppolParticipantId:
      tinCandidate && /^\d{10}$/.test(tinCandidate)
        ? tinToPeppolId(tinCandidate)
        : null,
    details: {
      startsWithUaeCountryCode,
      formatOk,
      checksumOk,
    },
  };
}

/** Generate a structurally valid sample TIN for demos/tests (not a real FTA number). */
export function makeSampleTin(bodyEightDigits = "23456789"): string {
  if (!/^\d{8}$/.test(bodyEightDigits)) {
    throw new Error("bodyEightDigits must be 8 digits");
  }
  const nine = `1${bodyEightDigits}`;
  return `${nine}${computeTinCheckDigit(nine)}`;
}

/** Sample TRN for a sample TIN, following the official PINT AE examples (TIN + "01003"). */
export function makeSampleTrn(tin = makeSampleTin()): string {
  return `${tin}01003`;
}
