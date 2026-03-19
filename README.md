# LSP-MCP Server — Universal IntelliSense для LLM

MCP-сервер, который автоматически подключает нужный **Language Server** (clangd, pyright, tsserver, gopls, rust-analyzer…) и предоставляет Claude Code доступ к полноценному IntelliSense для **любого языка**, включая **CUDA**: диагностика ошибок, автодополнение, информация о типах, навигация по коду.

## Поддерживаемые языки

| Язык | LSP-сервер | Расширения |
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

Сервер **автоматически определяет** нужный LSP по расширению файла. Вы открываете `.cpp` — запускается clangd. Открываете `.py` — запускается pyright. Всё прозрачно.

## Как это работает

```
Claude Code  ──(MCP/stdio)──►  lsp-mcp-server  ──(LSP/JSON-RPC)──►  clangd
                                       │                              pyright
                                       │                              tsserver
                                       └── ServerPool ──────────────► gopls
                                            (lazy start,               rust-analyzer
                                             one per language)         ...
```

LLM может:
1. **До написания** — запросить сигнатуры функций через `get_completions` и `get_hover`
2. **После написания** — прогнать `diagnose_file` / `diagnose_code` и увидеть ошибки
3. **При рефакторинге** — найти все использования через `find_references`

## Установка

### 1. Собрать сервер

```bash
cd lsp-mcp-server
npm install
npm run build      # компиляция TypeScript → dist/
# или для разработки без сборки:
npm run dev        # запуск через tsx напрямую
```

### 2. Установить нужные LSP-серверы

Устанавливайте только те, которые вам нужны:

```bash
# C++ / Qt
sudo apt install clangd-18          # или: brew install llvm

# Python
npm install -g pyright               # или: pip install pyright

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
# Примечание: работает только с файлами .cmake, не с CMakeLists.txt напрямую

# Lua
brew install lua-language-server         # macOS
# Linux: скачать с https://github.com/LuaLS/lua-language-server/releases

# Java (Eclipse JDT LS)
# Скачать и установить: https://github.com/eclipse-jdtls/eclipse.jdt.ls/releases
# После установки убедитесь, что команда `jdtls` доступна в PATH

# Kotlin
# Скачать с https://github.com/fwcd/kotlin-language-server/releases
# После установки убедитесь, что команда `kotlin-language-server` доступна в PATH

# Zig
# Скачать с https://github.com/zigtools/zls/releases
# После установки убедитесь, что команда `zls` доступна в PATH
```

Посмотреть, что установлено, можно инструментом `list_servers`.

### 3. Подключить к Claude Code

**Вариант A: Конфиг проекта** (`.mcp.json` в корне проекта)

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

**Вариант B: Глобальный конфиг** (`~/.claude/claude_desktop_config.json`)

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

**Вариант C: Через переменные окружения**

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

## Доступные инструменты

| Инструмент | Описание |
|---|---|
| `diagnose_file` | Ошибки/предупреждения компилятора для файла на диске |
| `diagnose_code` | Проверить код на ошибки без сохранения (виртуальный файл) |
| `get_completions` | Автодополнение в указанной позиции |
| `get_hover` | Тип и документация символа |
| `get_definitions` | Перейти к определению символа |
| `find_references` | Найти все использования символа в проекте |
| `get_symbols` | Дерево символов файла |
| `list_servers` | Показать все языки, статус серверов (установлен/запущен) |

## Примеры использования

```
> Проверь файл src/mainwindow.cpp на ошибки
  → [clangd] diagnose_file("src/mainwindow.cpp")

> Проверь app/models.py
  → [pyright] diagnose_file("app/models.py")

> Какие методы есть у QTableView?
  → get_completions на .cpp файле с QTableView*

> Покажи сигнатуру функции pandas.read_csv
  → get_hover на .py файле

> Какие серверы доступны?
  → list_servers
```

## Советы для C++/Qt

Для корректной работы clangd с Qt нужен `compile_commands.json`:

```bash
# CMake
cmake -DCMAKE_EXPORT_COMPILE_COMMANDS=ON ..

# qmake через Bear
bear -- make

# Или вручную — файл .clangd в корне проекта:
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

## Советы для CUDA

### CUDA C++ (.cu, .cuh)

clangd поддерживает CUDA нативно (основан на clang). Для корректной работы нужен CUDA Toolkit:

```bash
# Проверить установку
nvcc --version
```

Для лучшей работы IntelliSense создайте `compile_commands.json`:

```bash
# CMake с CUDA
cmake -DCMAKE_CUDA_COMPILER=nvcc -DCMAKE_EXPORT_COMPILE_COMMANDS=ON ..
```

Или создайте файл `.clangd` в корне проекта:

```yaml
CompileFlags:
  Add:
    - --cuda-gpu-arch=sm_75
    - --cuda-path=/usr/local/cuda
    - -I/usr/local/cuda/include
    - -std=c++17
```

### CUDA Python (CuPy, Numba, PyCUDA)

Python-библиотеки для CUDA работают через обычный pyright — отдельная настройка не нужна.
Для улучшенной проверки типов установите стабы:

```bash
# CuPy — стабы включены в пакет
pip install cupy-cuda12x    # или cupy-cuda11x

# Numba
pip install numba

# PyCUDA
pip install pycuda
```

Pyright автоматически подхватит типы из установленных пакетов.

## Советы для Python

Pyright автоматически подхватывает `pyrightconfig.json` и `pyproject.toml`. Для виртуальных окружений убедитесь, что `venv` активировано или указан путь в конфиге.

## CLI

```
--project, -p <path>    Путь к корню проекта (обязательно)
--help, -h              Показать справку и выйти
```

## Переменные окружения

| Переменная | Описание |
|---|---|
| `LSP_PROJECT_ROOT` | Путь к проекту (если не задан --project) |
| `LSP_MCP_DEBUG=1` | Выводить stderr языковых серверов |

## Устранение проблем

### Какой сервер выбран для моего файла?

Используйте инструмент `list_servers` — он покажет все серверы, их статус и поддерживаемые расширения. Сервер выбирается автоматически по расширению файла.

### Если установлены оба pyright и pylsp

Первым в реестре стоит **pyright** — он и будет использоваться для `.py` файлов. Если нужен pylsp, удалите или переименуйте `pyright-langserver`.

### CMakeLists.txt не диагностируется

`cmake-language-server` подключается только к файлам с расширением `.cmake`. Для `CMakeLists.txt` поддержка пока не реализована — это ограничение текущей архитектуры определения языка по расширению.

### Сервер запустился, но нет диагностики

Включите отладочный вывод (`LSP_MCP_DEBUG=1`) и проверьте stderr языкового сервера. Убедитесь, что для C++ проекта создан `compile_commands.json` или файл `.clangd`.

### Ошибка "path is outside project root"

Все пути к файлам должны быть **относительно корня проекта**, указанного в `--project`. Абсолютные пути не допускаются.

## Лицензия

MIT
