# LSP-MCP Server — Руководство для разработки

## Сборка и запуск

```bash
npm install          # установка зависимостей
npm run build        # компиляция TypeScript → dist/
npm run dev          # запуск через tsx (без сборки)
npm start            # запуск собранного dist/index.js
```

## Структура проекта

```
src/
├── index.ts              — точка входа, CLI, MCP-инструменты
├── server-pool.ts        — пул LSP-серверов (lazy start, один на язык)
├── lsp-client.ts         — LSP-клиент (JSON-RPC, управление документами)
├── language-registry.ts  — реестр языков и LSP-серверов
└── formatters.ts         — форматирование LSP-ответов в текст
```

## Соглашения

- TypeScript strict mode, ES2022, ESM модули (Node16 module resolution)
- Все импорты с расширением `.js` (ESM requirement)
- Ошибки типизируются как `unknown` в catch: `catch (e: unknown)`
- Используется `@modelcontextprotocol/sdk` для MCP
- Используется `vscode-languageserver-protocol` для LSP типов

## Добавление нового языка

1. Добавить запись в `BUILTIN_SERVERS` в `src/language-registry.ts`
2. Обновить описания инструментов в `src/index.ts` (help, diagnose_file)
3. Обновить таблицу в `README.md`
4. Собрать: `npm run build`

## Тестирование

```bash
# Проверить что собирается
npm run build

# Запуск с отладкой
LSP_MCP_DEBUG=1 node dist/index.js --project /path/to/test/project
```
