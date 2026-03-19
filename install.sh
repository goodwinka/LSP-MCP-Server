#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# LSP-MCP Server — скрипт установки, сборки и настройки
# ─────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_INDEX="$SCRIPT_DIR/dist/index.js"

# ── Цвета ────────────────────────────────────────────────────

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

# ── 1. Проверка Node.js ─────────────────────────────────────

echo ""
echo -e "${BOLD}═══ LSP-MCP Server — Установка ═══${NC}"
echo ""

if ! command -v node &>/dev/null; then
    fail "Node.js не найден. Установите Node.js 18+:"
    echo "    https://nodejs.org/"
    echo "    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
    echo "    sudo apt install -y nodejs"
    exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    fail "Node.js $NODE_VERSION слишком старый. Нужен Node.js 18+."
    exit 1
fi
ok "Node.js $(node -v)"

if ! command -v npm &>/dev/null; then
    fail "npm не найден."
    exit 1
fi
ok "npm $(npm -v)"

# ── 2. Сборка ───────────────────────────────────────────────

info "Установка зависимостей..."
cd "$SCRIPT_DIR"
npm install --no-fund --no-audit 2>&1 | tail -1
ok "Зависимости установлены"

info "Сборка TypeScript..."
npm run build 2>&1 | tail -1
if [ -f "$DIST_INDEX" ]; then
    ok "Сборка завершена: $DIST_INDEX"
else
    fail "Сборка не удалась: $DIST_INDEX не найден"
    exit 1
fi

# ── 3. Проверка LSP-серверов ─────────────────────────────────

echo ""
echo -e "${BOLD}── Установленные LSP-серверы ──${NC}"
echo ""

check_cmd() {
    local name="$1"
    local cmd="$2"
    local hint="$3"
    if command -v "$cmd" &>/dev/null; then
        ok "$name ($cmd)"
        return 0
    else
        fail "$name — не найден"
        echo -e "    ${YELLOW}Установить: $hint${NC}"
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
    warn "Не установлено серверов: $MISSING (устанавливайте только нужные)"
fi

# ── 4. Проверка CUDA ─────────────────────────────────────────

echo ""
echo -e "${BOLD}── CUDA Toolkit ──${NC}"
echo ""

CUDA_FOUND=false

if command -v nvcc &>/dev/null; then
    ok "nvcc $(nvcc --version 2>/dev/null | grep 'release' | sed 's/.*release //' | sed 's/,.*//')"
    CUDA_FOUND=true
else
    warn "nvcc не найден — CUDA C++ IntelliSense может работать ограниченно"
    echo -e "    ${YELLOW}Установить: https://developer.nvidia.com/cuda-downloads${NC}"
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

# Проверка Python CUDA библиотек
echo ""
if command -v python3 &>/dev/null; then
    for pkg in cupy numba pycuda; do
        if python3 -c "import $pkg" 2>/dev/null; then
            ok "Python: $pkg"
        fi
    done
fi

# ── 5. Генерация .mcp.json ──────────────────────────────────

echo ""
echo -e "${BOLD}── Настройка MCP ──${NC}"
echo ""

generate_mcp_json() {
    local target_dir="$1"
    local mcp_file="$target_dir/.mcp.json"

    if [ -f "$mcp_file" ]; then
        warn "$mcp_file уже существует"
        read -rp "    Перезаписать? [y/N] " answer
        if [[ ! "$answer" =~ ^[Yy]$ ]]; then
            info "Пропускаю"
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

    ok "Создан $mcp_file"
}

read -rp "Сгенерировать .mcp.json для проекта? [Y/n] " gen_answer
if [[ ! "$gen_answer" =~ ^[Nn]$ ]]; then
    read -rp "Путь к проекту (Enter = текущая директория): " project_path
    project_path="${project_path:-.}"
    project_path="$(cd "$project_path" 2>/dev/null && pwd || echo "$project_path")"

    if [ -d "$project_path" ]; then
        generate_mcp_json "$project_path"
    else
        fail "Директория не найдена: $project_path"
    fi
fi

# ── 6. Глобальный CLAUDE.md ───────────────────────────────────

GLOBAL_CLAUDE_DIR="$HOME/.claude"
GLOBAL_CLAUDE_MD="$GLOBAL_CLAUDE_DIR/CLAUDE.md"
LSP_MARKER="# LSP-MCP IntelliSense"

echo ""
echo -e "${BOLD}── Глобальный CLAUDE.md ──${NC}"
echo ""

if grep -qF "$LSP_MARKER" "$GLOBAL_CLAUDE_MD" 2>/dev/null; then
    ok "LSP-MCP инструкции уже есть в $GLOBAL_CLAUDE_MD"
else
    read -rp "Добавить автозапуск LSP IntelliSense в глобальный CLAUDE.md (~/.claude/CLAUDE.md)? [Y/n] " claude_answer
    if [[ ! "$claude_answer" =~ ^[Nn]$ ]]; then
        mkdir -p "$GLOBAL_CLAUDE_DIR"
        cat >> "$GLOBAL_CLAUDE_MD" << CLAUDEEOF

$LSP_MARKER (auto-added by install.sh)

Если в текущем проекте нет файла \`.mcp.json\` — создай его автоматически
в корне проекта (там, где запущен Claude Code):

\`\`\`json
{
  "mcpServers": {
    "intellisense": {
      "command": "node",
      "args": ["$DIST_INDEX", "--project", "."]
    }
  }
}
\`\`\`

После создания скажи пользователю: «Файл .mcp.json создан. Перезапусти Claude Code
(или выполни /mcp restart) чтобы подключить LSP IntelliSense.»

Если \`.mcp.json\` уже существует и сервер \`intellisense\` доступен — используй его
инструменты при работе с кодом:
- \`diagnose_file\` — перед коммитом и после изменений
- \`get_hover\` — для проверки сигнатур функций
- \`get_completions\` — для изучения API

CLAUDEEOF
        ok "Добавлено в $GLOBAL_CLAUDE_MD"
        info "При следующем запуске Claude Code в любом проекте сервер настроится автоматически"
    else
        info "Пропускаю. Скопируйте CLAUDE.md.example вручную:"
        info "  cat '$SCRIPT_DIR/CLAUDE.md.example' >> ~/.claude/CLAUDE.md"
        info "  (замените __LSP_MCP_SERVER_PATH__ на: $SCRIPT_DIR)"
    fi
fi

# ── 7. Итоги ─────────────────────────────────────────────────

echo ""
echo -e "${BOLD}═══ Готово! ═══${NC}"
echo ""
echo "Сервер собран: $DIST_INDEX"
echo ""
echo "Использование:"
echo "  1. Глобальный CLAUDE.md (~/.claude/CLAUDE.md) — автозапуск в каждом проекте"
echo "  2. Или .mcp.json в корне проекта (создаётся install.sh или вручную)"
echo "  3. Запустите Claude Code в директории проекта"
echo ""
echo "Ручной запуск:"
echo "  node $DIST_INDEX --project /path/to/project"
echo ""

if [ "$CUDA_FOUND" = true ]; then
    echo -e "${CYAN}CUDA:${NC} Для IntelliSense в .cu файлах создайте compile_commands.json"
    echo "  cmake -DCMAKE_CUDA_COMPILER=nvcc -DCMAKE_EXPORT_COMPILE_COMMANDS=ON .."
    echo ""
fi
