/**
 * Server Pool — lazily spawns and caches one LSP client per language server.
 *
 * When a file is opened, the pool looks up the right LSP server by extension,
 * starts it if needed, and returns the client.
 */

import { extname } from "node:path";
import { LspClient } from "./lsp-client.js";
import { LanguageRegistry } from "./language-registry.js";

export class ServerPool {
  private clients = new Map<string, LspClient>(); // keyed by server name
  private registry: LanguageRegistry;
  private projectRoot: string;

  constructor(projectRoot: string, registry: LanguageRegistry) {
    this.projectRoot = projectRoot;
    this.registry = registry;
  }

  /**
   * Get (or create) the LSP client for a given file.
   * Throws if no server is configured or installed for this file type.
   */
  async getClient(filePath: string): Promise<LspClient> {
    const ext = extname(filePath).toLowerCase();
    const config = this.registry.findServer(ext);

    if (!config) {
      throw new Error(
        `No language server configured for '${ext}' files.\n` +
        `Supported: ${this.registry.getSupportedExtensions().join(", ")}`
      );
    }

    if (!this.registry.isAvailable(config)) {
      throw new Error(
        `Language server '${config.name}' is not installed.\n` +
        `Install it: ${config.installHint}`
      );
    }

    let client = this.clients.get(config.name);
    if (!client) {
      client = new LspClient(this.projectRoot, config);
      this.clients.set(config.name, client);
      await client.start();
    }
    return client;
  }

  /** Collect diagnostics from all running LSP clients */
  getAllDiagnostics(): { serverName: string; uri: string; diagnostics: import("vscode-languageserver-protocol").Diagnostic[] }[] {
    const result = [];
    for (const [name, client] of this.clients) {
      for (const entry of client.getAllDiagnostics()) {
        result.push({ serverName: name, ...entry });
      }
    }
    return result;
  }

  /** List all running servers */
  getRunningServers(): { name: string; running: boolean }[] {
    return [...this.clients.entries()].map(([name, client]) => ({
      name,
      running: client.isRunning,
    }));
  }

  /** Stop all servers */
  async stopAll(): Promise<void> {
    const stops = [...this.clients.values()].map((c) => c.stop());
    await Promise.allSettled(stops);
    this.clients.clear();
  }
}
