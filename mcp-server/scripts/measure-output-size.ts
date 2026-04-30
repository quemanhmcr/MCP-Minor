import { promises as fs } from "node:fs";
import path from "node:path";

import {
  compactFileSkeletonResult,
  formatFileSkeletonCompact,
  getWorkspaceFileSkeleton,
} from "../src/filesystem/file-skeleton.js";
import { compactGetFunctionResult, formatGetFunctionCompact, getWorkspaceFunctions } from "../src/filesystem/get-function.js";
import { compactListFilesResult, formatListFilesCompact, listWorkspaceFiles } from "../src/filesystem/list-files.js";
import {
  compactReadFileResult,
  formatReadFileResult,
  readWorkspaceFiles,
} from "../src/filesystem/read-file.js";
import { compactSearchFilesResult, formatSearchFilesCompact, searchWorkspaceFiles } from "../src/filesystem/search-files.js";
import type { RuntimeContext } from "../src/runtime/context.js";

const repoRoot = path.resolve("..");
const context: RuntimeContext = {
  cwd: repoRoot,
  sessionId: "measure-output-size",
  workspaceRoots: [repoRoot],
};

const skeletonFiles = [
  "mcp-server/src/filesystem/file-skeleton.ts",
  "mcp-server/src/tools/file-skeleton.ts",
  "mcp-server/test/fixtures/react-generic-heavy.tsx",
  "dirac/src/services/tree-sitter/languageParser.ts",
  "dirac/src/core/task/tools/handlers/GetFileSkeletonToolHandler.ts",
  "dirac/scripts/file-utils.mjs",
];

console.log("Output size smoke. Token estimate is deterministic ceil(chars / 4); no tokenizer dependency is used.");
console.log("MCP-visible total chars = content text chars + JSON.stringify(structuredContent).length.");
await measureSkeleton();
await measureGetFunction();
await measureReadFile();
await measureEditWorkflowTax();
await measureSearchFiles();
await measureListFiles();

async function measureSkeleton(): Promise<void> {
  const rows = [];

  for (const file of skeletonFiles) {
    const raw = await readRaw(file);
    const result = await getWorkspaceFileSkeleton(context, { paths: [file] });
    const outline = measurePayload(
      formatFileSkeletonCompact(result, { view: "outline" }),
      compactFileSkeletonResult(result, { view: "outline" }),
    );
    const signatures = measurePayload(
      formatFileSkeletonCompact(result, { view: "signatures" }),
      compactFileSkeletonResult(result, { view: "signatures" }),
    );
    const full = measureFullPayload(result as unknown as Record<string, unknown>);
    const skeletonFile = result.files[0];

    rows.push({
      file,
      rawChars: raw.length,
      outlineContentChars: outline.contentChars,
      outlineStructuredJsonChars: outline.structuredJsonChars,
      outlineTotalChars: outline.totalChars,
      signaturesContentChars: signatures.contentChars,
      signaturesStructuredJsonChars: signatures.structuredJsonChars,
      signaturesTotalChars: signatures.totalChars,
      fullTotalChars: full.totalChars,
      outlineRawRatio: formatRatio(outline.totalChars, raw.length),
      signaturesRawRatio: formatRatio(signatures.totalChars, raw.length),
      signaturesFullRatio: formatRatio(signatures.totalChars, full.totalChars),
      approxSignatureTokens: approximateTokens(signatures.totalChars),
      hasParseErrors: skeletonFile.hasParseErrors,
      entryCount: skeletonFile.entryCount,
    });
  }

  console.log("\nget_file_skeleton");
  console.table(rows);
}

async function measureGetFunction(): Promise<void> {
  const file = "mcp-server/src/filesystem/file-skeleton.ts";
  const raw = await readRaw(file);
  const sourceResult = await getWorkspaceFunctions(context, {
    paths: [file],
    functionNames: ["getWorkspaceFileSkeleton"],
    contextLines: 1,
  });
  const editResult = await getWorkspaceFunctions(
    context,
    {
      paths: [file],
      functionNames: ["getWorkspaceFileSkeleton"],
      contextLines: 1,
    },
    { includeEditAnchors: true },
  );
  const source = measurePayload(formatGetFunctionCompact(sourceResult), compactGetFunctionResult(sourceResult));
  const edit = measurePayload(formatGetFunctionCompact(editResult, { view: "edit" }), compactGetFunctionResult(editResult, { view: "edit" }));
  const full = measureFullPayload(sourceResult as unknown as Record<string, unknown>);

  console.log("\nget_function");
  console.table([
    {
      file,
      functionName: "getWorkspaceFileSkeleton",
      rawChars: raw.length,
      sourceTotalChars: source.totalChars,
      editTotalChars: edit.totalChars,
      fullTotalChars: full.totalChars,
      sourceRawRatio: formatRatio(source.totalChars, raw.length),
      editRawRatio: formatRatio(edit.totalChars, raw.length),
      sourceFullRatio: formatRatio(source.totalChars, full.totalChars),
      approxSourceTokens: approximateTokens(source.totalChars),
    },
  ]);
}

async function measureReadFile(): Promise<void> {
  const file = "mcp-server/src/filesystem/file-skeleton.ts";
  const raw = await readRaw(file);
  const readResult = await readWorkspaceFiles(context, { paths: [file], includeAnchors: false });
  const editResult = await readWorkspaceFiles(context, { paths: [file], includeAnchors: true });
  const read = measurePayload(
    formatReadFileResult(readResult, { includeAnchors: false }),
    compactReadFileResult(readResult, { includeAnchors: false }),
  );
  const edit = measurePayload(
    formatReadFileResult(editResult, { includeAnchors: true }),
    compactReadFileResult(editResult, { includeAnchors: true }),
  );
  const full = measureFullPayload(editResult as unknown as Record<string, unknown>);

  console.log("\nread_file");
  console.table([
    {
      file,
      rawChars: raw.length,
      readContentChars: read.contentChars,
      readStructuredJsonChars: read.structuredJsonChars,
      readTotalChars: read.totalChars,
      editContentChars: edit.contentChars,
      editStructuredJsonChars: edit.structuredJsonChars,
      editTotalChars: edit.totalChars,
      fullTotalChars: full.totalChars,
      readRawRatio: formatRatio(read.totalChars, raw.length),
      editRawRatio: formatRatio(edit.totalChars, raw.length),
      readFullRatio: formatRatio(read.totalChars, full.totalChars),
      editFullRatio: formatRatio(edit.totalChars, full.totalChars),
      approxReadTokens: approximateTokens(read.totalChars),
      approxEditTokens: approximateTokens(edit.totalChars),
    },
  ]);
}

async function measureEditWorkflowTax(): Promise<void> {
  const file = "mcp-server/src/filesystem/file-skeleton.ts";
  const readResult = await readWorkspaceFiles(context, { paths: [file], includeAnchors: false });
  const editResult = await readWorkspaceFiles(context, { paths: [file], includeAnchors: true });
  const read = measurePayload(
    formatReadFileResult(readResult, { includeAnchors: false }),
    compactReadFileResult(readResult, { includeAnchors: false }),
  );
  const edit = measurePayload(
    formatReadFileResult(editResult, { includeAnchors: true }),
    compactReadFileResult(editResult, { includeAnchors: true }),
  );

  console.log("\nedit workflow tax");
  console.table(
    [1, 3, 5].map((exploratoryReads) => {
      const oldStyleTotal = edit.totalChars * exploratoryReads;
      const newWorkflowTotal = read.totalChars * exploratoryReads + edit.totalChars;
      return {
        exploratoryReads,
        oldStyleEditReadyTotalChars: oldStyleTotal,
        newReadThenRereadEditTotalChars: newWorkflowTotal,
        deltaChars: newWorkflowTotal - oldStyleTotal,
        oldStyleTokens: approximateTokens(oldStyleTotal),
        newWorkflowTokens: approximateTokens(newWorkflowTotal),
        cheaper: newWorkflowTotal < oldStyleTotal ? "new workflow" : "old-style edit-ready reads",
      };
    }),
  );
}

async function measureSearchFiles(): Promise<void> {
  const result = await searchWorkspaceFiles(context, {
    paths: ["mcp-server/src"],
    regex: "export|function|class|interface|type",
    filePattern: "*.ts",
    limit: 200,
  });
  const matches = measurePayload(
    formatSearchFilesCompact(result, { view: "matches" }),
    compactSearchFilesResult(result, { view: "matches" }),
  );
  const files = measurePayload(
    formatSearchFilesCompact(result, { view: "files" }),
    compactSearchFilesResult(result, { view: "files" }),
  );
  const full = measureFullPayload(result as unknown as Record<string, unknown>);

  console.log("\nsearch_files");
  console.table([
    {
      query: "mcp-server/src *.ts export|function|class|interface|type",
      matches: result.matches.length,
      matchedFiles: new Set(result.matches.map((match) => match.relativePath)).size,
      matchesTotalChars: matches.totalChars,
      filesTotalChars: files.totalChars,
      fullTotalChars: full.totalChars,
      matchesFullRatio: formatRatio(matches.totalChars, full.totalChars),
      filesFullRatio: formatRatio(files.totalChars, full.totalChars),
      charsPerMatch: result.matches.length === 0 ? "0.0" : (matches.totalChars / result.matches.length).toFixed(1),
    },
  ]);
}

async function measureListFiles(): Promise<void> {
  const result = await listWorkspaceFiles(context, {
    paths: ["mcp-server/src"],
    recursive: true,
    limit: 500,
  });
  const outline = measurePayload(formatListFilesCompact(result), compactListFilesResult(result));
  const full = measureFullPayload(result as unknown as Record<string, unknown>);

  console.log("\nlist_files");
  console.table([
    {
      path: "mcp-server/src",
      entries: result.entries.length,
      outlineTotalChars: outline.totalChars,
      fullTotalChars: full.totalChars,
      outlineFullRatio: formatRatio(outline.totalChars, full.totalChars),
      charsPerEntry: result.entries.length === 0 ? "0.0" : (outline.totalChars / result.entries.length).toFixed(1),
    },
  ]);
}

async function readRaw(file: string): Promise<string> {
  return fs.readFile(path.join(repoRoot, file), "utf8");
}

function measurePayload(content: string, structuredContent: object): PayloadSize {
  const structuredJsonChars = JSON.stringify(structuredContent).length;
  return {
    contentChars: content.length,
    structuredJsonChars,
    totalChars: content.length + structuredJsonChars,
    approxTokens: approximateTokens(content.length + structuredJsonChars),
  };
}

function measureFullPayload(structuredContent: Record<string, unknown>): PayloadSize {
  return measurePayload(JSON.stringify(structuredContent, null, 2), structuredContent);
}

function formatRatio(part: number, whole: number): string {
  return whole === 0 ? "0.000" : (part / whole).toFixed(3);
}

function approximateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

interface PayloadSize {
  contentChars: number;
  structuredJsonChars: number;
  totalChars: number;
  approxTokens: number;
}
