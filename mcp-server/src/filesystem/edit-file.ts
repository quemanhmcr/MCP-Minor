import { promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import type { RuntimeContext } from "../runtime/context.js";
import { contentHash, getAnchorSnapshot, reconcileAnchors } from "../runtime/anchor-state.js";
import { isPathInside, type ResolvedWorkspacePath, resolveWorkspacePath } from "./workspace.js";

export const MAX_EDIT_FILE_BYTES = 1 * 1024 * 1024;

const UNSUPPORTED_EXTENSIONS = new Set([".pdf", ".docx", ".xlsx", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".ico"]);

export class EditFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditFileError";
  }
}

export interface EditFileInput {
  path: string;
  edits: EditFileOperation[];
}

export interface EditFileOperation {
  anchor: string;
  oldText: string;
  newText: string;
}

export interface EditFileAppliedEdit {
  anchor: string;
  startLine: number;
  endLine: number;
  oldText: string;
  newText: string;
  linesRemoved: number;
  linesAdded: number;
}

export interface EditFileResult {
  path: string;
  relativePath: string;
  changed: true;
  editsApplied: number;
  fileHashBefore: string;
  fileHashAfter: string;
  lineEnding: "lf" | "crlf";
  appliedEdits: EditFileAppliedEdit[];
  diff: string;
}

interface TextDocument {
  text: string;
  lines: string[];
  finalNewline: boolean;
  eol: "\n" | "\r\n";
}

interface ResolvedEdit {
  inputIndex: number;
  anchor: string;
  startIndex: number;
  endIndex: number;
  oldLines: string[];
  newLines: string[];
  oldText: string;
  newText: string;
}

export async function editWorkspaceFile(context: RuntimeContext, input: EditFileInput): Promise<EditFileResult> {
  const userPath = validatePath(input.path);
  const edits = validateEdits(input.edits);
  const resolved = resolveWorkspacePath(context, userPath);
  const stat = await statPath(resolved);

  if (stat.isSymbolicLink()) {
    throw new EditFileError(`Path '${resolved.inputPath}' is a symbolic link and will not be followed.`);
  }

  if (!stat.isFile()) {
    if (stat.isDirectory()) {
      throw new EditFileError(`Path '${resolved.inputPath}' is a directory, not a file.`);
    }

    throw new EditFileError(`Path '${resolved.inputPath}' is not a regular file.`);
  }

  await assertRealPathInsideWorkspace(resolved);
  assertSupportedFile(resolved);
  assertEditableSize(resolved, stat);

  const document = await readTextDocument(resolved, stat);
  const snapshot = getAnchorSnapshot(context.sessionId, resolved.absolutePath);
  if (!snapshot) {
    throw new EditFileError(`Path '${resolved.inputPath}' has no anchor state. Call read_file on this file before edit_file.`);
  }

  const resolvedEdits = resolveAndValidateEdits(resolved, document.lines, snapshot.anchors, edits);
  const finalLines = applyResolvedEdits(document.lines, resolvedEdits);
  const finalText = serializeDocument(finalLines, document.eol, document.finalNewline);

  await fs.writeFile(resolved.absolutePath, finalText, "utf8");
  reconcileAnchors(context.sessionId, resolved.absolutePath, finalLines);

  const fileHashBefore = contentHash(document.text);
  const normalizedFinalText = finalLines.join("\n") + (document.finalNewline && finalLines.length > 0 ? "\n" : "");

  return {
    path: resolved.absolutePath,
    relativePath: resolved.relativePath,
    changed: true,
    editsApplied: resolvedEdits.length,
    fileHashBefore,
    fileHashAfter: contentHash(normalizedFinalText),
    lineEnding: document.eol === "\r\n" ? "crlf" : "lf",
    appliedEdits: resolvedEdits
      .slice()
      .sort((left, right) => left.inputIndex - right.inputIndex)
      .map((edit) => ({
        anchor: edit.anchor,
        startLine: edit.startIndex + 1,
        endLine: edit.endIndex + 1,
        oldText: edit.oldText,
        newText: edit.newText,
        linesRemoved: edit.oldLines.length,
        linesAdded: edit.newLines.length,
      })),
    diff: formatDeterministicDiff(resolved.relativePath, resolvedEdits),
  };
}

export function formatEditFileResult(result: EditFileResult): string {
  return [
    `Applied ${result.editsApplied} edit(s) to ${result.relativePath}.`,
    `File hash: ${result.fileHashBefore} -> ${result.fileHashAfter}.`,
    result.diff,
  ].join("\n\n");
}

function validatePath(userPath: unknown): string {
  if (typeof userPath !== "string" || !userPath.trim()) {
    throw new EditFileError("path must be a non-empty string.");
  }

  return userPath;
}

function validateEdits(edits: unknown): EditFileOperation[] {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new EditFileError("edits must be a non-empty array.");
  }

  return edits.map((edit, index) => {
    if (!edit || typeof edit !== "object") {
      throw new EditFileError(`edits[${index}] must be an object.`);
    }

    const candidate = edit as Partial<EditFileOperation>;
    if (typeof candidate.anchor !== "string" || !candidate.anchor.trim()) {
      throw new EditFileError(`edits[${index}].anchor must be a non-empty string.`);
    }

    if (typeof candidate.oldText !== "string") {
      throw new EditFileError(`edits[${index}].oldText must be a string.`);
    }

    if (typeof candidate.newText !== "string") {
      throw new EditFileError(`edits[${index}].newText must be a string.`);
    }

    return {
      anchor: candidate.anchor,
      oldText: normalizeEditText(candidate.oldText),
      newText: normalizeEditText(candidate.newText),
    };
  });
}

async function statPath(resolved: ResolvedWorkspacePath): Promise<Stats> {
  try {
    return await fs.lstat(resolved.absolutePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new EditFileError(`Path '${resolved.inputPath}' does not exist.`);
    }

    throw new EditFileError(`Unable to inspect path '${resolved.inputPath}': ${getErrorMessage(error)}`);
  }
}

async function assertRealPathInsideWorkspace(resolved: ResolvedWorkspacePath): Promise<void> {
  let realPath: string;
  try {
    realPath = await fs.realpath(resolved.absolutePath);
  } catch (error) {
    throw new EditFileError(`Unable to resolve path '${resolved.inputPath}': ${getErrorMessage(error)}`);
  }

  if (!isPathInside(resolved.workspaceRoot, realPath)) {
    throw new EditFileError(`Path '${resolved.inputPath}' resolves outside the configured workspace roots.`);
  }
}

function assertSupportedFile(resolved: ResolvedWorkspacePath): void {
  const extension = path.extname(resolved.absolutePath).toLowerCase();
  if (UNSUPPORTED_EXTENSIONS.has(extension)) {
    throw new EditFileError(
      `Path '${resolved.inputPath}' has unsupported file type '${extension}'. This MCP port currently supports text/code files only.`,
    );
  }
}

function assertEditableSize(resolved: ResolvedWorkspacePath, stat: Stats): void {
  if (stat.size > MAX_EDIT_FILE_BYTES) {
    throw new EditFileError(`Path '${resolved.inputPath}' is too large to edit safely.`);
  }
}

async function readTextDocument(resolved: ResolvedWorkspacePath, stat: Stats): Promise<TextDocument> {
  const buffer = await fs.readFile(resolved.absolutePath);

  if (isBinaryLooking(buffer)) {
    throw new EditFileError(`Path '${resolved.inputPath}' appears to be binary or unsupported text.`);
  }

  const decoder = new StringDecoder("utf8");
  const rawText = decoder.write(buffer) + decoder.end();

  if (stat.size > 0 && rawText.includes("\uFFFD")) {
    throw new EditFileError(`Path '${resolved.inputPath}' is not valid UTF-8 text.`);
  }

  const eol = detectDominantEol(rawText);
  const text = normalizeEditText(rawText);
  const finalNewline = text.endsWith("\n");
  const lines = splitContentLines(text);

  return {
    text: lines.join("\n") + (finalNewline && lines.length > 0 ? "\n" : ""),
    lines,
    finalNewline,
    eol,
  };
}

function resolveAndValidateEdits(
  resolved: ResolvedWorkspacePath,
  currentLines: string[],
  anchors: string[],
  edits: EditFileOperation[],
): ResolvedEdit[] {
  if (anchors.length !== currentLines.length) {
    throw new EditFileError(
      `Path '${resolved.inputPath}' has stale anchor state because its line count changed. Call read_file again before editing.`,
    );
  }

  const anchorToIndex = new Map<string, number>();
  anchors.forEach((anchor, index) => {
    if (!anchorToIndex.has(anchor)) {
      anchorToIndex.set(anchor, index);
    }
  });

  const resolvedEdits = edits.map((edit, inputIndex) => {
    const startIndex = anchorToIndex.get(edit.anchor);
    if (startIndex === undefined) {
      throw new EditFileError(`Anchor '${edit.anchor}' is not known for '${resolved.inputPath}'. Call read_file again before editing.`);
    }

    const oldLines = splitEditLines(edit.oldText);
    const newLines = splitReplacementLines(edit.newText);
    const endIndex = startIndex + oldLines.length - 1;

    if (endIndex >= currentLines.length) {
      throw new EditFileError(`Edit at anchor '${edit.anchor}' extends past the end of '${resolved.inputPath}'.`);
    }

    const actualOldText = currentLines.slice(startIndex, endIndex + 1).join("\n");
    if (actualOldText !== edit.oldText) {
      throw new EditFileError(
        `oldText mismatch at anchor '${edit.anchor}' in '${resolved.inputPath}'. Expected current text '${actualOldText}', received '${edit.oldText}'.`,
      );
    }

    return {
      inputIndex,
      anchor: edit.anchor,
      startIndex,
      endIndex,
      oldLines,
      newLines,
      oldText: edit.oldText,
      newText: edit.newText,
    };
  });

  rejectOverlaps(resolved, resolvedEdits);
  return resolvedEdits;
}

function rejectOverlaps(resolved: ResolvedWorkspacePath, edits: ResolvedEdit[]): void {
  const sorted = [...edits].sort((left, right) => left.startIndex - right.startIndex || left.endIndex - right.endIndex);

  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (current.startIndex <= previous.endIndex) {
      throw new EditFileError(
        `Overlapping edits in '${resolved.inputPath}' are not allowed: anchors '${previous.anchor}' and '${current.anchor}'.`,
      );
    }
  }
}

function applyResolvedEdits(lines: string[], edits: ResolvedEdit[]): string[] {
  const finalLines = [...lines];
  const descending = [...edits].sort((left, right) => right.startIndex - left.startIndex);

  for (const edit of descending) {
    finalLines.splice(edit.startIndex, edit.oldLines.length, ...edit.newLines);
  }

  return finalLines;
}

function formatDeterministicDiff(relativePath: string, edits: ResolvedEdit[]): string {
  const lines = [`*** Update File: ${relativePath}`];
  const ordered = [...edits].sort((left, right) => left.inputIndex - right.inputIndex);

  for (const edit of ordered) {
    lines.push(`@@ ${edit.startIndex + 1},${edit.oldLines.length} -> ${edit.newLines.length} @@`);
    for (const line of edit.oldLines) {
      lines.push(`-${line}`);
    }
    for (const line of edit.newLines) {
      lines.push(`+${line}`);
    }
  }

  return lines.join("\n");
}

function serializeDocument(lines: string[], eol: "\n" | "\r\n", finalNewline: boolean): string {
  if (lines.length === 0) {
    return "";
  }

  return lines.join(eol) + (finalNewline ? eol : "");
}

function splitEditLines(text: string): string[] {
  const lines = text.split("\n");
  return lines.length === 0 ? [""] : lines;
}

function splitReplacementLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

function splitContentLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }

  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }

  return lines;
}

function normalizeEditText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function detectDominantEol(text: string): "\n" | "\r\n" {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const bareLf = (text.match(/(?<!\r)\n/g)?.length ?? 0) + (text.match(/\r(?!\n)/g)?.length ?? 0);

  return crlf > bareLf ? "\r\n" : "\n";
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
  return error instanceof Error ? error.message : String(error);
}
