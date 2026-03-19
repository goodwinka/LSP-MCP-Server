/**
 * Formatters — convert LSP protocol objects to concise, LLM-friendly text.
 */

import type {
  Diagnostic,
  CompletionItem,
  Hover,
  Location,
  DocumentSymbol,
  SymbolInformation,
  MarkupContent,
} from "vscode-languageserver-protocol";
import { DiagnosticSeverity, SymbolKind, CompletionItemKind } from "vscode-languageserver-protocol";

// ── Diagnostics ──────────────────────────────────────────────

const severityLabel = (s?: DiagnosticSeverity): string => {
  switch (s) {
    case DiagnosticSeverity.Error: return "ERROR";
    case DiagnosticSeverity.Warning: return "WARN";
    case DiagnosticSeverity.Information: return "INFO";
    case DiagnosticSeverity.Hint: return "HINT";
    default: return "UNKNOWN";
  }
};

export function formatDiagnostics(file: string, diags: Diagnostic[]): string {
  if (diags.length === 0) return `✅ ${file}: no errors or warnings`;
  const lines = diags.map((d) => {
    const loc = `${file}:${d.range.start.line + 1}:${d.range.start.character + 1}`;
    const sev = severityLabel(d.severity);
    const src = d.source ? ` [${d.source}]` : "";
    return `${sev} ${loc}${src}: ${d.message}`;
  });
  return `Found ${diags.length} diagnostic(s) in ${file}:\n\n${lines.join("\n")}`;
}

// ── Completions ──────────────────────────────────────────────

const completionKindLabel = (k?: CompletionItemKind): string => {
  const map: Record<number, string> = {
    [CompletionItemKind.Function]: "function",
    [CompletionItemKind.Method]: "method",
    [CompletionItemKind.Class]: "class",
    [CompletionItemKind.Interface]: "interface",
    [CompletionItemKind.Variable]: "variable",
    [CompletionItemKind.Field]: "field",
    [CompletionItemKind.Property]: "property",
    [CompletionItemKind.Keyword]: "keyword",
    [CompletionItemKind.Snippet]: "snippet",
    [CompletionItemKind.Module]: "module",
    [CompletionItemKind.Enum]: "enum",
    [CompletionItemKind.EnumMember]: "enum_member",
    [CompletionItemKind.Struct]: "struct",
    [CompletionItemKind.TypeParameter]: "type_param",
    [CompletionItemKind.Constructor]: "constructor",
  };
  return k ? (map[k] ?? "other") : "other";
};

export function formatCompletions(items: CompletionItem[], limit = 30): string {
  if (items.length === 0) return "No completions available at this position.";
  const shown = items.slice(0, limit);
  const lines = shown.map((c) => {
    const kind = completionKindLabel(c.kind);
    const detail = c.detail ? `  — ${c.detail}` : "";
    const doc = extractText(c.documentation);
    const docLine = doc ? `\n    ${doc.slice(0, 200)}` : "";
    return `• [${kind}] ${c.label}${detail}${docLine}`;
  });
  const extra = items.length > limit ? `\n\n... and ${items.length - limit} more` : "";
  return `${items.length} completion(s):\n\n${lines.join("\n")}${extra}`;
}

// ── Hover ────────────────────────────────────────────────────

function extractText(v: string | MarkupContent | { language: string; value: string } | undefined | null): string {
  if (!v) return "";
  if (typeof v === "string") return v;
  if ("value" in v) return v.value;
  return "";
}

export function formatHover(hover: Hover | null): string {
  if (!hover) return "No hover information available.";
  const contents = hover.contents;
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents.map((c) => (typeof c === "string" ? c : c.value)).join("\n\n");
  }
  return extractText(contents as MarkupContent);
}

// ── Definitions ──────────────────────────────────────────────

export function formatDefinitions(locations: Location[], projectRoot: string): string {
  if (locations.length === 0) return "No definition found.";
  const lines = locations.map((loc) => {
    const file = loc.uri.replace(`file://${projectRoot}/`, "");
    return `${file}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
  });
  return `Definition(s):\n${lines.join("\n")}`;
}

// ── References ───────────────────────────────────────────────

export function formatReferences(locations: Location[], projectRoot: string): string {
  if (locations.length === 0) return "No references found.";
  const lines = locations.map((loc) => {
    const file = loc.uri.replace(`file://${projectRoot}/`, "");
    return `${file}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
  });
  return `${locations.length} reference(s):\n${lines.join("\n")}`;
}

// ── Symbols ──────────────────────────────────────────────────

const symbolKindLabel = (k: SymbolKind): string => {
  const map: Record<number, string> = {
    [SymbolKind.File]: "file",
    [SymbolKind.Module]: "module",
    [SymbolKind.Namespace]: "namespace",
    [SymbolKind.Class]: "class",
    [SymbolKind.Method]: "method",
    [SymbolKind.Function]: "function",
    [SymbolKind.Constructor]: "constructor",
    [SymbolKind.Field]: "field",
    [SymbolKind.Variable]: "variable",
    [SymbolKind.Enum]: "enum",
    [SymbolKind.Interface]: "interface",
    [SymbolKind.Struct]: "struct",
    [SymbolKind.Property]: "property",
    [SymbolKind.EnumMember]: "enum_member",
    [SymbolKind.Constant]: "constant",
    [SymbolKind.TypeParameter]: "type_param",
  };
  return map[k] ?? "other";
};

function formatDocSymbol(sym: DocumentSymbol, indent = 0): string {
  const pad = "  ".repeat(indent);
  const kind = symbolKindLabel(sym.kind);
  const loc = `L${sym.range.start.line + 1}`;
  const detail = sym.detail ? ` — ${sym.detail}` : "";
  let result = `${pad}• [${kind}] ${sym.name} (${loc})${detail}`;
  if (sym.children) {
    for (const child of sym.children) {
      result += "\n" + formatDocSymbol(child, indent + 1);
    }
  }
  return result;
}

export function formatSymbols(symbols: (DocumentSymbol | SymbolInformation)[]): string {
  if (symbols.length === 0) return "No symbols found.";
  // DocumentSymbol has `range`, SymbolInformation has `location`
  const lines = symbols.map((s) => {
    if ("range" in s) return formatDocSymbol(s as DocumentSymbol);
    const si = s as SymbolInformation;
    const kind = symbolKindLabel(si.kind);
    const file = si.location.uri.replace(/^file:\/\//, "");
    return `• [${kind}] ${si.name} — ${file}:${si.location.range.start.line + 1}`;
  });
  return `${symbols.length} symbol(s):\n\n${lines.join("\n")}`;
}
