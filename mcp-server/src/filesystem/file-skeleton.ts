import { promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import type Parser from "web-tree-sitter";

import type { RuntimeContext } from "../runtime/context.js";
import { contentHash } from "../runtime/anchor-state.js";
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
export const DEFAULT_MAX_SIGNATURE_CHARS = 120;
export const MAX_SIGNATURE_CHARS = 500;

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

const LOCATION_ENCODING = "tree-sitter-utf8-byte-offsets";
const MAX_SIGNATURE_LENGTH = 240;

const BODY_NODE_TYPES = new Set(["class_body", "enum_body", "function_body", "statement_block"]);

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
  maxSignatureChars?: number;
}

export interface SourceLocation {
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
}

export interface SkeletonEntry {
  id: string;
  kind: SkeletonEntryKind;
  name: string;
  qualifiedName: string;
  signature: string;
  signatureTruncated: boolean;
  location: SourceLocation;
  containsParseErrors: boolean;
  children: SkeletonEntry[];
}

export interface FileSkeletonEntry {
  path: string;
  relativePath: string;
  language: "javascript" | "typescript" | "tsx";
  rootType: string;
  sourceLength: number;
  sourceLineCount: number;
  locationEncoding: typeof LOCATION_ENCODING;
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

export interface CompactFileSkeletonResult {
  view: "outline" | "signatures";
  files: Array<{
    relativePath: string;
    language: FileSkeletonEntry["language"];
    sourceLength: number;
    sourceLineCount: number;
    hasParseErrors: boolean;
    entryCount: number;
    truncated: boolean;
  }>;
  limit: number;
  truncated: boolean;
}

export interface FileSkeletonFormatOptions {
  view?: "outline" | "signatures";
  includeImports?: boolean;
  maxSignatureChars?: number;
}

interface FlatDefinition {
  kind: SkeletonEntryKind;
  name: string;
  signature: string;
  signatureTruncated: boolean;
  location: SourceLocation;
  containsParseErrors: boolean;
  nodeId: number;
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
  return formatFileSkeletonCompact(result);
}

export function formatFileSkeletonCompact(result: FileSkeletonResult, options: FileSkeletonFormatOptions = {}): string {
  return result.files.map((file) => formatOneFileSkeletonCompact(file, normalizeFormatOptions(options))).join("\n\n");
}

export function compactFileSkeletonResult(
  result: FileSkeletonResult,
  options: FileSkeletonFormatOptions = {},
): CompactFileSkeletonResult {
  const normalized = normalizeFormatOptions(options);
  return {
    view: normalized.view,
    files: result.files.map((file) => ({
      relativePath: file.relativePath,
      language: file.language,
      sourceLength: file.sourceLength,
      sourceLineCount: file.sourceLineCount,
      hasParseErrors: file.hasParseErrors,
      entryCount: file.entryCount,
      truncated: file.truncated,
    })),
    limit: result.limit,
    truncated: result.truncated,
  };
}

function normalizeFormatOptions(options: FileSkeletonFormatOptions): Required<FileSkeletonFormatOptions> {
  return {
    view: options.view ?? "signatures",
    includeImports: options.includeImports ?? true,
    maxSignatureChars: validateMaxSignatureChars(options.maxSignatureChars),
  };
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
    const extracted = extractSkeletonEntries(parsed.tree.rootNode, parsed.query, source, limit, resolved.relativePath);

    return {
      path: resolved.absolutePath,
      relativePath: resolved.relativePath,
      language: parsed.language.languageId,
      rootType: parsed.rootNodeType,
      sourceLength: parsed.sourceLength,
      sourceLineCount: countSourceLines(source),
      locationEncoding: LOCATION_ENCODING,
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

function formatOneFileSkeletonCompact(file: FileSkeletonEntry, options: Required<FileSkeletonFormatOptions>): string {
  const header = [
    `file:${file.relativePath}`,
    languageTag(file.language),
    `${file.sourceLineCount}L`,
    `n:${file.entryCount}${file.truncated ? `/${file.limit}` : ""}`,
    `parse:${file.hasParseErrors ? "err" : "ok"}`,
    file.truncated ? "trunc" : "",
  ].filter(Boolean).join(" | ");

  const lines = [header];
  if (options.includeImports) {
    const imports = formatGroupedImports(file.entries);
    const exports = formatGroupedExports(file.entries);
    if (imports) {
      lines.push(imports);
    }
    if (exports) {
      lines.push(exports);
    }
  }

  for (const entry of file.entries.filter((entry) => entry.kind !== "import" && entry.kind !== "export")) {
    appendSkeletonEntry(lines, entry, 0, options);
  }
  return lines.join("\n");
}

function appendSkeletonEntry(
  lines: string[],
  entry: SkeletonEntry,
  depth: number,
  options: Required<FileSkeletonFormatOptions>,
): void {
  const indent = "  ".repeat(depth);
  const range = formatLineRange(entry.location);
  const signature = options.view === "signatures" && entry.signature
    ? trimSignatureForOutput(entry.signature, options.maxSignatureChars)
    : { text: "", truncated: false };
  const flags = [
    entry.signatureTruncated || signature.truncated ? " sig-trunc" : "",
    entry.containsParseErrors ? " parse-error" : "",
  ].join("");
  const signatureText = signature.text ? ` ${signature.text}` : "";

  lines.push(`${indent}${kindTag(entry.kind)} ${entry.name} ${range}${signatureText}${flags}`);
  for (const child of entry.children) {
    appendSkeletonEntry(lines, child, depth + 1, options);
  }
}

function formatLineRange(location: SourceLocation): string {
  return location.startLine === location.endLine ? `L${location.startLine}` : `L${location.startLine}-${location.endLine}`;
}

function kindTag(kind: SkeletonEntryKind): string {
  switch (kind) {
    case "class":
      return "cls";
    case "enum":
      return "enum";
    case "function":
      return "fn";
    case "interface":
      return "iface";
    case "method":
      return "fn";
    case "module":
      return "mod";
    case "type":
      return "type";
    case "export":
      return "exp";
    case "import":
      return "imp";
  }
}

function languageTag(language: FileSkeletonEntry["language"]): string {
  return language === "typescript" ? "ts" : language;
}

function formatGroupedImports(entries: SkeletonEntry[]): string {
  const imports = entries.filter((entry) => entry.kind === "import").map((entry) => formatImportEntry(entry));
  return imports.length === 0 ? "" : `imp: ${imports.join("; ")}`;
}

function formatGroupedExports(entries: SkeletonEntry[]): string {
  const exports = entries.filter((entry) => entry.kind === "export").map((entry) => trimExportSignature(entry.signature));
  return exports.length === 0 ? "" : `exp: ${exports.join("; ")}`;
}

function formatImportEntry(entry: SkeletonEntry): string {
  const signature = entry.signature;
  const source = entry.name;
  const named = signature.match(/\{\s*([^}]+?)\s*\}/u)?.[1]?.replace(/\s+/gu, "");
  if (named) {
    return `${source}{${named}}`;
  }

  if (signature.includes("* as ")) {
    return `${source}*`;
  }

  const defaultMatch = signature.match(/^import\s+([A-Za-z_$][\w$]*)\s+from/u);
  if (defaultMatch) {
    return `${source}{default=${defaultMatch[1]}}`;
  }

  return source;
}

function trimExportSignature(signature: string): string {
  return signature
    .replace(/^export\s+/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function trimSignatureForOutput(signature: string, maxSignatureChars: number): SignatureResult {
  const compact = signature.replace(/\s+/gu, " ").trim();
  if (compact.length <= maxSignatureChars) {
    return { text: compact, truncated: false };
  }

  return { text: `${compact.slice(0, Math.max(0, maxSignatureChars - 3)).trimEnd()}...`, truncated: true };
}

function countSourceLines(source: string): number {
  if (source.length === 0) {
    return 0;
  }

  const normalized = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

function extractSkeletonEntries(
  rootNode: Parser.SyntaxNode,
  query: Parser.Query,
  source: string,
  limit: number,
  relativePath: string,
): { entries: SkeletonEntry[]; entryCount: number; truncated: boolean } {
  const definitions = [...extractDefinitions(rootNode, query, source), ...extractAnonymousDefaultDefinitions(rootNode, source)];
  const importsAndExports = extractImportExportEntries(rootNode, source, definitions, relativePath);
  const allEntries = [...importsAndExports, ...nestDefinitions(definitions, relativePath)].sort(compareEntries);
  const limited = takeEntriesPreorder(allEntries, limit);

  return {
    entries: limited.entries,
    entryCount: countEntries(allEntries),
    truncated: limited.truncated,
  };
}

function extractDefinitions(rootNode: Parser.SyntaxNode, query: Parser.Query, source: string): FlatDefinition[] {
  const pairs = findNamedCapturePairs(rootNode, query);
  const definitions = new Map<string, FlatDefinition>();

  for (const pair of pairs) {
    const kind = getDefinitionKind(pair.definitionCapture.name);
    if (!kind || !DEFINITION_KINDS.has(kind)) {
      continue;
    }

    const rangeNode = extendToDefinitionWrapper(pair.definitionCapture.node);
    const definitionKey = `${rangeNode.id}:${pair.nameCapture.node.id}`;
    if (definitions.has(definitionKey)) {
      continue;
    }
    const signature = getSignature(rangeNode, source);

    definitions.set(definitionKey, {
      kind,
      name: normalizeName(pair.nameCapture.node.text),
      signature: signature.text,
      signatureTruncated: signature.truncated,
      location: getLocation(rangeNode),
      containsParseErrors: containsParseErrors(rangeNode),
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
  relativePath: string,
): SkeletonEntry[] {
  const definitionRanges = definitions.map((definition) => definition.location);
  const entries: SkeletonEntry[] = [];

  for (const child of rootNode.namedChildren) {
    if (child.type === "import_statement") {
      entries.push({
        id: createEntryId(relativePath, "import", getImportName(child), getImportName(child), getLocation(child), getSingleLineSignature(child, source).text),
        kind: "import",
        name: getImportName(child),
        qualifiedName: getImportName(child),
        signature: getSingleLineSignature(child, source).text,
        signatureTruncated: getSingleLineSignature(child, source).truncated,
        location: getLocation(child),
        containsParseErrors: containsParseErrors(child),
        children: [],
      });
      continue;
    }

    if (isExportOnlyStatement(child) && !rangeContainsAny(child, definitionRanges)) {
      const signature = getSingleLineSignature(child, source);
      const name = getExportName(child);
      entries.push({
        id: createEntryId(relativePath, "export", name, name, getLocation(child), signature.text),
        kind: "export",
        name,
        qualifiedName: name,
        signature: signature.text,
        signatureTruncated: signature.truncated,
        location: getLocation(child),
        containsParseErrors: containsParseErrors(child),
        children: [],
      });
    }
  }

  return entries;
}

function extractAnonymousDefaultDefinitions(rootNode: Parser.SyntaxNode, source: string): FlatDefinition[] {
  const definitions: FlatDefinition[] = [];

  for (const child of rootNode.namedChildren) {
    if (child.type !== "export_statement") {
      continue;
    }

    const valueNode = child.childForFieldName("value") ?? child.namedChildren[0];
    const kind = getAnonymousDefaultKind(valueNode);
    if (!kind) {
      continue;
    }

    const signature = getSignature(child, source);
    definitions.push({
      kind,
      name: "default",
      signature: signature.text,
      signatureTruncated: signature.truncated,
      location: getLocation(child),
      containsParseErrors: containsParseErrors(child),
      nodeId: child.id,
      children: [],
    });
  }

  return definitions;
}

function getAnonymousDefaultKind(node: Parser.SyntaxNode | null): "class" | "function" | undefined {
  if (!node) {
    return undefined;
  }

  if (node.type === "class") {
    return "class";
  }

  if (["arrow_function", "function_expression", "generator_function"].includes(node.type)) {
    return "function";
  }

  return undefined;
}

function nestDefinitions(definitions: FlatDefinition[], relativePath: string): SkeletonEntry[] {
  const byId = new Map(definitions.map((definition) => [definition.nodeId, definition]));
  const roots: FlatDefinition[] = [];

  for (const definition of definitions) {
    const parent = findSmallestContainingDefinition(definition, definitions);
    if (parent) {
      parent.children.push(definition);
    } else {
      roots.push(definition);
    }
  }

  for (const definition of byId.values()) {
    definition.children.sort(compareFlatDefinitions);
  }

  return roots.sort(compareFlatDefinitions).map((definition) => flatDefinitionToEntry(definition, relativePath));
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
        candidate.location.endByte >= definition.location.endByte &&
        rangeSize(candidate.location) > rangeSize(definition.location),
    )
    .sort((a, b) => rangeSize(a.location) - rangeSize(b.location))[0];
}

function flatDefinitionToEntry(
  definition: FlatDefinition,
  relativePath: string,
  parentQualifiedName?: string,
): SkeletonEntry {
  const qualifiedName = parentQualifiedName ? `${parentQualifiedName}.${definition.name}` : definition.name;
  return {
    id: createEntryId(relativePath, definition.kind, definition.name, qualifiedName, definition.location, definition.signature),
    kind: definition.kind,
    name: definition.name,
    qualifiedName,
    signature: definition.signature,
    signatureTruncated: definition.signatureTruncated,
    location: definition.location,
    containsParseErrors: definition.containsParseErrors,
    children: definition.children.map((child) => flatDefinitionToEntry(child, relativePath, qualifiedName)),
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

function validateMaxSignatureChars(maxSignatureChars: number | undefined): number {
  if (maxSignatureChars === undefined) {
    return DEFAULT_MAX_SIGNATURE_CHARS;
  }

  if (!Number.isFinite(maxSignatureChars) || !Number.isInteger(maxSignatureChars) || maxSignatureChars <= 0) {
    throw new FileSkeletonError("maxSignatureChars must be a positive integer when provided.");
  }

  return Math.min(maxSignatureChars, MAX_SIGNATURE_CHARS);
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

  return text;
}

interface SignatureResult {
  text: string;
  truncated: boolean;
}

function getSignature(node: Parser.SyntaxNode, source: string): SignatureResult {
  const bodyNode = findSignatureBodyNode(node);
  const shouldCutAtBody = bodyNode && BODY_NODE_TYPES.has(bodyNode.type) && bodyNode.startIndex > node.startIndex;
  const endIndex = shouldCutAtBody ? bodyNode.startIndex : node.endIndex;
  return normalizeSignature(source.slice(node.startIndex, endIndex));
}

function getSingleLineSignature(node: Parser.SyntaxNode, source: string): SignatureResult {
  const lineEnd = source.indexOf("\n", node.startIndex);
  const endIndex = lineEnd === -1 ? node.endIndex : Math.min(lineEnd, node.endIndex);
  return normalizeSignature(source.slice(node.startIndex, endIndex));
}

function normalizeSignature(value: string): SignatureResult {
  const normalized = value
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();

  if (normalized.length <= MAX_SIGNATURE_LENGTH) {
    return {
      text: normalized,
      truncated: false,
    };
  }

  return {
    text: `${normalized.slice(0, MAX_SIGNATURE_LENGTH - 3)}...`,
    truncated: true,
  };
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

function findSignatureBodyNode(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  const directBody = node.childForFieldName("body");
  if (directBody) {
    return directBody;
  }

  for (const child of node.namedChildren) {
    const childBody = child.childForFieldName("body");
    if (childBody) {
      return childBody;
    }
  }

  for (const child of node.namedChildren) {
    const nested = findSignatureBodyNode(child);
    if (nested) {
      return nested;
    }
  }

  return findFirstDescendant(node, (candidate) => BODY_NODE_TYPES.has(candidate.type));
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

  if (getAnonymousDefaultKind(node.childForFieldName("value") ?? node.namedChildren[0])) {
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

function containsParseErrors(node: Parser.SyntaxNode): boolean {
  if (node.hasError || node.isError || node.isMissing) {
    return true;
  }

  return node.namedChildren.some((child) => containsParseErrors(child));
}

function createEntryId(
  relativePath: string,
  kind: SkeletonEntryKind,
  name: string,
  qualifiedName: string,
  location: SourceLocation,
  signature: string,
): string {
  return `S${contentHash(
    `${relativePath}\0${kind}\0${name}\0${qualifiedName}\0${location.startByte}\0${location.endByte}\0${signature}`,
  )}`;
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
