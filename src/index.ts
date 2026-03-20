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
 *   lsp-mcp-server --port 3100                          (HTTP, workspace-based)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { resolve, join, dirname, sep } from "node:path";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
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
  --project, -p <path>    Path to project root (required for stdio mode)
  --port, -P <number>     Start HTTP server on this port (for OpenWebUI)

Environment variables:
  LSP_PROJECT_ROOT        Project root (stdio mode)
  LSP_MCP_PORT            HTTP port
  LSP_MCP_DEBUG=1         Print language server stderr to console
  LSP_MCP_WS_TTL_HOURS    Workspace TTL in hours (default: 1)
`);
        process.exit(0);
    }
  }

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

// ── Workspace manager ────────────────────────────────────────

interface Workspace {
  id: string;
  projectRoot: string;
  pool: ServerPool;
  lastUsed: number;
}

class WorkspaceManager {
  private workspaces = new Map<string, Workspace>();
  private cleanupTimer: ReturnType<typeof setInterval>;
  private ttlMs: number;

  constructor(
    private registry: LanguageRegistry,
    ttlHours = 1
  ) {
    this.ttlMs = ttlHours * 60 * 60 * 1000;
    this.cleanupTimer = setInterval(() => this.cleanup(), 15 * 60 * 1000);
  }

  create(): Workspace {
    const id = randomUUID();
    const projectRoot = join(tmpdir(), `lsp-mcp-ws-${id}`);
    mkdirSync(projectRoot, { recursive: true });
    const pool = new ServerPool(projectRoot, this.registry);
    const ws: Workspace = { id, projectRoot, pool, lastUsed: Date.now() };
    this.workspaces.set(id, ws);
    process.stderr.write(`Workspace created: ${id} → ${projectRoot}\n`);
    return ws;
  }

  get(id: string): Workspace | undefined {
    const ws = this.workspaces.get(id);
    if (ws) ws.lastUsed = Date.now();
    return ws;
  }

  writeFile(wsId: string, filePath: string, content: string): void {
    const ws = this.workspaces.get(wsId);
    if (!ws) throw new Error(`Workspace not found or expired: ${wsId}`);
    const fullPath = join(ws.projectRoot, filePath);
    // Prevent path traversal
    if (!fullPath.startsWith(ws.projectRoot + sep)) {
      throw new Error(`Path traversal not allowed: ${filePath}`);
    }
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf-8");
    ws.lastUsed = Date.now();
  }

  private async cleanup(): Promise<void> {
    const now = Date.now();
    for (const [id, ws] of this.workspaces) {
      if (now - ws.lastUsed > this.ttlMs) {
        await ws.pool.stopAll();
        rmSync(ws.projectRoot, { recursive: true, force: true });
        this.workspaces.delete(id);
        process.stderr.write(`Workspace expired and removed: ${id}\n`);
      }
    }
  }

  async stopAll(): Promise<void> {
    clearInterval(this.cleanupTimer);
    for (const ws of this.workspaces.values()) {
      await ws.pool.stopAll();
      rmSync(ws.projectRoot, { recursive: true, force: true });
    }
    this.workspaces.clear();
  }
}

// ── MCP server factory (HTTP workspace mode) ─────────────────

function buildHttpMcpServer(manager: WorkspaceManager, registry: LanguageRegistry): McpServer {
  const server = new McpServer({ name: "lsp-intellisense", version: "2.0.0" });

  const ttlHours = Number(process.env.LSP_MCP_WS_TTL_HOURS ?? "1");

  // ── Tool: create_workspace ───────────────────────────────

  server.tool(
    "create_workspace",
    `Create a temporary workspace on the server for your project files.
Returns a workspace_id that must be passed to all other tools.
The workspace is automatically deleted after ${ttlHours} hour(s) of inactivity.
Call this once at the start of a session, then use write_file to upload your sources.`,
    {},
    async () => {
      try {
        const ws = manager.create();
        const expiresIn = `${ttlHours}h of inactivity`;
        return {
          content: [{
            type: "text" as const,
            text: [
              `Workspace created successfully.`,
              `workspace_id: ${ws.id}`,
              `Auto-expires after: ${expiresIn}`,
              ``,
              `Next step: use write_file to upload your source files, then run diagnose_file or other analysis tools.`,
            ].join("\n"),
          }],
        };
      } catch (e: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  // ── Tool: write_file ─────────────────────────────────────

  server.tool(
    "write_file",
    `Upload a source file to the workspace so LSP tools can analyze it.
Use this to populate the workspace before calling diagnose_file, get_hover, etc.
The path is relative to the workspace root (e.g. 'src/main.cpp', 'app/models.py').
For multi-file projects call this once per file, preserving the original directory structure.`,
    {
      workspace_id: z.string().describe("Workspace ID returned by create_workspace"),
      path: z.string().describe("File path relative to workspace root, e.g. 'src/main.cpp'"),
      content: z.string().describe("Full text content of the file"),
    },
    async ({ workspace_id, path, content }) => {
      try {
        manager.writeFile(workspace_id, path, content);
        return { content: [{ type: "text" as const, text: `File written: ${path}` }] };
      } catch (e: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  // ── Helper: resolve workspace pool ───────────────────────

  function getPool(workspace_id: string): { pool: ServerPool; projectRoot: string } {
    const ws = manager.get(workspace_id);
    if (!ws) {
      throw new Error(
        `Workspace not found or expired: ${workspace_id}. ` +
        `Call create_workspace to create a new one.`
      );
    }
    return { pool: ws.pool, projectRoot: ws.projectRoot };
  }

  // ── Tool: diagnose_file ──────────────────────────────────

  server.tool(
    "diagnose_file",
    `Get all compiler/linter errors, warnings, and hints for a source file.
The correct language server is auto-selected by file extension.
Supported: C/C++/CUDA (clangd), Python (pyright/pylsp), TypeScript/JS, Go, Rust, Java, Kotlin, Lua, Bash, Zig, CSS, HTML, JSON.`,
    {
      workspace_id: z.string().describe("Workspace ID returned by create_workspace"),
      file: z.string().describe("File path relative to workspace root, e.g. 'src/main.cpp'"),
    },
    async ({ workspace_id, file }) => {
      try {
        const { pool } = getPool(workspace_id);
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
Shows a summary of total errors and warnings, then lists issues per file.`,
    {
      workspace_id: z.string().describe("Workspace ID returned by create_workspace"),
    },
    async ({ workspace_id }) => {
      try {
        const { pool, projectRoot } = getPool(workspace_id);
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
Line and character are 0-based. Works with any supported language.`,
    {
      workspace_id: z.string().describe("Workspace ID returned by create_workspace"),
      file: z.string().describe("File path relative to workspace root"),
      line: z.number().int().min(0).describe("0-based line number"),
      character: z.number().int().min(0).describe("0-based column number"),
    },
    async ({ workspace_id, file, line, character }) => {
      try {
        const { pool } = getPool(workspace_id);
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
Line and character are 0-based. Works with any supported language.`,
    {
      workspace_id: z.string().describe("Workspace ID returned by create_workspace"),
      file: z.string().describe("File path relative to workspace root"),
      line: z.number().int().min(0).describe("0-based line number"),
      character: z.number().int().min(0).describe("0-based column number"),
    },
    async ({ workspace_id, file, line, character }) => {
      try {
        const { pool } = getPool(workspace_id);
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
Line and character are 0-based. Works with any supported language.`,
    {
      workspace_id: z.string().describe("Workspace ID returned by create_workspace"),
      file: z.string().describe("File path relative to workspace root"),
      line: z.number().int().min(0).describe("0-based line number"),
      character: z.number().int().min(0).describe("0-based column number"),
    },
    async ({ workspace_id, file, line, character }) => {
      try {
        const { pool, projectRoot } = getPool(workspace_id);
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
Line and character are 0-based. Works with any supported language.`,
    {
      workspace_id: z.string().describe("Workspace ID returned by create_workspace"),
      file: z.string().describe("File path relative to workspace root"),
      line: z.number().int().min(0).describe("0-based line number"),
      character: z.number().int().min(0).describe("0-based column number"),
    },
    async ({ workspace_id, file, line, character }) => {
      try {
        const { pool, projectRoot } = getPool(workspace_id);
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
Works with any supported language.`,
    {
      workspace_id: z.string().describe("Workspace ID returned by create_workspace"),
      file: z.string().describe("File path relative to workspace root"),
    },
    async ({ workspace_id, file }) => {
      try {
        const { pool } = getPool(workspace_id);
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
    `List all supported language servers, their status (installed/missing), and supported file extensions.`,
    {},
    async () => {
      const all = registry.getAllServers();
      const lines = all.map((s) => {
        const status = s.available ? "✅ installed" : "❌ not found";
        const exts = s.config.extensions.join(", ");
        const hint = !s.available ? `\n    Install: ${s.config.installHint}` : "";
        return `• ${s.config.name} [${status}] — ${exts}${hint}`;
      });
      return {
        content: [{
          type: "text" as const,
          text: ["Language servers:", ...lines].join("\n"),
        }],
      };
    }
  );

  return server;
}

// ── MCP server factory (stdio single-project mode) ───────────

function buildStdioMcpServer(pool: ServerPool, projectRoot: string, registry: LanguageRegistry): McpServer {
  const server = new McpServer({ name: "lsp-intellisense", version: "2.0.0" });

  server.tool(
    "diagnose_file",
    `Get all compiler/linter errors, warnings, and hints for a source file.
Works with ANY supported language — the correct language server is auto-selected by file extension.
Supported: C/C++/CUDA (clangd), Python (pyright/pylsp), TypeScript/JS, Go, Rust, Java, Kotlin, Lua, Bash, Zig, CSS, HTML, JSON.
Use BEFORE writing code to check the current state, and AFTER editing to verify your changes.`,
    { file: z.string().describe("Path to the file relative to project root, e.g. 'src/main.cpp'") },
    async ({ file }) => {
      try {
        const client = await pool.getClient(file);
        const result = await client.getDiagnostics(file);
        return { content: [{ type: "text" as const, text: `[${client.serverName}] ` + formatDiagnostics(file, result.diagnostics) }] };
      } catch (e: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "diagnose_workspace",
    `Get diagnostics for ALL files opened during this session, across all language servers.`,
    {},
    async () => {
      try {
        return { content: [{ type: "text" as const, text: formatWorkspaceDiagnostics(pool.getAllDiagnostics(), projectRoot) }] };
      } catch (e: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_completions",
    `Get IntelliSense completions at a specific position in a source file.
Line and character are 0-based. Works with any supported language.`,
    {
      file: z.string().describe("File path relative to project root"),
      line: z.number().int().min(0).describe("0-based line number"),
      character: z.number().int().min(0).describe("0-based column number"),
    },
    async ({ file, line, character }) => {
      try {
        const client = await pool.getClient(file);
        return { content: [{ type: "text" as const, text: formatCompletions(await client.getCompletions(file, line, character)) }] };
      } catch (e: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_hover",
    `Get type information and documentation for a symbol at a position.
Line and character are 0-based. Works with any supported language.`,
    {
      file: z.string().describe("File path relative to project root"),
      line: z.number().int().min(0).describe("0-based line number"),
      character: z.number().int().min(0).describe("0-based column number"),
    },
    async ({ file, line, character }) => {
      try {
        const client = await pool.getClient(file);
        return { content: [{ type: "text" as const, text: formatHover(await client.getHover(file, line, character)) }] };
      } catch (e: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_definitions",
    `Jump to the definition of a symbol. Returns file paths and line numbers.
Line and character are 0-based. Works with any supported language.`,
    {
      file: z.string().describe("File path relative to project root"),
      line: z.number().int().min(0).describe("0-based line number"),
      character: z.number().int().min(0).describe("0-based column number"),
    },
    async ({ file, line, character }) => {
      try {
        const client = await pool.getClient(file);
        return { content: [{ type: "text" as const, text: formatDefinitions(await client.getDefinitions(file, line, character), projectRoot) }] };
      } catch (e: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "find_references",
    `Find all usages of a symbol across the project.
Line and character are 0-based. Works with any supported language.`,
    {
      file: z.string().describe("File path relative to project root"),
      line: z.number().int().min(0).describe("0-based line number"),
      character: z.number().int().min(0).describe("0-based column number"),
    },
    async ({ file, line, character }) => {
      try {
        const client = await pool.getClient(file);
        return { content: [{ type: "text" as const, text: formatReferences(await client.getReferences(file, line, character), projectRoot) }] };
      } catch (e: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_symbols",
    `List all symbols (classes, functions, variables, enums, etc.) defined in a file.
Works with any supported language.`,
    { file: z.string().describe("File path relative to project root") },
    async ({ file }) => {
      try {
        const client = await pool.getClient(file);
        return { content: [{ type: "text" as const, text: formatSymbols(await client.getDocumentSymbols(file)) }] };
      } catch (e: unknown) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(e)}` }], isError: true };
      }
    }
  );

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
        const status = runningSet.has(s.config.name) ? "🟢 running" : s.available ? "✅ installed" : "❌ not found";
        const exts = s.config.extensions.join(", ");
        const hint = !s.available ? `\n    Install: ${s.config.installHint}` : "";
        return `• ${s.config.name} [${status}] — ${exts}${hint}`;
      });
      return {
        content: [{
          type: "text" as const,
          text: [`Project: ${projectRoot}`, ``, `Language servers:`, ...lines].join("\n"),
        }],
      };
    }
  );

  return server;
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const { defaultProject, port } = parseArgs();
  const registry = new LanguageRegistry();

  if (port !== undefined) {
    // ── HTTP mode: workspace-based, zero server-side setup ──
    const ttlHours = Number(process.env.LSP_MCP_WS_TTL_HOURS ?? "1");
    const manager = new WorkspaceManager(registry, ttlHours);

    const shutdown = async () => {
      await manager.stopAll();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const reqUrl = new URL(req.url ?? "/", "http://localhost");
      if (reqUrl.pathname !== "/mcp" && reqUrl.pathname !== "/") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("MCP endpoint is at /mcp");
        return;
      }

      const server = buildHttpMcpServer(manager, registry);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    });

    httpServer.listen(port, () => {
      process.stderr.write(`LSP-MCP Server listening on http://0.0.0.0:${port}/mcp\n`);
      process.stderr.write(`Workspace TTL: ${ttlHours}h of inactivity\n`);
    });

  } else {
    // ── stdio mode: single project, Claude Code ─────────────
    const pool = new ServerPool(defaultProject, registry);
    const server = buildStdioMcpServer(pool, defaultProject, registry);

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
