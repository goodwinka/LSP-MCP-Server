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
 *   lsp-mcp-server --project /path/to/project          (stdio, single project)
 *   lsp-mcp-server --port 3100                          (HTTP, multi-project)
 *   lsp-mcp-server --port 3100 --project /default/path  (HTTP, with default project)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { LanguageRegistry } from "./language-registry.js";
import { ServerPool } from "./server-pool.js";
import {
  formatDiagnostics,
  formatWorkspaceDiagnostics,
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
  let port: number | undefined = process.env.LSP_MCP_PORT ? parseInt(process.env.LSP_MCP_PORT, 10) : undefined;

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
      case "--port":
      case "-P":
        if (i + 1 >= args.length) {
          console.error("Error: --port requires a port number.");
          process.exit(1);
        }
        port = parseInt(args[++i], 10);
        if (isNaN(port) || port < 1 || port > 65535) {
          console.error("Error: --port must be a valid port number (1-65535).");
          process.exit(1);
        }
        break;
      case "--help":
      case "-h":
        console.log(`
LSP-MCP Server — Universal IntelliSense for LLMs

Provides diagnostics, completions, hover, definitions, references, and symbols
for C/C++/CUDA, Python, TypeScript/JavaScript, Go, Rust, Lua, Bash, Java, Kotlin,
Zig, CSS, HTML, JSON, and more — auto-detected by file extension.

Options:
  --project, -p <path>    Path to project root
                          Required for stdio mode.
                          Optional in HTTP mode — becomes the default project
                          when no ?project= query parameter is given.
  --port, -P <number>     Start HTTP server on this port (for OpenWebUI / remote MCP clients)
                          If omitted, uses stdio transport (default for Claude Code)

Environment variables:
  LSP_PROJECT_ROOT        Project root (fallback if --project not given)
  LSP_MCP_PORT            HTTP port (fallback if --port not given)
  LSP_MCP_DEBUG=1         Print language server stderr to console

HTTP multi-project mode:
  Each client specifies its own project path via the ?project= URL parameter:
    http://host:3100/mcp?project=/home/alice/myapp
    http://host:3100/mcp?project=/home/bob/otherapp
  The server maintains a separate pool of LSP servers per project.
`);
        process.exit(0);
    }
  }

  // In stdio mode a project root is required
  if (!port && !projectRoot) {
    console.error(
      "Error: project root is required.\n" +
      "Use --project <path> or set LSP_PROJECT_ROOT env var.\n" +
      "Run with --help for usage."
    );
    process.exit(1);
  }

  let resolvedProject = "";
  if (projectRoot) {
    resolvedProject = resolve(projectRoot);
    if (!existsSync(resolvedProject)) {
      console.error(`Error: project root does not exist: ${resolvedProject}`);
      process.exit(1);
    }
  }

  return { defaultProject: resolvedProject, port };
}

// ── MCP server factory ───────────────────────────────────────

function buildMcpServer(pool: ServerPool, projectRoot: string, registry: LanguageRegistry): McpServer {
  const server = new McpServer({
    name: "lsp-intellisense",
    version: "2.0.0",
  });

  // ── Tool: diagnose_file ──────────────────────────────────

  server.tool(
    "diagnose_file",
    `Get all compiler/linter errors, warnings, and hints for a source file.
Works with ANY supported language — the correct language server is auto-selected by file extension.
Supported: C/C++/CUDA (clangd), Python (pyright/pylsp), TypeScript/JS, Go, Rust, Java, Kotlin, Lua, Bash, Zig, CSS, HTML, JSON.
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

  // ── Tool: diagnose_workspace ─────────────────────────────

  server.tool(
    "diagnose_workspace",
    `Get diagnostics for ALL files opened during this session, across all language servers.
Shows a summary of total errors and warnings, then lists issues per file.
Use after editing multiple files to see the full picture in one call.`,
    {},
    async () => {
      try {
        const entries = pool.getAllDiagnostics();
        return { content: [{ type: "text" as const, text: formatWorkspaceDiagnostics(entries, projectRoot) }] };
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

  return server;
}

// ── Multi-project pool manager ───────────────────────────────

class ProjectManager {
  private pools = new Map<string, ServerPool>();

  constructor(private registry: LanguageRegistry) {}

  getPool(projectRoot: string): ServerPool {
    if (!this.pools.has(projectRoot)) {
      this.pools.set(projectRoot, new ServerPool(projectRoot, this.registry));
    }
    return this.pools.get(projectRoot)!;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.pools.values()].map((p) => p.stopAll()));
  }
}

// ── HTTP request handler ─────────────────────────────────────

function resolveProjectFromRequest(
  req: IncomingMessage,
  defaultProject: string
): { projectRoot: string; error?: string } {
  const reqUrl = new URL(req.url ?? "/", "http://localhost");

  // Priority: ?project= query param, then X-Project-Root header, then default
  const raw =
    reqUrl.searchParams.get("project") ??
    (req.headers["x-project-root"] as string | undefined) ??
    defaultProject;

  if (!raw) {
    return {
      projectRoot: "",
      error:
        'No project specified. Add ?project=/path/to/project to the URL, ' +
        'or set X-Project-Root header, or start the server with --project.',
    };
  }

  const projectRoot = resolve(raw);
  if (!existsSync(projectRoot)) {
    return { projectRoot: "", error: `Project root does not exist: ${projectRoot}` };
  }

  return { projectRoot };
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const { defaultProject, port } = parseArgs();

  const registry = new LanguageRegistry();

  if (port !== undefined) {
    // ── HTTP mode: multi-project, multi-user ─────────────
    const manager = new ProjectManager(registry);

    const shutdown = async () => {
      await manager.stopAll();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const reqUrl = new URL(req.url ?? "/", "http://localhost");
      const path = reqUrl.pathname;

      if (path !== "/mcp" && path !== "/") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found. MCP endpoint is at /mcp");
        return;
      }

      const { projectRoot, error } = resolveProjectFromRequest(req, defaultProject);
      if (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error }));
        return;
      }

      const pool = manager.getPool(projectRoot);
      const server = buildMcpServer(pool, projectRoot, registry);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless — new McpServer per request is fine
      });

      await server.connect(transport);
      await transport.handleRequest(req, res);
    });

    httpServer.listen(port, () => {
      process.stderr.write(`LSP-MCP Server listening on http://0.0.0.0:${port}/mcp\n`);
      if (defaultProject) {
        process.stderr.write(`Default project: ${defaultProject}\n`);
      } else {
        process.stderr.write(`Multi-project mode: clients must pass ?project=/path/to/project\n`);
      }
    });
  } else {
    // ── stdio mode: single project, Claude Code ──────────
    const pool = new ServerPool(defaultProject, registry);
    const server = buildMcpServer(pool, defaultProject, registry);

    const shutdown = async () => {
      await pool.stopAll();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
