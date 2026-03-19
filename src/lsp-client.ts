/**
 * LSP Client — manages a single language server process.
 *
 * Generic: works with clangd, pyright, typescript-language-server, gopls,
 * rust-analyzer, and any other LSP-compliant server.
 */

import { spawn, ChildProcess } from "node:child_process";
import { resolve, extname, sep } from "node:path";
import { readFile } from "node:fs/promises";
import {
  createProtocolConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-languageserver-protocol/node.js";
import {
  InitializeRequest,
  InitializeParams,
  DidOpenTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidChangeTextDocumentNotification,
  CompletionRequest,
  HoverRequest,
  DefinitionRequest,
  ReferencesRequest,
  DocumentSymbolRequest,
  PublishDiagnosticsNotification,
  CompletionTriggerKind,
  type Diagnostic,
  type CompletionItem,
  type Hover,
  type Location,
  type DocumentSymbol,
  type SymbolInformation,
  type ProtocolConnection,
  ShutdownRequest,
  ExitNotification,
} from "vscode-languageserver-protocol";
import type { LspServerConfig } from "./language-registry.js";

export interface DiagnosticResult {
  file: string;
  diagnostics: Diagnostic[];
}

// ── Constants ───────────────────────────────────────────────

const DIAGNOSTICS_TIMEOUT_MS = 8000;
const DIAGNOSTICS_POLL_INTERVAL_MS = 200;
const DIAGNOSTICS_INITIAL_DELAY_MS = 500;
const MAX_OPEN_DOCUMENTS = 50;

export class LspClient {
  private process: ChildProcess | null = null;
  private connection: ProtocolConnection | null = null;
  private projectRoot: string;
  private config: LspServerConfig;
  private extraArgs: string[];
  private openDocuments = new Map<string, { version: number; content: string }>();
  private diagnosticsStore = new Map<string, Diagnostic[]>();
  private initialized = false;
  private initializing: Promise<void> | null = null;
  private documentLocks = new Map<string, Promise<void>>();

  constructor(projectRoot: string, config: LspServerConfig, extraArgs: string[] = []) {
    this.projectRoot = resolve(projectRoot);
    this.config = config;
    this.extraArgs = extraArgs;
  }

  get serverName(): string {
    return this.config.name;
  }

  // ── Lifecycle ──────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.initialized) return;
    if (this.initializing) return this.initializing;
    this.initializing = this._doStart();
    await this.initializing;
    this.initializing = null;
  }

  private async _doStart(): Promise<void> {
    const args = [...this.config.args, ...this.extraArgs];

    this.process = spawn(this.config.command, args, {
      cwd: this.projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.on("error", (err) => {
      console.error(`[lsp-mcp] ${this.config.name} failed to start: ${err.message}`);
    });

    this.process.on("exit", (code) => {
      console.error(`[lsp-mcp] ${this.config.name} exited with code ${code}`);
      this.initialized = false;
      this.connection = null;
      this.process = null;
      this.openDocuments.clear();
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      if (process.env.LSP_MCP_DEBUG) {
        process.stderr.write(`[${this.config.name}] ${data.toString()}`);
      }
    });

    const reader = new StreamMessageReader(this.process.stdout!);
    const writer = new StreamMessageWriter(this.process.stdin!);
    this.connection = createProtocolConnection(reader, writer);

    this.connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
      this.diagnosticsStore.set(params.uri, params.diagnostics);
    });

    this.connection.listen();

    const initParams: InitializeParams = {
      processId: process.pid ?? null,
      rootUri: `file://${this.projectRoot}`,
      capabilities: {
        textDocument: {
          completion: {
            completionItem: {
              snippetSupport: true,
              documentationFormat: ["plaintext", "markdown"],
            },
          },
          hover: { contentFormat: ["plaintext", "markdown"] },
          synchronization: { didSave: true, dynamicRegistration: false },
        },
        workspace: { workspaceFolders: true },
      },
      workspaceFolders: [
        { uri: `file://${this.projectRoot}`, name: "project" },
      ],
    };

    await this.connection.sendRequest(InitializeRequest.type, initParams);
    this.connection.sendNotification("initialized", {});
    this.initialized = true;
  }

  async stop(): Promise<void> {
    if (!this.connection || !this.process) return;
    try {
      await this.connection.sendRequest(ShutdownRequest.type);
      this.connection.sendNotification(ExitNotification.type);
    } catch (e: unknown) {
      console.error(`[lsp-mcp] ${this.config.name} shutdown error:`, e instanceof Error ? e.message : String(e));
    }
    this.connection.dispose();
    this.process.kill();
    this.process = null;
    this.connection = null;
    this.initialized = false;
  }

  // ── Document management ────────────────────────────────────

  private assertConnection(): ProtocolConnection {
    if (!this.connection) {
      throw new Error(`Language server '${this.config.name}' is not connected`);
    }
    return this.connection;
  }

  private validatePath(filePath: string): string {
    const absPath = resolve(this.projectRoot, filePath);
    const normalizedRoot = this.projectRoot.endsWith(sep) ? this.projectRoot : this.projectRoot + sep;
    if (absPath !== this.projectRoot && !absPath.startsWith(normalizedRoot)) {
      throw new Error(`Path '${filePath}' is outside project root`);
    }
    return absPath;
  }

  private fileUri(filePath: string): string {
    const abs = this.validatePath(filePath);
    return `file://${abs}`;
  }

  private languageId(filePath: string): string {
    const ext = extname(filePath).toLowerCase();
    return this.config.languageIds[ext] ?? "plaintext";
  }

  private async withDocumentLock<T>(uri: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.documentLocks.get(uri) ?? Promise.resolve();
    let releaseFn: () => void;
    const next = new Promise<void>((resolve) => { releaseFn = resolve; });
    this.documentLocks.set(uri, next);
    await prev;
    try {
      return await fn();
    } finally {
      releaseFn!();
    }
  }

  private evictOldDocuments(): void {
    if (this.openDocuments.size <= MAX_OPEN_DOCUMENTS) return;
    const conn = this.connection;
    if (!conn) return;
    const uris = [...this.openDocuments.keys()];
    const toEvict = uris.slice(0, uris.length - MAX_OPEN_DOCUMENTS);
    for (const uri of toEvict) {
      conn.sendNotification(DidCloseTextDocumentNotification.type, {
        textDocument: { uri },
      });
      this.openDocuments.delete(uri);
      this.diagnosticsStore.delete(uri);
    }
  }

  async ensureOpen(filePath: string): Promise<string> {
    await this.start();
    const conn = this.assertConnection();
    const uri = this.fileUri(filePath);
    return this.withDocumentLock(uri, async () => {
      if (!this.openDocuments.has(uri)) {
        const absPath = this.validatePath(filePath);
        const content = await readFile(absPath, "utf-8");
        this.openDocuments.set(uri, { version: 1, content });
        conn.sendNotification(DidOpenTextDocumentNotification.type, {
          textDocument: {
            uri,
            languageId: this.languageId(filePath),
            version: 1,
            text: content,
          },
        });
        this.evictOldDocuments();
      }
      return uri;
    });
  }

  async updateDocument(filePath: string, content: string): Promise<string> {
    await this.start();
    const conn = this.assertConnection();
    const uri = this.fileUri(filePath);
    return this.withDocumentLock(uri, async () => {
      const existing = this.openDocuments.get(uri);
      if (existing) {
        existing.version++;
        existing.content = content;
        conn.sendNotification(DidChangeTextDocumentNotification.type, {
          textDocument: { uri, version: existing.version },
          contentChanges: [{ text: content }],
        });
      } else {
        this.openDocuments.set(uri, { version: 1, content });
        conn.sendNotification(DidOpenTextDocumentNotification.type, {
          textDocument: {
            uri,
            languageId: this.languageId(filePath),
            version: 1,
            text: content,
          },
        });
        this.evictOldDocuments();
      }
      return uri;
    });
  }

  async closeDocument(filePath: string): Promise<void> {
    const uri = this.fileUri(filePath);
    if (this.openDocuments.has(uri) && this.connection) {
      this.connection.sendNotification(DidCloseTextDocumentNotification.type, {
        textDocument: { uri },
      });
      this.openDocuments.delete(uri);
    }
  }

  // ── LSP features ───────────────────────────────────────────

  async getDiagnostics(filePath: string): Promise<DiagnosticResult> {
    const uri = await this.ensureOpen(filePath);
    await this.waitForDiagnostics(uri, DIAGNOSTICS_TIMEOUT_MS);
    return { file: filePath, diagnostics: this.diagnosticsStore.get(uri) ?? [] };
  }

  async getCompletions(filePath: string, line: number, character: number): Promise<CompletionItem[]> {
    const uri = await this.ensureOpen(filePath);
    const conn = this.assertConnection();
    const result = await conn.sendRequest(CompletionRequest.type, {
      textDocument: { uri },
      position: { line, character },
      context: { triggerKind: CompletionTriggerKind.Invoked },
    });
    if (!result) return [];
    return Array.isArray(result) ? result : result.items;
  }

  async getHover(filePath: string, line: number, character: number): Promise<Hover | null> {
    const uri = await this.ensureOpen(filePath);
    const conn = this.assertConnection();
    return await conn.sendRequest(HoverRequest.type, {
      textDocument: { uri },
      position: { line, character },
    });
  }

  async getDefinitions(filePath: string, line: number, character: number): Promise<Location[]> {
    const uri = await this.ensureOpen(filePath);
    const conn = this.assertConnection();
    const result = await conn.sendRequest(DefinitionRequest.type, {
      textDocument: { uri },
      position: { line, character },
    });
    if (!result) return [];
    if (!Array.isArray(result)) return [result as Location];
    return result.filter((r): r is Location => "uri" in r && "range" in r);
  }

  async getReferences(filePath: string, line: number, character: number): Promise<Location[]> {
    const uri = await this.ensureOpen(filePath);
    const conn = this.assertConnection();
    const result = await conn.sendRequest(ReferencesRequest.type, {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration: true },
    });
    return result ?? [];
  }

  async getDocumentSymbols(filePath: string): Promise<(DocumentSymbol | SymbolInformation)[]> {
    const uri = await this.ensureOpen(filePath);
    const conn = this.assertConnection();
    const result = await conn.sendRequest(DocumentSymbolRequest.type, {
      textDocument: { uri },
    });
    return result ?? [];
  }

  // ── Helpers ────────────────────────────────────────────────

  private waitForDiagnostics(uri: string, timeoutMs: number): Promise<void> {
    return new Promise((res) => {
      const start = Date.now();
      const check = () => {
        if (this.diagnosticsStore.has(uri) || Date.now() - start > timeoutMs) {
          res();
        } else {
          setTimeout(check, DIAGNOSTICS_POLL_INTERVAL_MS);
        }
      };
      setTimeout(check, DIAGNOSTICS_INITIAL_DELAY_MS);
    });
  }

  get isRunning(): boolean {
    return this.initialized;
  }
}
