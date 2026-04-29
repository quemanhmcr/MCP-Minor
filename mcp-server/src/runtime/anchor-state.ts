import path from "node:path";

const ANCHOR_DELIMITER = "\u00a7";
const MAX_TRACKED_LINES = 50_000;
const MAX_TRACKED_FILES = 1_024;
const MAX_TRACKED_SESSIONS = 50;

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
  const previousByHash = new Map<number, string[]>();

  if (tracked) {
    for (let index = 0; index < tracked.hashes.length; index++) {
      const hash = tracked.hashes[index];
      const existing = previousByHash.get(hash);
      if (existing) {
        existing.push(tracked.anchors[index]);
      } else {
        previousByHash.set(hash, [tracked.anchors[index]]);
      }
    }
  }

  const used = new Set<string>();
  const occurrenceByHash = new Map<number, number>();

  return Array.from(currentHashes, (lineHash) => {
    const previous = previousByHash.get(lineHash);
    const preserved = previous?.shift();
    if (preserved && !used.has(preserved)) {
      used.add(preserved);
      return preserved;
    }

    const occurrence = occurrenceByHash.get(lineHash) ?? 0;
    occurrenceByHash.set(lineHash, occurrence + 1);

    let salt = 0;
    while (true) {
      const anchor = createAnchor(sessionId, documentKey, lineHash, occurrence, salt);
      if (!used.has(anchor)) {
        used.add(anchor);
        return anchor;
      }
      salt++;
    }
  });
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
