# LSP-MCP Server — Universal IntelliSense for LLMs

An MCP server that automatically connects the right **Language Server** (clangd, pyright, tsserver, gopls, rust-analyzer…) and gives Claude Code full IntelliSense for **any language**, including **CUDA**: error diagnostics, completions, type info, and code navigation.

## Supported Languages

| Language | LSP server | Extensions |
|---|---|---|
| C / C++ / Qt / CUDA | clangd | .c .h .cpp .cxx .cc .hpp .hxx .hh .ipp .cu .cuh |
| Python | pyright / pylsp | .py .pyi |
| TypeScript / JavaScript | typescript-language-server | .ts .tsx .js .jsx .mjs .cjs |
| Go | gopls | .go |
| Rust | rust-analyzer | .rs |
| Java | jdtls | .java |
| Kotlin | kotlin-language-server | .kt .kts |
| Zig | zls | .zig |
| Lua | lua-language-server | .lua |
| Bash / Shell | bash-language-server | .sh .bash .zsh |
| CSS / SCSS / LESS | vscode-css-languageserver | .css .scss .less |
| HTML | vscode-html-languageserver | .html .htm |
| JSON | vscode-json-languageserver | .json .jsonc |
| CMake | cmake-language-server | .cmake |

The server **automatically selects** the right LSP by file extension. Open a `.cpp` file — clangd starts. Open a `.py` file — pyright starts. Everything is transparent.

## How It Works

```
Claude Code  ──(MCP/stdio)──►  lsp-mcp-server  ──(LSP/JSON-RPC)──►  clangd
                                       │                              pyright
                                       │                              tsserver
                                       └── ServerPool ──────────────► gopls
                                            (lazy start,               rust-analyzer
                                             one per language)         ...
```

The LLM can:
1. **Before writing** — query function signatures via `get_completions` and `get_hover`
2. **After writing** — run `diagnose_file` or `diagnose_workspace` to see errors
3. **During refactoring** — find all usages via `find_references`

## Installation

### 1. Build the server

```bash
cd lsp-mcp-server
npm install
npm run build      # compile TypeScript → dist/
# or for development without a build step:
npm run dev        # run directly via tsx
```

### 2. Install the language servers you need

Install only the ones relevant to your project:

```bash
# C++ / Qt
sudo apt install clangd-18          # or: brew install llvm

# Python
npm install -g pyright               # or: pip install pyright

# TypeScript / JavaScript
npm install -g typescript-language-server typescript

# Go
go install golang.org/x/tools/gopls@latest

# Rust
rustup component add rust-analyzer

# Bash
npm install -g bash-language-server

# CSS / HTML / JSON
npm install -g vscode-langservers-extracted

# CMake
pip install cmake-language-server
# Note: works with .cmake files only, not CMakeLists.txt directly

# Lua
brew install lua-language-server         # macOS
# Linux: download from https://github.com/LuaLS/lua-language-server/releases

# Java (Eclipse JDT LS)
# Download and install: https://github.com/eclipse-jdtls/eclipse.jdt.ls/releases
# Make sure the `jdtls` command is available in PATH

# Kotlin
# Download from https://github.com/fwcd/kotlin-language-server/releases
# Make sure `kotlin-language-server` is available in PATH

# Zig
# Download from https://github.com/zigtools/zls/releases
# Make sure `zls` is available in PATH
```

Use the `list_servers` tool to see what is installed.

### 3. Connect to Claude Code

**Option A: Project config** (`.mcp.json` in the project root)

```json
{
  "mcpServers": {
    "intellisense": {
      "command": "node",
      "args": ["/absolute/path/to/lsp-mcp-server/dist/index.js", "--project", "."]
    }
  }
}
```

**Option B: Global config** (`~/.claude/claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "intellisense": {
      "command": "node",
      "args": [
        "/absolute/path/to/lsp-mcp-server/dist/index.js",
        "--project", "/path/to/your/project"
      ]
    }
  }
}
```

**Option C: Environment variables**

```json
{
  "mcpServers": {
    "intellisense": {
      "command": "node",
      "args": ["/absolute/path/to/lsp-mcp-server/dist/index.js"],
      "env": {
        "LSP_PROJECT_ROOT": "/path/to/your/project",
        "LSP_MCP_DEBUG": "1"
      }
    }
  }
}
```

## Available Tools

| Tool | Description |
|---|---|
| `diagnose_file` | Compiler errors/warnings for a file on disk |
| `diagnose_workspace` | Errors/warnings for all files opened in the current session, across all language servers |
| `get_completions` | Completions at a given position |
| `get_hover` | Type and documentation for a symbol |
| `get_definitions` | Jump to symbol definition |
| `find_references` | Find all usages of a symbol in the project |
| `get_symbols` | Symbol tree for a file |
| `list_servers` | Show all languages, server status (installed / running) |

### diagnose_workspace

Returns a workspace-wide diagnostics summary in one call, without requiring file content. Reports total errors and warnings, the number of affected files, and per-file details.

Example output when clean:
```
✅ Workspace clean — 3 file(s) checked, no errors or warnings
```

Example output with issues:
```
Found 2 error(s), 1 warning(s) across 1/3 file(s):

Found 2 diagnostic(s) in src/main.cpp:

ERROR src/main.cpp:12:5 [clang]: no member named 'nonExistent' in 'QWidget'
WARN  src/main.cpp:8:3 [clang]: unused variable 'x'
```

## Usage Examples

```
> Check src/mainwindow.cpp for errors
  → [clangd] diagnose_file("src/mainwindow.cpp")

> Check all open files for errors
  → diagnose_workspace()

> Check app/models.py
  → [pyright] diagnose_file("app/models.py")

> What methods does QTableView have?
  → get_completions on a .cpp file with QTableView*

> Show the signature of pandas.read_csv
  → get_hover on a .py file

> What servers are available?
  → list_servers
```

## Tips for C++ / Qt

clangd works best with a `compile_commands.json` in the project root:

```bash
# CMake
cmake -DCMAKE_EXPORT_COMPILE_COMMANDS=ON ..

# qmake via Bear
bear -- make

# Or manually — create a .clangd file in the project root:
cat > .clangd << 'EOF'
CompileFlags:
  Add:
    - -std=c++17
    - -I/usr/include/qt6
    - -I/usr/include/qt6/QtCore
    - -I/usr/include/qt6/QtWidgets
    - -I/usr/include/qt6/QtGui
    - -fPIC
EOF
```

## Tips for CUDA

### CUDA C++ (.cu, .cuh)

clangd supports CUDA natively (it is based on clang). You need the CUDA Toolkit installed:

```bash
# Verify installation
nvcc --version
```

For best IntelliSense results, generate a `compile_commands.json`:

```bash
# CMake with CUDA
cmake -DCMAKE_CUDA_COMPILER=nvcc -DCMAKE_EXPORT_COMPILE_COMMANDS=ON ..
```

Or create a `.clangd` file in the project root:

```yaml
CompileFlags:
  Add:
    - --cuda-gpu-arch=sm_75
    - --cuda-path=/usr/local/cuda
    - -I/usr/local/cuda/include
    - -std=c++17
```

### CUDA Python (CuPy, Numba, PyCUDA)

Python CUDA libraries work through the standard pyright — no special setup needed.
For improved type checking, install the stubs:

```bash
# CuPy — stubs are bundled in the package
pip install cupy-cuda12x    # or cupy-cuda11x

# Numba
pip install numba

# PyCUDA
pip install pycuda
```

Pyright will automatically pick up types from installed packages.

## Tips for Python

Pyright automatically reads `pyrightconfig.json` and `pyproject.toml`. For virtual environments, either activate the `venv` before starting, or specify the path in the config.

## CLI

```
--project, -p <path>    Path to the project root (required)
--help, -h              Show help and exit
```

## Environment Variables

| Variable | Description |
|---|---|
| `LSP_PROJECT_ROOT` | Project path (if `--project` is not set) |
| `LSP_MCP_DEBUG=1` | Print language server stderr to stdout |

## Troubleshooting

### Which server is selected for my file?

Use the `list_servers` tool — it shows all servers, their status, and supported extensions. The server is selected automatically by file extension.

### Both pyright and pylsp are installed

**pyright** is listed first in the registry and will be used for `.py` files. To use pylsp instead, remove or rename `pyright-langserver`.

### CMakeLists.txt is not diagnosed

`cmake-language-server` only attaches to `.cmake` files. `CMakeLists.txt` is not supported — this is a limitation of the current extension-based language detection.

### Server started but no diagnostics appear

Enable debug output (`LSP_MCP_DEBUG=1`) and inspect the language server's stderr. For C++ projects, make sure `compile_commands.json` or a `.clangd` file exists.

### Error "path is outside project root"

All file paths must be **relative to the project root** specified in `--project`. Absolute paths are not accepted.

## License

MIT
