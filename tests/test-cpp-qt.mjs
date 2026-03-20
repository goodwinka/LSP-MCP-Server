#!/usr/bin/env node
/**
 * Integration test: LSP-MCP Server with Qt5 C++ project
 *
 * Prerequisites:
 *   - clangd installed (Ubuntu: sudo apt install clangd)
 *   - Qt5 dev headers (Ubuntu: sudo apt install qtbase5-dev)
 *   - compile_commands.json in tests/fixtures/qt_project/
 *     Generate with: cd tests/fixtures/qt_project && cmake -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON && cp build/compile_commands.json .
 *
 * Run:
 *   node tests/test-cpp-qt.mjs
 */

import { spawn } from "child_process";
import * as readline from "readline";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const PROJECT = resolve(__dirname, "fixtures/qt_project");
const SERVER_PATH = resolve(REPO_ROOT, "dist/index.js");

// ── Setup: generate compile_commands.json if missing ────────────────────────

function setupProject() {
  const compileCommands = resolve(PROJECT, "compile_commands.json");
  if (!existsSync(compileCommands)) {
    console.log("  Generating compile_commands.json via CMake...");
    try {
      execSync(
        "cmake -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON && cp build/compile_commands.json .",
        { cwd: PROJECT, stdio: "pipe" }
      );
      console.log("  Generated successfully.\n");
    } catch (e) {
      console.error("  Failed to generate compile_commands.json:", e.message);
      console.error("  Make sure cmake and Qt5 are installed.");
      process.exit(1);
    }
  }
}

// ── MCP client ───────────────────────────────────────────────────────────────

function startServer() {
  return spawn("node", [SERVER_PATH, "--project", PROJECT], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, LSP_MCP_DEBUG: "" },
  });
}

function createClient(server) {
  let msgId = 1;
  const pending = new Map();

  const rl = readline.createInterface({ input: server.stdout });
  rl.on("line", (line) => {
    line = line.trim();
    if (!line) return;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    } catch { /* ignore non-JSON */ }
  });

  return {
    send(method, params) {
      return new Promise((resolve, reject) => {
        const id = msgId++;
        pending.set(id, { resolve, reject });
        server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    notify(method, params) {
      server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    },
  };
}

// ── Test helpers ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, label, detail = "") {
  if (condition) {
    console.log(`   ✓ ${label}`);
    passed++;
  } else {
    console.log(`   ✗ ${label}${detail ? ": " + detail : ""}`);
    failed++;
  }
}

async function callTool(client, name, args) {
  const result = await client.send("tools/call", { name, arguments: args });
  return result?.content?.[0]?.text || "";
}

// ── Tests ────────────────────────────────────────────────────────────────────

async function run() {
  console.log("=== LSP-MCP Server — Qt5 C++ Integration Test ===\n");

  setupProject();

  const server = startServer();
  const client = createClient(server);

  server.on("error", (e) => { console.error("Server error:", e); process.exit(1); });

  const timeout = setTimeout(() => {
    console.error("\nTEST TIMEOUT");
    server.kill();
    process.exit(1);
  }, 90_000);

  try {
    // 1. Initialize
    console.log("1. MCP initialization");
    const init = await client.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });
    assert(init.serverInfo?.name === "lsp-intellisense", "server name = lsp-intellisense");
    assert(!!init.capabilities?.tools, "tools capability present");
    client.notify("notifications/initialized", {});
    console.log();

    // 2. Tool listing
    console.log("2. Tool listing");
    const { tools } = await client.send("tools/list", {});
    const names = tools.map(t => t.name);
    for (const expected of ["diagnose_file", "diagnose_workspace", "get_completions", "get_hover", "get_definitions", "find_references", "get_symbols", "list_servers"]) {
      assert(names.includes(expected), `tool "${expected}" present`);
    }
    console.log();

    // 3. clangd detected
    console.log("3. clangd server availability");
    const servers = await callTool(client, "list_servers", {});
    assert(servers.includes("clangd") && servers.includes("✅ installed"), "clangd ✅ installed");
    console.log();

    // 4. Diagnostics — clean Qt5 files
    console.log("4. Diagnostics on clean Qt5 files");
    for (const file of ["main.cpp", "mywidget.cpp", "mywidget.h"]) {
      const diag = await callTool(client, "diagnose_file", { file });
      assert(diag.includes("[clangd]"), `clangd processed ${file}`);
      assert(!diag.toLowerCase().includes("error") || diag.includes("no errors"), `${file}: no errors`);
    }
    console.log();

    // 5. Hover — Qt type info
    console.log("5. Hover on Qt types");
    // mywidget.h line 6 col 27 = "QWidget" in "class MyWidget : public QWidget"
    const hover = await callTool(client, "get_hover", { file: "mywidget.h", line: 6, character: 27 });
    assert(hover.toLowerCase().includes("qwidget"), "hover returns QWidget info");
    console.log(`   Info: ${hover.split("\n")[0]}`);
    console.log();

    // 6. Completions
    console.log("6. Completions in main.cpp");
    const comp = await callTool(client, "get_completions", { file: "main.cpp", line: 3, character: 4 });
    assert(comp.includes("completion"), "completions returned");
    console.log(`   ${comp.split("\n")[0]}`);
    console.log();

    // 7. Document symbols (with Q_OBJECT expansion)
    console.log("7. Document symbols in mywidget.h");
    const sym = await callTool(client, "get_symbols", { file: "mywidget.h" });
    assert(sym.includes("MyWidget"), "MyWidget class found");
    assert(sym.includes("onButtonClicked"), "slot onButtonClicked found");
    assert(sym.includes("m_button") || sym.includes("m_label"), "private fields found");
    assert(sym.includes("Q_OBJECT") || sym.includes("staticMetaObject"), "Q_OBJECT expansion visible");
    console.log();

    // 8. diagnose_workspace — after diagnosing 3 clean files
    console.log("8. diagnose_workspace — all open files clean");
    const ws = await callTool(client, "diagnose_workspace", {});
    assert(ws.includes("✅") || ws.includes("clean") || ws.includes("0 error"), "workspace shows clean state");
    assert(ws.includes("file(s)"), "workspace reports file count");
    console.log(`   ${ws.split("\n")[0]}`);
    console.log();

  } finally {
    clearTimeout(timeout);
    server.kill();
  }

  console.log(`=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
