import { promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import type Parser from "web-tree-sitter";

import type { RuntimeContext } from "../runtime/context.js";
import {
  getSupportedTreeSitterExtensions,
  parseSourceFile,
  type SupportedTreeSitterExtension,
  TreeSitterRuntimeError,
} from "../tree-sitter/runtime.js";
import { isPathInside, type ResolvedWorkspacePath, resolveWorkspacePath } from "./workspace.js";

export const DEFAULT_FILE_SKELETON_LIMIT = 500;
export const MAX_FILE_SKELETON_LIMIT = 2_000;
export const MAX_FILE_SKELETON_BYTES = 1 * 1024 * 1024;
export const MAX_FILE_SKELETON_BYTES_LABEL = "1MB";

const UNSUPPORTED_RICH_EXTENSIONS = new Set([
  ".pdf",
  ".docx",
  ".xlsx",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".ico",
]);

const DEFINITION_KINDS = new Set<SkeletonEntryKind>([
  "class",
  "enum",
  "function",
  "interface",
  "method",
  "module",
  "type",
]);

const BODY_NODE_TYPES = new Set([
  "class_body",
  "enum_body",
  "function_body",
  "generator_function",
  "jsx_element",
  "object",
  "object_pattern",
  "statement_block",
]);

export class FileSkeletonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileSkeletonError";
  }
}

export type SkeletonEntryKind =
  | "class"
  | "enum"
  | "export"
  | "function"
  | "import"
  | "interface"
  | "method"
  | "module"
  | "type";

export interface FileSkeletonInput {
  paths: string[];
  limit?: number;
}

export interface SourceLocation {
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
}

export interface SkeletonEntry {
  kind: SkeletonEntryKind;
  name: string;
  signature: string;
  location: SourceLocation;
  children: SkeletonEntry[];
}

export interface FileSkeletonEntry {
  path: string;
  relativePath: string;
  language: "javascript" | "typescript" | "tsx";
  rootType: string;
  sourceLength: number;
  hasParseErrors: boolean;
  entries: SkeletonEntry[];
  entryCount: number;
  limit: number;
  truncated: boolean;
}

export interface FileSkeletonResult {
  files: FileSkeletonEntry[];
  limit: number;
  truncated: boolean;
}

interface FlatDefinition {
  kind: SkeletonEntryKind;
  name: string;
  signature: string;
  location: SourceLocation;
  nodeId: number;
  parentNodeId?: number;
  children: FlatDefinition[];
}

interface NamedCapturePair {
  nameCapture: Parser.QueryCapture;
  definitionCapture: Parser.QueryCapture;
}

export async function getWorkspaceFileSkeleton(
  context: RuntimeContext,
  input: FileSkeletonInput,
): Promise<FileSkeletonResult> {
  const paths = validatePaths(input.paths);
  const limit = validateLimit(input.limit);
  const files: FileSkeletonEntry[] = [];

  for (const userPath of paths) {
    files.push(await getOneFileSkeleton(context, userPath, limit));
  }

  return {
    files,
    limit,
    truncated: files.some((file) => file.truncated),
  };
}

export function formatFileSkeletonResult(result: FileSkeletonResult): string {
  return JSON.stringify(result, null, 2);
}

async function getOneFileSkeleton(
  context: RuntimeContext,
  userPath: string,
  limit: number,
): Promise<FileSkeletonEntry> {
  const resolved = resolveWorkspacePath(context, userPath);
  const stat = await statPath(resolved);

  if (stat.isSymbolicLink()) {
    throw new FileSkeletonError(`Path '${resolved.inputPath}' is a symbolic link and will not be followed.`);
  }

  if (!stat.isFile()) {
    if (stat.isDirectory()) {
      throw new FileSkeletonError(`Path '${resolved.inputPath}' is a directory, not a file.`);
    }

    throw new FileSkeletonError(`Path '${resolved.inputPath}' is not a regular file.`);
  }

  await assertRealPathInsideWorkspace(resolved);
  assertSupportedTreeSitterFile(resolved);
  assertReadableSize(resolved, stat);

  const source = await readTextFile(resolved, stat);
  const parsed = await parseSourceFile({ filePath: resolved.absolutePath, source });

  try {
    const extracted = extractSkeletonEntries(parsed.tree.rootNode, parsed.query, source, limit);

    return {
      path: resolved.absolutePath,
      relativePath: resolved.relativePath,
      language: parsed.language.languageId,
      rootType: parsed.rootNodeType,
      sourceLength: parsed.sourceLength,
      hasParseErrors: parsed.hasError,
      entries: extracted.entries,
      entryCount: extracted.entryCount,
      limit,
      truncated: extracted.truncated,
    };
  } finally {
    parsed.dispose();
  }
}

function extractSkeletonEntries(
  rootNode: Parser.SyntaxNode,
  query: Parser.Query,
  source: string,
  limit: number,
): { entries: SkeletonEntry[]; entryCount: number; truncated: boolean } {
  const definitions = extractDefinitions(rootNode, query, source);
  const importsAndExports = extractImportExportEntries(rootNode, source, definitions);
  const allEntries = [...importsAndExports, ...nestDefinitions(definitions)].sort(compareEntries);
  const limited = takeEntriesPreorder(allEntries, limit);

  return {
    entries: limited.entries,
    entryCount: countEntries(allEntries),
    truncated: limited.truncated,
  };
}

function extractDefinitions(rootNode: Parser.SyntaxNode, query: Parser.Query, source: string): FlatDefinition[] {
  const pairs = findNamedCapturePairs(rootNode, query);
  const definitions = new Map<number, FlatDefinition>();

  for (const pair of pairs) {
    const kind = getDefinitionKind(pair.definitionCapture.name);
    if (!kind || !DEFINITION_KINDS.has(kind)) {
      continue;
    }

    const rangeNode = extendToDefinitionWrapper(pair.definitionCapture.node);
    if (definitions.has(rangeNode.id)) {
      continue;
    }

    definitions.set(rangeNode.id, {
      kind,
      name: normalizeName(pair.nameCapture.node.text),
      signature: getSignature(rangeNode, source),
      location: getLocation(rangeNode),
      nodeId: rangeNode.id,
      children: [],
    });
  }

  return Array.from(definitions.values()).sort(compareFlatDefinitions);
}

function findNamedCapturePairs(rootNode: Parser.SyntaxNode, query: Parser.Query): NamedCapturePair[] {
  return query
    .matches(rootNode)
    .map((match) => {
      const nameCapture = match.captures.find((capture) => capture.name.startsWith("name.definition"));
      const definitionCapture = match.captures.find((capture) => capture.name.startsWith("definition."));
      return nameCapture && definitionCapture ? { nameCapture, definitionCapture } : undefined;
    })
    .filter((pair): pair is NamedCapturePair => pair !== undefined);
}

function extractImportExportEntries(
  rootNode: Parser.SyntaxNode,
  source: string,
  definitions: FlatDefinition[],
): SkeletonEntry[] {
  const definitionRanges = definitions.map((definition) => definition.location);
  const entries: SkeletonEntry[] = [];

  for (const child of rootNode.namedChildren) {
    if (child.type === "import_statement") {
      entries.push({
        kind: "import",
        name: getImportName(child),
        signature: getSingleLineSignature(child, source),
        location: getLocation(child),
        children: [],
      });
      continue;
    }

    if (isExportOnlyStatement(child) && !rangeContainsAny(child, definitionRanges)) {
      entries.push({
        kind: "export",
        name: getExportName(child),
        signature: getSingleLineSignature(child, source),
        location: getLocation(child),
        children: [],
      });
    }
  }

  return entries;
}

function nestDefinitions(definitions: FlatDefinition[]): SkeletonEntry[] {
  const byId = new Map(definitions.map((definition) => [definition.nodeId, definition]));
  const roots: FlatDefinition[] = [];

  for (const definition of definitions) {
    const parent = findSmallestContainingDefinition(definition, definitions);
    if (parent) {
      definition.parentNodeId = parent.nodeId;
      parent.children.push(definition);
    } else {
      roots.push(definition);
    }
  }

  for (const definition of byId.values()) {
    definition.children.sort(compareFlatDefinitions);
  }

  return roots.sort(compareFlatDefinitions).map(flatDefinitionToEntry);
}

function findSmallestContainingDefinition(
  definition: FlatDefinition,
  candidates: FlatDefinition[],
): FlatDefinition | undefined {
  return candidates
    .filter(
      (candidate) =>
        candidate.nodeId !== definition.nodeId &&
        candidate.location.startByte <= definition.location.startByte &&
        candidate.location.endByte >= definition.location.endByte,
    )
    .sort((a, b) => rangeSize(a.location) - rangeSize(b.location))[0];
}

function flatDefinitionToEntry(definition: FlatDefinition): SkeletonEntry {
  return {
    kind: definition.kind,
    name: definition.name,
    signature: definition.signature,
    location: definition.location,
    children: definition.children.map(flatDefinitionToEntry),
  };
}

function takeEntriesPreorder(entries: SkeletonEntry[], limit: number): { entries: SkeletonEntry[]; truncated: boolean } {
  let remaining = limit;
  let truncated = false;

  function visit(entry: SkeletonEntry): SkeletonEntry | undefined {
    if (remaining <= 0) {
      truncated = true;
      return undefined;
    }

    remaining--;
    const children: SkeletonEntry[] = [];
    for (const child of entry.children) {
      const limitedChild = visit(child);
      if (limitedChild) {
        children.push(limitedChild);
      }
    }

    return {
      ...entry,
      children,
    };
  }

  const limitedEntries: SkeletonEntry[] = [];
  for (const entry of entries) {
    const limitedEntry = visit(entry);
    if (limitedEntry) {
      limitedEntries.push(limitedEntry);
    }
  }

  return {
    entries: limitedEntries,
    truncated,
  };
}

function countEntries(entries: SkeletonEntry[]): number {
  return entries.reduce((count, entry) => count + 1 + countEntries(entry.children), 0);
}

function compareEntries(a: SkeletonEntry, b: SkeletonEntry): number {
  return a.location.startByte - b.location.startByte || a.location.endByte - b.location.endByte;
}

function compareFlatDefinitions(a: FlatDefinition, b: FlatDefinition): number {
  return a.location.startByte - b.location.startByte || a.location.endByte - b.location.endByte;
}

function rangeSize(location: SourceLocation): number {
  return location.endByte - location.startByte;
}

function validatePaths(paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new FileSkeletonError("paths must be a non-empty array of strings.");
  }

  return paths.map((userPath) => {
    if (typeof userPath !== "string" || !userPath.trim()) {
      throw new FileSkeletonError("paths must contain only non-empty strings.");
    }

    return userPath;
  });
}

function validateLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_FILE_SKELETON_LIMIT;
  }

  if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit <= 0) {
    throw new FileSkeletonError("limit must be a positive integer when provided.");
  }

  return Math.min(limit, MAX_FILE_SKELETON_LIMIT);
}

async function statPath(resolved: ResolvedWorkspacePath): Promise<Stats> {
  try {
    return await fs.lstat(resolved.absolutePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new FileSkeletonError(`Path '${resolved.inputPath}' does not exist.`);
    }

    throw new FileSkeletonError(`Unable to inspect path '${resolved.inputPath}': ${getErrorMessage(error)}`);
  }
}

async function assertRealPathInsideWorkspace(resolved: ResolvedWorkspacePath): Promise<void> {
  let realPath: string;
  try {
    realPath = await fs.realpath(resolved.absolutePath);
  } catch (error) {
    throw new FileSkeletonError(`Unable to resolve path '${resolved.inputPath}': ${getErrorMessage(error)}`);
  }

  if (!isPathInside(resolved.workspaceRoot, realPath)) {
    throw new FileSkeletonError(`Path '${resolved.inputPath}' resolves outside the configured workspace roots.`);
  }
}

function assertSupportedTreeSitterFile(resolved: ResolvedWorkspacePath): void {
  const extension = path.extname(resolved.absolutePath).toLowerCase();
  if (UNSUPPORTED_RICH_EXTENSIONS.has(extension)) {
    throw new FileSkeletonError(
      `Path '${resolved.inputPath}' has unsupported file type '${extension}'. get_file_skeleton currently supports JavaScript and TypeScript source files only.`,
    );
  }

  const extensionWithoutDot = extension.slice(1);
  if (!getSupportedTreeSitterExtensions().includes(extensionWithoutDot as SupportedTreeSitterExtension)) {
    throw new FileSkeletonError(
      `Unsupported get_file_skeleton file extension '${extension || "(none)"}'. Supported extensions: ${getSupportedTreeSitterExtensions()
        .map((ext) => `.${ext}`)
        .join(", ")}.`,
    );
  }
}

function assertReadableSize(resolved: ResolvedWorkspacePath, stat: Stats): void {
  if (stat.size > MAX_FILE_SKELETON_BYTES) {
    throw new FileSkeletonError(
      `Path '${resolved.inputPath}' exceeds the ${MAX_FILE_SKELETON_BYTES_LABEL} get_file_skeleton parse safety cap.`,
    );
  }
}

async function readTextFile(resolved: ResolvedWorkspacePath, stat: Stats): Promise<string> {
  const buffer = await fs.readFile(resolved.absolutePath);

  if (isBinaryLooking(buffer)) {
    throw new FileSkeletonError(`Path '${resolved.inputPath}' appears to be binary or unsupported text.`);
  }

  const decoder = new StringDecoder("utf8");
  const text = decoder.write(buffer) + decoder.end();

  if (stat.size > 0 && text.includes("\uFFFD")) {
    throw new FileSkeletonError(`Path '${resolved.inputPath}' is not valid UTF-8 text.`);
  }

  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function getSignature(node: Parser.SyntaxNode, source: string): string {
  const bodyNode = findFirstDescendant(node, (candidate) => BODY_NODE_TYPES.has(candidate.type));
  const endIndex = bodyNode && bodyNode.startIndex > node.startIndex ? bodyNode.startIndex : node.endIndex;
  return normalizeSignature(source.slice(node.startIndex, endIndex));
}

function getSingleLineSignature(node: Parser.SyntaxNode, source: string): string {
  const lineEnd = source.indexOf("\n", node.startIndex);
  const endIndex = lineEnd === -1 ? node.endIndex : Math.min(lineEnd, node.endIndex);
  return normalizeSignature(source.slice(node.startIndex, endIndex));
}

function normalizeSignature(value: string): string {
  const normalized = value
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();

  if (normalized.length <= 240) {
    return normalized;
  }

  return `${normalized.slice(0, 237)}...`;
}

function getLocation(node: Parser.SyntaxNode): SourceLocation {
  return {
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startByte: node.startIndex,
    endByte: node.endIndex,
  };
}

function extendToDefinitionWrapper(node: Parser.SyntaxNode): Parser.SyntaxNode {
  let current = node;
  while (
    current.parent &&
    ["ambient_declaration", "decorated_definition", "export_statement", "internal_module"].includes(current.parent.type)
  ) {
    current = current.parent;
  }

  return current;
}

function findFirstDescendant(
  node: Parser.SyntaxNode,
  predicate: (candidate: Parser.SyntaxNode) => boolean,
): Parser.SyntaxNode | undefined {
  for (const child of node.namedChildren) {
    if (predicate(child)) {
      return child;
    }

    const nested = findFirstDescendant(child, predicate);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}

function normalizeName(name: string): string {
  return name.replace(/^["'`](.*)["'`]$/u, "$1");
}

function getDefinitionKind(captureName: string): SkeletonEntryKind | undefined {
  const suffix = captureName.split(".").at(-1);
  return suffix && DEFINITION_KINDS.has(suffix as SkeletonEntryKind) ? (suffix as SkeletonEntryKind) : undefined;
}

function getImportName(node: Parser.SyntaxNode): string {
  const sourceNode = node.childForFieldName("source");
  return sourceNode ? normalizeName(sourceNode.text) : "import";
}

function getExportName(node: Parser.SyntaxNode): string {
  const sourceNode = node.childForFieldName("source");
  if (sourceNode) {
    return normalizeName(sourceNode.text);
  }

  return "export";
}

function isExportOnlyStatement(node: Parser.SyntaxNode): boolean {
  if (node.type !== "export_statement") {
    return false;
  }

  return !node.namedChildren.some((child) =>
    [
      "abstract_class_declaration",
      "class_declaration",
      "enum_declaration",
      "function_declaration",
      "generator_function_declaration",
      "interface_declaration",
      "lexical_declaration",
      "type_alias_declaration",
      "variable_declaration",
    ].includes(child.type),
  );
}

function rangeContainsAny(node: Parser.SyntaxNode, ranges: SourceLocation[]): boolean {
  return ranges.some((range) => node.startIndex <= range.startByte && node.endIndex >= range.endByte);
}

function isBinaryLooking(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) {
    return true;
  }

  let controlBytes = 0;
  for (const byte of sample) {
    const allowedControl = byte === 9 || byte === 10 || byte === 12 || byte === 13;
    if (byte < 32 && !allowedControl) {
      controlBytes++;
    }
  }

  return sample.length > 0 && controlBytes / sample.length > 0.05;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof TreeSitterRuntimeError) {
    return `${error.code}: ${error.message}`;
  }

  return error instanceof Error ? error.message : String(error);
}
