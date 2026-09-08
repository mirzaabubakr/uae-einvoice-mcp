export type InvoiceDocumentType = "tax_invoice" | "commercial_invoice" | "credit_note";

export interface PartyInput {
  legalName?: string;
  tradeName?: string;
  trn?: string;
  tin?: string;
  countryCode?: string;
  addressLine?: string;
  cityOrEmirate?: string;
  postalZone?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  peppolId?: string;
}

export interface InvoiceLineInput {
  id?: string;
  name?: string;
  quantity?: number;
  unitCode?: string;
  netAmount?: number;
  unitPrice?: number;
  taxCategoryCode?: string;
  taxPercent?: number;
}

export interface TaxBreakdownInput {
  taxableAmount?: number;
  taxAmount?: number;
  taxCategoryCode?: string;
  taxPercent?: number;
  exemptionReason?: string;
  exemptionReasonCode?: string;
}

export interface InvoiceDataInput {
  documentType?: InvoiceDocumentType;
  invoiceNumber?: string;
  issueDate?: string;
  dueDate?: string;
  currencyCode?: string;
  taxCurrencyCode?: string;
  customizationId?: string;
  profileId?: string;
  typeCode?: string;
  buyerReference?: string;
  periodStart?: string;
  periodEnd?: string;
  taxPointDate?: string;
  /** Original invoice number — important for credit notes */
  billingReference?: string;
  seller?: PartyInput;
  buyer?: PartyInput;
  lineNetTotal?: number;
  taxExclusiveTotal?: number;
  taxTotal?: number;
  taxTotalAed?: number;
  taxInclusiveTotal?: number;
  allowanceTotal?: number;
  chargeTotal?: number;
  prepaidAmount?: number;
  payableAmount?: number;
  taxBreakdown?: TaxBreakdownInput[];
  lines?: InvoiceLineInput[];
}
