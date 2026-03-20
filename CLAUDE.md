# LSP-MCP Server — Development Guide

## Build & Run

```bash
npm install          # install dependencies
npm run build        # compile TypeScript → dist/
npm run dev          # run via tsx (no build needed)
npm start            # run built dist/index.js
```

## Project Structure

```
src/
├── index.ts              — entry point, CLI, MCP tools
├── server-pool.ts        — LSP server pool (lazy start, one per language)
├── lsp-client.ts         — LSP client (JSON-RPC, document management)
├── language-registry.ts  — language and LSP server registry
└── formatters.ts         — formatting LSP responses as text
```

## Conventions

- TypeScript strict mode, ES2022, ESM modules (Node16 module resolution)
- All imports use `.js` extension (ESM requirement)
- Errors typed as `unknown` in catch: `catch (e: unknown)`
- Uses `@modelcontextprotocol/sdk` for MCP
- Uses `vscode-languageserver-protocol` for LSP types

## Adding a New Language

1. Add an entry to `BUILTIN_SERVERS` in `src/language-registry.ts`
2. Update tool descriptions in `src/index.ts` (help, diagnose_file)
3. Update the table in `README.md`
4. Build: `npm run build`

## Testing

```bash
# Verify it builds
npm run build

# Run the Qt5/C++ integration test (requires clangd and Qt5 dev headers)
node tests/test-cpp-qt.mjs

# Run with debug output
LSP_MCP_DEBUG=1 node dist/index.js --project /path/to/test/project
```

## MCP Tools

| Tool | Key parameters | Purpose |
|---|---|---|
| `diagnose_file` | `file` | Errors/warnings for a file on disk |
| `diagnose_workspace` | _(none)_ | Aggregate diagnostics across all open files |
| `get_completions` | `file`, `line`, `character` | Completions at a position |
| `get_hover` | `file`, `line`, `character` | Type/doc for a symbol |
| `get_definitions` | `file`, `line`, `character` | Jump to definition |
| `find_references` | `file`, `line`, `character` | Find all usages |
| `get_symbols` | `file` | Document symbol tree |
| `list_servers` | _(none)_ | Server status and supported extensions |
