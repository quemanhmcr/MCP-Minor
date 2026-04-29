import path from "node:path";

const ANCHOR_DELIMITER = "\u00a7";
const MAX_TRACKED_LINES = 50_000;
const MAX_TRACKED_FILES = 1_024;
const MAX_TRACKED_SESSIONS = 50;
const MAX_LCS_CELLS = 4_000_000;

interface TrackedDocument {
  hashes: Uint32Array;
  anchors: string[];
}

const storage = new Map<string, Map<string, TrackedDocument>>();

export function getAnchorDelimiter(): string {
  return ANCHOR_DELIMITER;
}

export function contentHash(content: string): string {
  return fnv1aHex(content);
}

export function formatLineWithAnchor(content: string, anchor: string): string {
  return `${anchor}${ANCHOR_DELIMITER}${content}`;
}

export function reconcileAnchors(sessionId: string, absolutePath: string, lines: string[]): string[] {
  if (lines.length > MAX_TRACKED_LINES) {
    return lines.map((_, index) => `L${index + 1}`);
  }

  const sessionState = getSessionState(sessionId);
  const documentKey = normalizeAbsolutePath(absolutePath);
  const currentHashes = computeLineHashes(lines);
  const tracked = sessionState.get(documentKey);

  if (tracked && hashesEqual(tracked.hashes, currentHashes)) {
    refreshDocument(sessionState, documentKey, tracked);
    return tracked.anchors;
  }

  const anchors = assignAnchors(sessionId, documentKey, currentHashes, tracked);
  refreshDocument(sessionState, documentKey, {
    hashes: currentHashes,
    anchors,
  });

  return anchors;
}

export function resetAnchorState(sessionId?: string): void {
  if (sessionId === undefined) {
    storage.clear();
    return;
  }

  storage.delete(sessionId);
}

function assignAnchors(
  sessionId: string,
  documentKey: string,
  currentHashes: Uint32Array,
  tracked: TrackedDocument | undefined,
): string[] {
  const matchedCurrentToPrevious = tracked ? matchUnchangedLines(tracked.hashes, currentHashes) : new Map<number, number>();
  const historicalAnchors = tracked ? new Set(tracked.anchors) : new Set<string>();
  const used = new Set<string>();
  const occurrenceByHash = new Map<number, number>();

  return Array.from(currentHashes, (lineHash, currentIndex) => {
    const occurrence = occurrenceByHash.get(lineHash) ?? 0;
    occurrenceByHash.set(lineHash, occurrence + 1);

    const previousIndex = matchedCurrentToPrevious.get(currentIndex);
    const preserved = previousIndex === undefined ? undefined : tracked?.anchors[previousIndex];
    if (preserved !== undefined && !used.has(preserved)) {
      used.add(preserved);
      return preserved;
    }

    let salt = 0;
    while (true) {
      const anchor = createAnchor(sessionId, documentKey, lineHash, occurrence, salt);
      if (!used.has(anchor) && !historicalAnchors.has(anchor)) {
        used.add(anchor);
        return anchor;
      }
      salt++;
    }
  });
}

function matchUnchangedLines(previousHashes: Uint32Array, currentHashes: Uint32Array): Map<number, number> {
  const matches = new Map<number, number>();
  let previousStart = 0;
  let currentStart = 0;
  let previousEnd = previousHashes.length - 1;
  let currentEnd = currentHashes.length - 1;

  while (
    previousStart <= previousEnd &&
    currentStart <= currentEnd &&
    previousHashes[previousStart] === currentHashes[currentStart]
  ) {
    matches.set(currentStart, previousStart);
    previousStart++;
    currentStart++;
  }

  const suffixMatches: Array<[number, number]> = [];
  while (
    previousStart <= previousEnd &&
    currentStart <= currentEnd &&
    previousHashes[previousEnd] === currentHashes[currentEnd]
  ) {
    suffixMatches.push([currentEnd, previousEnd]);
    previousEnd--;
    currentEnd--;
  }

  const previousLength = Math.max(0, previousEnd - previousStart + 1);
  const currentLength = Math.max(0, currentEnd - currentStart + 1);

  if (previousLength > 0 && currentLength > 0) {
    const middleMatches =
      previousLength * currentLength <= MAX_LCS_CELLS
        ? matchMiddleWithLcs(previousHashes, currentHashes, previousStart, currentStart, previousLength, currentLength)
        : matchMiddleGreedily(previousHashes, currentHashes, previousStart, currentStart, previousLength, currentLength);

    for (const [currentIndex, previousIndex] of middleMatches) {
      matches.set(currentIndex, previousIndex);
    }
  }

  for (let index = suffixMatches.length - 1; index >= 0; index--) {
    const [currentIndex, previousIndex] = suffixMatches[index];
    matches.set(currentIndex, previousIndex);
  }

  return matches;
}

function matchMiddleWithLcs(
  previousHashes: Uint32Array,
  currentHashes: Uint32Array,
  previousStart: number,
  currentStart: number,
  previousLength: number,
  currentLength: number,
): Array<[number, number]> {
  const width = currentLength + 1;
  const directions = new Uint8Array((previousLength + 1) * width);
  let previousRow = new Uint32Array(width);
  let currentRow = new Uint32Array(width);

  for (let oldOffset = 1; oldOffset <= previousLength; oldOffset++) {
    const previousHash = previousHashes[previousStart + oldOffset - 1];
    for (let currentOffset = 1; currentOffset <= currentLength; currentOffset++) {
      const cell = oldOffset * width + currentOffset;
      if (previousHash === currentHashes[currentStart + currentOffset - 1]) {
        currentRow[currentOffset] = previousRow[currentOffset - 1] + 1;
        directions[cell] = 1;
      } else if (previousRow[currentOffset] >= currentRow[currentOffset - 1]) {
        currentRow[currentOffset] = previousRow[currentOffset];
        directions[cell] = 2;
      } else {
        currentRow[currentOffset] = currentRow[currentOffset - 1];
        directions[cell] = 3;
      }
    }

    [previousRow, currentRow] = [currentRow, previousRow];
    currentRow.fill(0);
  }

  const matches: Array<[number, number]> = [];
  let oldOffset = previousLength;
  let currentOffset = currentLength;

  while (oldOffset > 0 && currentOffset > 0) {
    const direction = directions[oldOffset * width + currentOffset];
    if (direction === 1) {
      matches.push([currentStart + currentOffset - 1, previousStart + oldOffset - 1]);
      oldOffset--;
      currentOffset--;
    } else if (direction === 2) {
      oldOffset--;
    } else {
      currentOffset--;
    }
  }

  matches.reverse();
  return matches;
}

function matchMiddleGreedily(
  previousHashes: Uint32Array,
  currentHashes: Uint32Array,
  previousStart: number,
  currentStart: number,
  previousLength: number,
  currentLength: number,
): Array<[number, number]> {
  const previousIndexesByHash = new Map<number, number[]>();
  const previousEnd = previousStart + previousLength;
  for (let previousIndex = previousStart; previousIndex < previousEnd; previousIndex++) {
    const lineIndexes = previousIndexesByHash.get(previousHashes[previousIndex]);
    if (lineIndexes) {
      lineIndexes.push(previousIndex);
    } else {
      previousIndexesByHash.set(previousHashes[previousIndex], [previousIndex]);
    }
  }

  const matches: Array<[number, number]> = [];
  let minimumPreviousIndex = previousStart;
  const currentEnd = currentStart + currentLength;

  for (let currentIndex = currentStart; currentIndex < currentEnd; currentIndex++) {
    const candidates = previousIndexesByHash.get(currentHashes[currentIndex]);
    if (!candidates) {
      continue;
    }

    while (candidates.length > 0 && candidates[0] < minimumPreviousIndex) {
      candidates.shift();
    }

    const previousIndex = candidates.shift();
    if (previousIndex !== undefined) {
      matches.push([currentIndex, previousIndex]);
      minimumPreviousIndex = previousIndex + 1;
    }
  }

  return matches;
}

function createAnchor(sessionId: string, documentKey: string, lineHash: number, occurrence: number, salt: number): string {
  return `A${fnv1aHex(`${sessionId}\0${documentKey}\0${lineHash}\0${occurrence}\0${salt}`)}`;
}

function computeLineHashes(lines: string[]): Uint32Array {
  const hashes = new Uint32Array(lines.length);

  for (let index = 0; index < lines.length; index++) {
    hashes[index] = fnv1a(lines[index]);
  }

  return hashes;
}

function getSessionState(sessionId: string): Map<string, TrackedDocument> {
  const existing = storage.get(sessionId);
  if (existing) {
    storage.delete(sessionId);
    storage.set(sessionId, existing);
    return existing;
  }

  const created = new Map<string, TrackedDocument>();
  storage.set(sessionId, created);

  if (storage.size > MAX_TRACKED_SESSIONS) {
    const oldestSessionId = storage.keys().next().value;
    if (oldestSessionId !== undefined) {
      storage.delete(oldestSessionId);
    }
  }

  return created;
}

function refreshDocument(sessionState: Map<string, TrackedDocument>, documentKey: string, document: TrackedDocument): void {
  sessionState.delete(documentKey);
  sessionState.set(documentKey, document);

  if (sessionState.size > MAX_TRACKED_FILES) {
    const oldestDocument = sessionState.keys().next().value;
    if (oldestDocument !== undefined) {
      sessionState.delete(oldestDocument);
    }
  }
}

function hashesEqual(left: Uint32Array, right: Uint32Array): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function fnv1aHex(value: string): string {
  return fnv1a(value).toString(16).padStart(8, "0");
}

function fnv1a(value: string): number {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index++) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  }

  return hash >>> 0;
}

function normalizeAbsolutePath(absolutePath: string): string {
  const normalized = path.resolve(absolutePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
