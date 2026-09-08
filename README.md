# uae-einvoice-mcp

MCP server for **UAE e-invoicing / PINT AE** — TRN/TIN validation, structural compliance, the **51-field mandatory checklist**, UBL XML stub generation, and mandate timeline helpers.

Built with the MCP TypeScript SDK v2 (`@modelcontextprotocol/server`) over **stdio**. Free to run locally; no API keys required for v0.2.

> Informational tooling only — not legal or tax advice, and not a substitute for Accredited Service Provider (ASP) XSD/Schematron validation or live FTA register checks.

## Why this exists

UAE e-invoicing (Peppol + PINT AE) forces ERP and finance teams to get dozens of mandatory fields, TIN vs TRN, and Peppol endpoint IDs right before an ASP will transmit anything. This server gives AI assistants a small, installable toolkit for those checks.

## Tools

| Tool | What it does |
| --- | --- |
| `lookup_business_trn` | Validates 15-digit TRN or 10-digit TIN format, UAE `1…` prefix, Peppol AE:TIN check digit, and returns `0235:<TIN>` |
| `check_invoice_compliance` | Structural checks (parties, totals math, tax breakdown, lines) with errors/warnings/score |
| `check_pint_ae_fields` | Full **51-field** mandatory matrix: present / missing / invalid / N/A + gaps |
| `generate_pint_ae_xml` | Builds a UBL 2.1 PINT AE-shaped Invoice/CreditNote XML stub (optional `strict` mode) |
| `get_einvoicing_requirements` | Mandate phases (large / SME / government), technical baseline, and next actions |

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

Paste fixtures from `examples/compliant-invoice.json` or `examples/broken-invoice.json` into the tools.

### Cursor / Claude Desktop (stdio)

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

## Suggested test flow

1. `check_pint_ae_fields` with `examples/compliant-invoice.json`
2. `generate_pint_ae_xml` with the same payload (`strict: true` should succeed)
3. `generate_pint_ae_xml` with `examples/broken-invoice.json` and `strict: true` (should refuse)

## Roadmap

- [x] 51-field checklist + PINT AE XML stub generation
- [ ] Deeper code-list coverage (UOM, exemption reason codes)
- [ ] Optional HTTP + API-key transport for hosted / paid tier
- [ ] Publish to npm and MCP directories

## License

MIT
