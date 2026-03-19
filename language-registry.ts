/**
 * Language Server Registry
 *
 * Maps file extensions to LSP server configurations.
 * Auto-detects which servers are installed on the system.
 */

import { execFileSync } from "node:child_process";

export interface LspServerConfig {
  /** Human-readable name */
  name: string;
  /** Command to run */
  command: string;
  /** Default arguments */
  args: string[];
  /** File extensions this server handles (with dot) */
  extensions: string[];
  /** LSP language IDs */
  languageIds: Record<string, string>;
  /** How to install (shown in error messages) */
  installHint: string;
}

/**
 * Built-in server definitions.
 * Users can override/extend via --lang config.
 */
export const BUILTIN_SERVERS: LspServerConfig[] = [
  {
    name: "clangd",
    command: "clangd",
    args: [
      "--background-index",
      "--clang-tidy",
      "--completion-style=detailed",
      "--header-insertion=iwyu",
      "--pch-storage=memory",
    ],
    extensions: [".c", ".h", ".cpp", ".cxx", ".cc", ".hpp", ".hxx", ".hh", ".ipp"],
    languageIds: {
      ".c": "c",
      ".h": "cpp",
      ".cpp": "cpp",
      ".cxx": "cpp",
      ".cc": "cpp",
      ".hpp": "cpp",
      ".hxx": "cpp",
      ".hh": "cpp",
      ".ipp": "cpp",
    },
    installHint: "sudo apt install clangd  |  brew install llvm",
  },
  {
    name: "pyright",
    command: "pyright-langserver",
    args: ["--stdio"],
    extensions: [".py", ".pyi"],
    languageIds: { ".py": "python", ".pyi": "python" },
    installHint: "npm install -g pyright  |  pip install pyright",
  },
  {
    name: "pylsp",
    command: "pylsp",
    args: [],
    extensions: [".py", ".pyi"],
    languageIds: { ".py": "python", ".pyi": "python" },
    installHint: "pip install python-lsp-server",
  },
  {
    name: "typescript-language-server",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    languageIds: {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".jsx": "javascriptreact",
      ".mjs": "javascript",
      ".cjs": "javascript",
    },
    installHint: "npm install -g typescript-language-server typescript",
  },
  {
    name: "gopls",
    command: "gopls",
    args: ["serve"],
    extensions: [".go"],
    languageIds: { ".go": "go" },
    installHint: "go install golang.org/x/tools/gopls@latest",
  },
  {
    name: "rust-analyzer",
    command: "rust-analyzer",
    args: [],
    extensions: [".rs"],
    languageIds: { ".rs": "rust" },
    installHint: "rustup component add rust-analyzer",
  },
  {
    name: "lua-language-server",
    command: "lua-language-server",
    args: [],
    extensions: [".lua"],
    languageIds: { ".lua": "lua" },
    installHint: "brew install lua-language-server  |  https://github.com/LuaLS/lua-language-server",
  },
  {
    name: "bash-language-server",
    command: "bash-language-server",
    args: ["start"],
    extensions: [".sh", ".bash", ".zsh"],
    languageIds: { ".sh": "shellscript", ".bash": "shellscript", ".zsh": "shellscript" },
    installHint: "npm install -g bash-language-server",
  },
  {
    name: "cmake-language-server",
    command: "cmake-language-server",
    args: [],
    extensions: [".cmake"],
    languageIds: { ".cmake": "cmake" },
    installHint: "pip install cmake-language-server",
  },
  {
    name: "vscode-css-languageserver",
    command: "vscode-css-language-server",
    args: ["--stdio"],
    extensions: [".css", ".scss", ".less"],
    languageIds: { ".css": "css", ".scss": "scss", ".less": "less" },
    installHint: "npm install -g vscode-langservers-extracted",
  },
  {
    name: "vscode-html-languageserver",
    command: "vscode-html-language-server",
    args: ["--stdio"],
    extensions: [".html", ".htm"],
    languageIds: { ".html": "html", ".htm": "html" },
    installHint: "npm install -g vscode-langservers-extracted",
  },
  {
    name: "vscode-json-languageserver",
    command: "vscode-json-language-server",
    args: ["--stdio"],
    extensions: [".json", ".jsonc"],
    languageIds: { ".json": "json", ".jsonc": "jsonc" },
    installHint: "npm install -g vscode-langservers-extracted",
  },
  {
    name: "jdtls",
    command: "jdtls",
    args: [],
    extensions: [".java"],
    languageIds: { ".java": "java" },
    installHint: "https://github.com/eclipse-jdtls/eclipse.jdt.ls",
  },
  {
    name: "kotlin-language-server",
    command: "kotlin-language-server",
    args: [],
    extensions: [".kt", ".kts"],
    languageIds: { ".kt": "kotlin", ".kts": "kotlin" },
    installHint: "https://github.com/fwcd/kotlin-language-server",
  },
  {
    name: "zls",
    command: "zls",
    args: [],
    extensions: [".zig"],
    languageIds: { ".zig": "zig" },
    installHint: "https://github.com/zigtools/zls/releases",
  },
];

/** Check if a command exists on the system */
function commandExists(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export interface ResolvedServer {
  config: LspServerConfig;
  available: boolean;
}

export class LanguageRegistry {
  private servers: LspServerConfig[] = [];
  private extensionMap = new Map<string, LspServerConfig>();
  private availabilityCache = new Map<string, boolean>();

  constructor(customServers?: LspServerConfig[]) {
    // Custom servers take priority
    if (customServers) {
      this.servers.push(...customServers);
    }
    this.servers.push(...BUILTIN_SERVERS);
    this.buildExtensionMap();
  }

  private buildExtensionMap(): void {
    // First registered wins for each extension
    for (const server of this.servers) {
      for (const ext of server.extensions) {
        if (!this.extensionMap.has(ext)) {
          this.extensionMap.set(ext, server);
        }
      }
    }
  }

  /** Find server config for a file extension */
  findServer(extension: string): LspServerConfig | undefined {
    return this.extensionMap.get(extension.toLowerCase());
  }

  /** Check if the server binary is installed */
  isAvailable(config: LspServerConfig): boolean {
    if (this.availabilityCache.has(config.command)) {
      return this.availabilityCache.get(config.command)!;
    }
    const exists = commandExists(config.command);
    this.availabilityCache.set(config.command, exists);
    return exists;
  }

  /** Get all unique servers with availability status */
  getAllServers(): ResolvedServer[] {
    const seen = new Set<string>();
    const result: ResolvedServer[] = [];
    for (const config of this.servers) {
      if (seen.has(config.name)) continue;
      seen.add(config.name);
      result.push({ config, available: this.isAvailable(config) });
    }
    return result;
  }

  /** Get language ID for a file extension */
  getLanguageId(extension: string): string {
    const server = this.findServer(extension);
    if (server) {
      return server.languageIds[extension.toLowerCase()] ?? "plaintext";
    }
    return "plaintext";
  }

  /** Get all supported extensions */
  getSupportedExtensions(): string[] {
    return [...this.extensionMap.keys()];
  }
}
