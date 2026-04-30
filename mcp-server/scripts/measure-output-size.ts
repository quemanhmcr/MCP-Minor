import { promises as fs } from "node:fs";
import path from "node:path";

import {
  formatFileSkeletonCompact,
  getWorkspaceFileSkeleton,
} from "../src/filesystem/file-skeleton.js";
import { formatListFilesCompact, listWorkspaceFiles } from "../src/filesystem/list-files.js";
import { formatReadFileResult, readWorkspaceFiles } from "../src/filesystem/read-file.js";
import { formatSearchFilesCompact, searchWorkspaceFiles } from "../src/filesystem/search-files.js";
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
  "dirac/src/services/tree-sitter/languageParser.ts",
  "dirac/src/core/task/tools/handlers/GetFileSkeletonToolHandler.ts",
  "dirac/scripts/file-utils.mjs",
];

console.log("Output size smoke. Token estimate is deterministic ceil(chars / 4); no tokenizer dependency is used.");
await measureSkeleton();
await measureReadFile();
await measureSearchFiles();
await measureListFiles();

async function measureSkeleton(): Promise<void> {
  const rows = [];

  for (const file of skeletonFiles) {
    const raw = await readRaw(file);
    const result = await getWorkspaceFileSkeleton(context, { paths: [file] });
    const outline = formatFileSkeletonCompact(result, { view: "outline" });
    const signatures = formatFileSkeletonCompact(result, { view: "signatures" });
    const fullJson = JSON.stringify(result, null, 2);
    const skeletonFile = result.files[0];

    rows.push({
      file,
      rawChars: raw.length,
      outlineChars: outline.length,
      signaturesChars: signatures.length,
      fullJsonChars: fullJson.length,
      outlineRawRatio: formatRatio(outline.length, raw.length),
      signaturesRawRatio: formatRatio(signatures.length, raw.length),
      signaturesFullJsonRatio: formatRatio(signatures.length, fullJson.length),
      approxSignatureTokens: approximateTokens(signatures.length),
      hasParseErrors: skeletonFile.hasParseErrors,
      entryCount: skeletonFile.entryCount,
    });
  }

  console.log("\nget_file_skeleton");
  console.table(rows);
}

async function measureReadFile(): Promise<void> {
  const file = "mcp-server/src/filesystem/file-skeleton.ts";
  const raw = await readRaw(file);
  const readResult = await readWorkspaceFiles(context, { paths: [file], includeAnchors: false });
  const editResult = await readWorkspaceFiles(context, { paths: [file], includeAnchors: true });
  const readText = formatReadFileResult(readResult, { includeAnchors: false });
  const editText = formatReadFileResult(editResult, { includeAnchors: true });
  const fullJson = JSON.stringify(editResult, null, 2);

  console.log("\nread_file");
  console.table([
    {
      file,
      rawChars: raw.length,
      readChars: readText.length,
      editChars: editText.length,
      fullJsonChars: fullJson.length,
      readRawRatio: formatRatio(readText.length, raw.length),
      editRawRatio: formatRatio(editText.length, raw.length),
      editFullJsonRatio: formatRatio(editText.length, fullJson.length),
      approxReadTokens: approximateTokens(readText.length),
      approxEditTokens: approximateTokens(editText.length),
    },
  ]);
}

async function measureSearchFiles(): Promise<void> {
  const result = await searchWorkspaceFiles(context, {
    paths: ["mcp-server/src"],
    regex: "export|function|class|interface|type",
    filePattern: "*.ts",
    limit: 200,
  });
  const matches = formatSearchFilesCompact(result, { view: "matches" });
  const files = formatSearchFilesCompact(result, { view: "files" });
  const fullJson = JSON.stringify(result, null, 2);

  console.log("\nsearch_files");
  console.table([
    {
      query: "mcp-server/src *.ts export|function|class|interface|type",
      matches: result.matches.length,
      matchedFiles: new Set(result.matches.map((match) => match.relativePath)).size,
      matchViewChars: matches.length,
      fileViewChars: files.length,
      fullJsonChars: fullJson.length,
      matchFullJsonRatio: formatRatio(matches.length, fullJson.length),
      fileFullJsonRatio: formatRatio(files.length, fullJson.length),
      charsPerMatch: result.matches.length === 0 ? "0.0" : (matches.length / result.matches.length).toFixed(1),
    },
  ]);
}

async function measureListFiles(): Promise<void> {
  const result = await listWorkspaceFiles(context, {
    paths: ["mcp-server/src"],
    recursive: true,
    limit: 500,
  });
  const outline = formatListFilesCompact(result);
  const fullJson = JSON.stringify(result, null, 2);

  console.log("\nlist_files");
  console.table([
    {
      path: "mcp-server/src",
      entries: result.entries.length,
      outlineChars: outline.length,
      fullJsonChars: fullJson.length,
      outlineFullJsonRatio: formatRatio(outline.length, fullJson.length),
      charsPerEntry: result.entries.length === 0 ? "0.0" : (outline.length / result.entries.length).toFixed(1),
    },
  ]);
}

async function readRaw(file: string): Promise<string> {
  return fs.readFile(path.join(repoRoot, file), "utf8");
}

function formatRatio(part: number, whole: number): string {
  return whole === 0 ? "0.000" : (part / whole).toFixed(3);
}

function approximateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}
