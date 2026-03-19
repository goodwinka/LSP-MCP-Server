#!/usr/bin/env node
/**
 * LSP-MCP Server — Universal IntelliSense for LLMs.
 *
 * Bridges ANY language server (clangd, pyright, tsserver, gopls, rust-analyzer…)
 * to MCP protocol, giving Claude Code access to diagnostics, completions,
 * hover info, definitions, references, and symbols for any language.
 *
 * The correct LSP server is auto-selected based on file extension.
 *
 * Usage:
 *   lsp-mcp-server --project /path/to/project
 *   LSP_PROJECT_ROOT=/path/to/project lsp-mcp-server
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { LanguageRegistry } from "./language-registry.js";
import { ServerPool } from "./server-pool.js";
import {
  formatDiagnostics,
  formatCompletions,
  formatHover,
  formatDefinitions,
  formatReferences,
  formatSymbols,
} from "./formatters.js";

// ── Helpers ─────────────────────────────────────────────────

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── CLI argument parsing ─────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let projectRoot = process.env.LSP_PROJECT_ROOT ?? "";

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--project":
      case "-p":
        if (i + 1 >= args.length) {
          console.error("Error: --project requires a path argument.");
          process.exit(1);
        }
        projectRoot = args[++i];
        break;
      case "--help":
      case "-h":
        console.log(`
LSP-MCP Server — Universal IntelliSense for LLMs

Provides diagnostics, completions, hover, definitions, references, and symbols
for C/C++, Python, TypeScript/JavaScript, Go, Rust, Lua, Bash, Java, Kotlin,
Zig, CSS, HTML, JSON, and more — auto-detected by file extension.

Options:
  --project, -p <path>    Path to project root (required)

Environment variables:
  LSP_PROJECT_ROOT        Project root (fallback if --project not given)
  LSP_MCP_DEBUG=1         Print language server stderr to console
`);
        process.exit(0);
    }
  }

  if (!projectRoot) {
    console.error(
      "Error: project root is required.\n" +
      "Use --project <path> or set LSP_PROJECT_ROOT env var.\n" +
      "Run with --help for usage."
    );
    process.exit(1);
  }

  const resolved = resolve(projectRoot);
  if (!existsSync(resolved)) {
    console.error(`Error: project root does not exist: ${resolved}`);
    process.exit(1);
  }

  return { projectRoot: resolved };
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const { projectRoot } = parseArgs();

  const registry = new LanguageRegistry();
  const pool = new ServerPool(projectRoot, registry);

  const server = new McpServer({
    name: "lsp-intellisense",
    version: "2.0.0",
  });

  // ── Tool: diagnose_file ──────────────────────────────────

  server.tool(
    "diagnose_file",
    `Get all compiler/linter errors, warnings, and hints for a source file.
Works with ANY supported language — the correct language server is auto-selected by file extension.
Supported: C/C++ (clangd), Python (pyright/pylsp), TypeScript/JS, Go, Rust, Java, Kotlin, Lua, Bash, Zig, CSS, HTML, JSON.
Use BEFORE writing code to check the current state, and AFTER editing to verify your changes.`,
    {
      file: z.string().describe("Path to the file relative to project root, e.g. 'src/main.cpp' or 'app/views.py'"),
    },
    async ({ file }) => {
      try {
        const client = await pool.getClient(file);
        const result = await client.getDiagnostics(file);
        const header = `[${client.serverName}] `;
        return { content: [{ type: "text" as const, text: header + formatDiagnostics(file, result.diagnostics) }] };
      } catch (e: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  // ── Tool: diagnose_code ──────────────────────────────────

  server.tool(
    "diagnose_code",
    `Check source code for errors WITHOUT saving to disk.
Pass the full file content and a virtual filename (extension matters for language detection).
Useful for validating code before writing it. Works with any supported language.`,
    {
      file: z.string().describe("Virtual filename, e.g. 'src/widget.cpp' or 'utils.py' — extension determines the language server"),
      content: z.string().describe("Full source code to check"),
    },
    async ({ file, content }) => {
      try {
        const client = await pool.getClient(file);
        await client.updateDocument(file, content);
        const result = await client.getDiagnostics(file);
        const header = `[${client.serverName}] `;
        return { content: [{ type: "text" as const, text: header + formatDiagnostics(file, result.diagnostics) }] };
      } catch (e: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  // ── Tool: get_completions ────────────────────────────────

  server.tool(
    "get_completions",
    `Get IntelliSense completions at a specific position in a source file.
Returns available functions, methods, classes, variables, and snippets.
Useful for discovering API methods (e.g. Qt signals, Python stdlib, TS types).
Line and character are 0-based. Works with any supported language.`,
    {
      file: z.string().describe("File path relative to project root"),
      line: z.number().int().min(0).describe("0-based line number"),
      character: z.number().int().min(0).describe("0-based column number"),
    },
    async ({ file, line, character }) => {
      try {
        const client = await pool.getClient(file);
        const items = await client.getCompletions(file, line, character);
        return { content: [{ type: "text" as const, text: formatCompletions(items) }] };
      } catch (e: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  // ── Tool: get_hover ──────────────────────────────────────

  server.tool(
    "get_hover",
    `Get type information and documentation for a symbol at a position.
Returns the type signature, brief docs, and declaration.
Great for checking exact API signatures, parameter types, return types.
Line and character are 0-based. Works with any supported language.`,
    {
      file: z.string().describe("File path relative to project root"),
      line: z.number().int().min(0).describe("0-based line number"),
      character: z.number().int().min(0).describe("0-based column number"),
    },
    async ({ file, line, character }) => {
      try {
        const client = await pool.getClient(file);
        const hover = await client.getHover(file, line, character);
        return { content: [{ type: "text" as const, text: formatHover(hover) }] };
      } catch (e: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  // ── Tool: get_definitions ────────────────────────────────

  server.tool(
    "get_definitions",
    `Jump to the definition of a symbol. Returns file paths and line numbers.
Useful for understanding how a class or function is implemented.
Line and character are 0-based. Works with any supported language.`,
    {
      file: z.string().describe("File path relative to project root"),
      line: z.number().int().min(0).describe("0-based line number"),
      character: z.number().int().min(0).describe("0-based column number"),
    },
    async ({ file, line, character }) => {
      try {
        const client = await pool.getClient(file);
        const locs = await client.getDefinitions(file, line, character);
        return { content: [{ type: "text" as const, text: formatDefinitions(locs, projectRoot) }] };
      } catch (e: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  // ── Tool: find_references ────────────────────────────────

  server.tool(
    "find_references",
    `Find all usages of a symbol across the project.
Useful before renaming or refactoring to understand impact.
Line and character are 0-based. Works with any supported language.`,
    {
      file: z.string().describe("File path relative to project root"),
      line: z.number().int().min(0).describe("0-based line number"),
      character: z.number().int().min(0).describe("0-based column number"),
    },
    async ({ file, line, character }) => {
      try {
        const client = await pool.getClient(file);
        const locs = await client.getReferences(file, line, character);
        return { content: [{ type: "text" as const, text: formatReferences(locs, projectRoot) }] };
      } catch (e: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  // ── Tool: get_symbols ────────────────────────────────────

  server.tool(
    "get_symbols",
    `List all symbols (classes, functions, variables, enums, etc.) defined in a file.
Returns a tree of symbols with their types and line numbers.
Useful for getting an overview of a file's structure before editing.
Works with any supported language.`,
    {
      file: z.string().describe("File path relative to project root"),
    },
    async ({ file }) => {
      try {
        const client = await pool.getClient(file);
        const symbols = await client.getDocumentSymbols(file);
        return { content: [{ type: "text" as const, text: formatSymbols(symbols) }] };
      } catch (e: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  // ── Tool: list_servers ───────────────────────────────────

  server.tool(
    "list_servers",
    `List all supported language servers, their status (installed/missing), and supported file extensions.
Also shows which servers are currently running.`,
    {},
    async () => {
      const all = registry.getAllServers();
      const running = pool.getRunningServers();
      const runningSet = new Set(running.filter((r) => r.running).map((r) => r.name));

      const lines = all.map((s) => {
        const status = runningSet.has(s.config.name)
          ? "🟢 running"
          : s.available
            ? "✅ installed"
            : "❌ not found";
        const exts = s.config.extensions.join(", ");
        const hint = !s.available ? `\n    Install: ${s.config.installHint}` : "";
        return `• ${s.config.name} [${status}] — ${exts}${hint}`;
      });

      return {
        content: [{
          type: "text" as const,
          text: [
            `Project: ${projectRoot}`,
            ``,
            `Language servers:`,
            ...lines,
          ].join("\n"),
        }],
      };
    }
  );

  // ── Start server ─────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await pool.stopAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
