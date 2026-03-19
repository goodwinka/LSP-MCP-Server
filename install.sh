#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# LSP-MCP Server — installation, build, and configuration script
# ─────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_INDEX="$SCRIPT_DIR/dist/index.js"

# ── Colors ────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

info()  { echo -e "${CYAN}ℹ${NC}  $*"; }
ok()    { echo -e "${GREEN}✔${NC}  $*"; }
warn()  { echo -e "${YELLOW}⚠${NC}  $*"; }
fail()  { echo -e "${RED}✖${NC}  $*"; }

# ── 1. Check Node.js ─────────────────────────────────────────

echo ""
echo -e "${BOLD}═══ LSP-MCP Server — Installation ═══${NC}"
echo ""

if ! command -v node &>/dev/null; then
    fail "Node.js not found. Install Node.js 18+:"
    echo "    https://nodejs.org/"
    echo "    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
    echo "    sudo apt install -y nodejs"
    exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    fail "Node.js $NODE_VERSION is too old. Node.js 18+ is required."
    exit 1
fi
ok "Node.js $(node -v)"

if ! command -v npm &>/dev/null; then
    fail "npm not found."
    exit 1
fi
ok "npm $(npm -v)"

# ── 2. Build ─────────────────────────────────────────────────

info "Installing dependencies..."
cd "$SCRIPT_DIR"
npm install --no-fund --no-audit 2>&1 | tail -1
ok "Dependencies installed"

info "Building TypeScript..."
npm run build 2>&1 | tail -1
if [ -f "$DIST_INDEX" ]; then
    ok "Build complete: $DIST_INDEX"
else
    fail "Build failed: $DIST_INDEX not found"
    exit 1
fi

# ── 3. Check LSP servers ──────────────────────────────────────

echo ""
echo -e "${BOLD}── Installed LSP servers ──${NC}"
echo ""

check_cmd() {
    local name="$1"
    local cmd="$2"
    local hint="$3"
    if command -v "$cmd" &>/dev/null; then
        ok "$name ($cmd)"
        return 0
    else
        fail "$name — not found"
        echo -e "    ${YELLOW}Install: $hint${NC}"
        return 1
    fi
}

MISSING=0

check_cmd "C/C++/CUDA"    "clangd"                     "sudo apt install clangd  |  brew install llvm"                || ((MISSING++))
check_cmd "Python"         "pyright-langserver"          "npm i -g pyright  |  pip install pyright"                     || ((MISSING++))
check_cmd "TypeScript/JS"  "typescript-language-server"  "npm i -g typescript-language-server typescript"               || ((MISSING++))
check_cmd "Go"             "gopls"                       "go install golang.org/x/tools/gopls@latest"                   || ((MISSING++))
check_cmd "Rust"           "rust-analyzer"               "rustup component add rust-analyzer"                           || ((MISSING++))
check_cmd "Bash"           "bash-language-server"        "npm i -g bash-language-server"                                || ((MISSING++))
check_cmd "Lua"            "lua-language-server"         "brew install lua-language-server"                             || ((MISSING++))
check_cmd "CMake"          "cmake-language-server"       "pip install cmake-language-server"                            || ((MISSING++))

if [ "$MISSING" -gt 0 ]; then
    echo ""
    warn "Missing servers: $MISSING (install only what you need)"
fi

# ── 4. Check CUDA ─────────────────────────────────────────────

echo ""
echo -e "${BOLD}── CUDA Toolkit ──${NC}"
echo ""

CUDA_FOUND=false

if command -v nvcc &>/dev/null; then
    ok "nvcc $(nvcc --version 2>/dev/null | grep 'release' | sed 's/.*release //' | sed 's/,.*//')"
    CUDA_FOUND=true
else
    warn "nvcc not found — CUDA C++ IntelliSense may be limited"
    echo -e "    ${YELLOW}Install: https://developer.nvidia.com/cuda-downloads${NC}"
fi

if [ -d "/usr/local/cuda" ]; then
    ok "CUDA path: /usr/local/cuda"
    CUDA_FOUND=true
elif [ -d "/opt/cuda" ]; then
    ok "CUDA path: /opt/cuda"
    CUDA_FOUND=true
fi

if command -v nvidia-smi &>/dev/null; then
    GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || echo "unknown")
    ok "GPU: $GPU_NAME"
fi

# Check Python CUDA libraries
echo ""
if command -v python3 &>/dev/null; then
    for pkg in cupy numba pycuda; do
        if python3 -c "import $pkg" 2>/dev/null; then
            ok "Python: $pkg"
        fi
    done
fi

# ── 5. Generate .mcp.json ─────────────────────────────────────

echo ""
echo -e "${BOLD}── MCP Configuration ──${NC}"
echo ""

generate_mcp_json() {
    local target_dir="$1"
    local mcp_file="$target_dir/.mcp.json"

    if [ -f "$mcp_file" ]; then
        warn "$mcp_file already exists"
        read -rp "    Overwrite? [y/N] " answer
        if [[ ! "$answer" =~ ^[Yy]$ ]]; then
            info "Skipping"
            return
        fi
    fi

    cat > "$mcp_file" << MCPEOF
{
  "mcpServers": {
    "intellisense": {
      "command": "node",
      "args": ["$DIST_INDEX", "--project", "."]
    }
  }
}
MCPEOF

    ok "Created $mcp_file"
}

read -rp "Generate .mcp.json for your project? [Y/n] " gen_answer
if [[ ! "$gen_answer" =~ ^[Nn]$ ]]; then
    read -rp "Project path (Enter = current directory): " project_path
    project_path="${project_path:-.}"
    project_path="$(cd "$project_path" 2>/dev/null && pwd || echo "$project_path")"

    if [ -d "$project_path" ]; then
        generate_mcp_json "$project_path"
    else
        fail "Directory not found: $project_path"
    fi
fi

# ── 6. Global CLAUDE.md ───────────────────────────────────────

GLOBAL_CLAUDE_DIR="$HOME/.claude"
GLOBAL_CLAUDE_MD="$GLOBAL_CLAUDE_DIR/CLAUDE.md"
LSP_MARKER="# LSP-MCP IntelliSense"

echo ""
echo -e "${BOLD}── Global CLAUDE.md ──${NC}"
echo ""

if grep -qF "$LSP_MARKER" "$GLOBAL_CLAUDE_MD" 2>/dev/null; then
    ok "LSP-MCP instructions already present in $GLOBAL_CLAUDE_MD"
else
    read -rp "Add LSP IntelliSense auto-setup to global CLAUDE.md (~/.claude/CLAUDE.md)? [Y/n] " claude_answer
    if [[ ! "$claude_answer" =~ ^[Nn]$ ]]; then
        mkdir -p "$GLOBAL_CLAUDE_DIR"
        { echo ""; sed "s|__LSP_MCP_SERVER_PATH__|$SCRIPT_DIR|g" "$SCRIPT_DIR/CLAUDE.md.example"; echo ""; } >> "$GLOBAL_CLAUDE_MD"
        ok "Added to $GLOBAL_CLAUDE_MD"
        info "On next Claude Code launch in any project, the server will be configured automatically"
    else
        info "Skipped. To add manually:"
        info "  sed \"s|__LSP_MCP_SERVER_PATH__|$SCRIPT_DIR|g\" '$SCRIPT_DIR/CLAUDE.md.example' >> ~/.claude/CLAUDE.md"
    fi
fi

# ── 7. Summary ────────────────────────────────────────────────

echo ""
echo -e "${BOLD}═══ Done! ═══${NC}"
echo ""
echo "Server built: $DIST_INDEX"
echo ""
echo "Usage:"
echo "  1. Global CLAUDE.md (~/.claude/CLAUDE.md) — auto-setup in every project"
echo "  2. Or .mcp.json in the project root (created by install.sh or manually)"
echo "  3. Launch Claude Code in the project directory"
echo ""
echo "Manual launch:"
echo "  node $DIST_INDEX --project /path/to/project"
echo ""

if [ "$CUDA_FOUND" = true ]; then
    echo -e "${CYAN}CUDA:${NC} For IntelliSense in .cu files, create compile_commands.json"
    echo "  cmake -DCMAKE_CUDA_COMPILER=nvcc -DCMAKE_EXPORT_COMPILE_COMMANDS=ON .."
    echo ""
fi
