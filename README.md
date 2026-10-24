# uae-einvoice-mcp

[![Uae Einvoice MCP server](https://mcprush.com/badge/uae-einvoice-mcp/card.svg)](https://mcprush.com/to/uae-einvoice-mcp?ref=badge)

MCP server for **UAE e-invoicing / PINT AE** — TRN/TIN validation, structural compliance, the **51-field mandatory checklist**, UBL XML stub generation, and mandate timeline helpers.

Built with the MCP TypeScript SDK v2 (`@modelcontextprotocol/server`) over **stdio**. Free to run locally; no API keys required for v0.2.

> Informational tooling only — not legal or tax advice, and not a substitute for Accredited Service Provider (ASP) XSD validation, digital signatures, or live FTA register checks. `validate_pint_ae_xml` runs the official OpenPeppol PINT AE 1.0.4 Schematron.

## Why this exists

UAE e-invoicing (Peppol + PINT AE) forces ERP and finance teams to get dozens of mandatory fields, TIN vs TRN, and Peppol endpoint IDs right before an ASP will transmit anything. This server gives AI assistants a small, installable toolkit for those checks.

## Tools

| Tool | What it does |
| --- | --- |
| `lookup_business_trn` | Validates 15-digit TRN or 10-digit TIN format, UAE `1…` prefix, Peppol AE:TIN check digit, and returns `0235:<TIN>` |
| `check_invoice_compliance` | Structural checks (parties, totals math, tax breakdown, lines) with errors/warnings/score |
| `check_pint_ae_fields` | Full **51-field** mandatory matrix: present / missing / invalid / N/A + gaps |
| `generate_pint_ae_xml` | Builds a UBL 2.1 PINT AE Invoice/CreditNote (optional `strict` mode) |
| `validate_pint_ae_xml` | Official PINT AE 1.0.4 Schematron (shared + UAE rules); first call downloads and compiles the rules |
| `get_einvoicing_requirements` | Mandate phases, excluded transactions, recent MoF amendments, technical baseline, next actions |
| `check_einvoicing_scope` | Per-transaction scope: B2B/B2G/B2C, Tax Group, sovereign, air, exempt finance — mandatory / excluded / voluntary |

## Requirements

- Node.js **20+**

## Install / run

```bash
npm install
npm run build
npm start
```

Dev (TypeScript directly):

```bash
npm run dev
```

Self-check (no MCP client needed):

```bash
npm run selfcheck
```

### MCP Inspector

```bash
npm run inspector
```

Paste fixtures from `examples/compliant-invoice.json`, `examples/credit-note.json`, `examples/usd-invoice.json`, or `examples/broken-invoice.json` into the tools.

### Cursor / Claude Desktop (stdio)

Published package (recommended):

```json
{
  "mcpServers": {
    "uae-einvoice": {
      "command": "npx",
      "args": ["-y", "uae-einvoice-mcp"]
    }
  }
}
```

Local checkout:

```json
{
  "mcpServers": {
    "uae-einvoice": {
      "command": "node",
      "args": ["/absolute/path/to/uae-einvoice-mcp/dist/index.js"]
    }
  }
}
```

See also `.cursor/mcp.json.example`.

## Suggested test flow

1. `check_pint_ae_fields` with `examples/compliant-invoice.json`
2. `generate_pint_ae_xml` with the same payload (`strict: true` should succeed)
3. `validate_pint_ae_xml` on the generated XML (first call downloads PINT AE 1.0.4 rules)
4. Repeat 1–2 with `examples/credit-note.json` and `examples/usd-invoice.json`
5. `generate_pint_ae_xml` with `examples/broken-invoice.json` and `strict: true` (should refuse)
6. `check_einvoicing_scope` with `transactionKind: b2b` and an annual revenue

## Roadmap

- [x] 51-field checklist + PINT AE XML stub generation
- [x] Official PINT AE 1.0.4 Schematron validation (`validate_pint_ae_xml`)
- [x] Per-transaction scope helper (`check_einvoicing_scope`)
- [x] Credit-note and non-AED fixtures + CI self-check
- [ ] Optional HTTP + API-key transport for hosted / paid tier
- [x] Publish to npm (`uae-einvoice-mcp@0.2.2`)
- [x] List in MCP registry (`io.github.mirzaabubakr/uae-einvoice-mcp`)

## License

MIT
