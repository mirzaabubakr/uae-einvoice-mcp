# uae-einvoice-mcp

MCP server for **UAE e-invoicing / PINT AE** helpers — validate TRN/TIN identifiers, structurally check invoice fields, and fetch the mandate timeline.

Built with the MCP TypeScript SDK v2 (`@modelcontextprotocol/server`) over **stdio**. Free to run locally; no API keys required for v0.1.

> Informational tooling only — not legal or tax advice, and not a substitute for Accredited Service Provider (ASP) XSD/Schematron validation or live FTA register checks.

## Why this exists

UAE e-invoicing (Peppol + PINT AE) forces ERP and finance teams to get dozens of mandatory fields, TIN vs TRN, and Peppol endpoint IDs right before an ASP will transmit anything. This server gives AI assistants a small, installable toolkit for those checks.

## Tools

| Tool | What it does |
| --- | --- |
| `lookup_business_trn` | Validates 15-digit TRN or 10-digit TIN format, UAE `1…` prefix, Peppol AE:TIN check digit, and returns `0235:<TIN>` |
| `check_invoice_compliance` | Structural PINT AE field checks (parties, totals math, tax breakdown, lines) with errors/warnings/score |
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

Or:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

### Cursor / Claude Desktop (stdio)

Add to your MCP config (path adjusted to your clone):

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

After `npm link` / publish:

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

## Example: `lookup_business_trn`

Input: `{ "taxId": "123456789012345" }`  
Output includes normalized digits, derived TIN, Peppol participant ID, and checksum errors if any.

## Example: `check_invoice_compliance`

Pass seller/buyer names + tax IDs, `issueDate`, AED currency, monetary totals, tax breakdown, and at least one line. The tool returns `compliant`, `score`, `findings[]`, and derived Peppol IDs.

## Roadmap

- [ ] Deeper PINT AE code-list coverage (UOM, tax categories, BT field codes)
- [ ] Optional HTTP + API-key transport for hosted / paid tier
- [ ] Publish to npm and MCP directories

## License

MIT
