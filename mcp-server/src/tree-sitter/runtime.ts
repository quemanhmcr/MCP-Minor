import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Parser from "web-tree-sitter";

export type SupportedTreeSitterLanguageId = "javascript" | "typescript" | "tsx";
export type SupportedTreeSitterExtension = "cjs" | "js" | "jsx" | "mjs" | "ts" | "tsx";

export interface TreeSitterLanguageDescriptor {
  extension: SupportedTreeSitterExtension;
  languageId: SupportedTreeSitterLanguageId;
  grammarFileName: string;
  queryFileName: "javascript.scm" | "typescript.scm";
}

export interface TreeSitterAssetPaths {
  runtimeWasmPath: string;
  grammarWasmPath: string;
  queryPath: string;
}

export interface TreeSitterAssetResolutionOptions {
  moduleUrl?: string;
  assetRoots?: string[];
  includeNodeModulesFallback?: boolean;
}

export interface TreeSitterParseOptions extends TreeSitterAssetResolutionOptions {
  filePath: string;
  source?: string;
}

export interface TreeSitterParseResult {
  filePath: string;
  language: TreeSitterLanguageDescriptor;
  assets: TreeSitterAssetPaths;
  source: string;
  sourceLength: number;
  treeSitterLanguage: Parser.Language;
  query: Parser.Query;
  tree: Parser.Tree;
  rootNodeType: string;
  hasError: boolean;
  dispose: () => void;
}

export type TreeSitterErrorCode =
  | "unsupported_language"
  | "missing_asset"
  | "init_failed"
  | "language_load_failed"
  | "query_load_failed"
  | "parse_failed";

export class TreeSitterRuntimeError extends Error {
  constructor(
    readonly code: TreeSitterErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TreeSitterRuntimeError";
  }
}

const SUPPORTED_LANGUAGES = new Map<SupportedTreeSitterExtension, TreeSitterLanguageDescriptor>([
  [
    "cjs",
    {
      extension: "cjs",
      languageId: "javascript",
      grammarFileName: "tree-sitter-javascript.wasm",
      queryFileName: "javascript.scm",
    },
  ],
  [
    "js",
    {
      extension: "js",
      languageId: "javascript",
      grammarFileName: "tree-sitter-javascript.wasm",
      queryFileName: "javascript.scm",
    },
  ],
  [
    "jsx",
    {
      extension: "jsx",
      languageId: "javascript",
      grammarFileName: "tree-sitter-javascript.wasm",
      queryFileName: "javascript.scm",
    },
  ],
  [
    "mjs",
    {
      extension: "mjs",
      languageId: "javascript",
      grammarFileName: "tree-sitter-javascript.wasm",
      queryFileName: "javascript.scm",
    },
  ],
  [
    "ts",
    {
      extension: "ts",
      languageId: "typescript",
      grammarFileName: "tree-sitter-typescript.wasm",
      queryFileName: "typescript.scm",
    },
  ],
  [
    "tsx",
    {
      extension: "tsx",
      languageId: "tsx",
      grammarFileName: "tree-sitter-tsx.wasm",
      queryFileName: "typescript.scm",
    },
  ],
]);

const requireFromRuntime = createRequire(import.meta.url);

let parserInitPromise: Promise<void> | undefined;
let initializedRuntimeWasmPath: string | undefined;
const languageCache = new Map<string, Parser.Language>();
const queryCache = new Map<string, Parser.Query>();

export function getSupportedTreeSitterExtensions(): SupportedTreeSitterExtension[] {
  return Array.from(SUPPORTED_LANGUAGES.keys());
}

export function getTreeSitterLanguageForPath(filePath: string): TreeSitterLanguageDescriptor {
  const extension = path.extname(filePath).toLowerCase().slice(1);
  const descriptor = SUPPORTED_LANGUAGES.get(extension as SupportedTreeSitterExtension);

  if (!descriptor) {
    throw new TreeSitterRuntimeError(
      "unsupported_language",
      `Unsupported tree-sitter file extension '.${extension || "(none)"}'. Supported extensions: ${getSupportedTreeSitterExtensions()
        .map((ext) => `.${ext}`)
        .join(", ")}.`,
      { filePath, extension },
    );
  }

  return descriptor;
}

export function resolveTreeSitterAssets(
  descriptor: TreeSitterLanguageDescriptor,
  options: TreeSitterAssetResolutionOptions = {},
): TreeSitterAssetPaths {
  const assetRoots = options.assetRoots ?? getDefaultAssetRoots(options.moduleUrl ?? import.meta.url);
  const includeNodeModulesFallback = options.includeNodeModulesFallback ?? true;
  const packageAssets = includeNodeModulesFallback ? getPackageAssetRoots() : {};

  return {
    runtimeWasmPath: resolveExistingAsset("tree-sitter.wasm", [
      ...assetRoots.map((root) => path.join(root, "wasm")),
      ...assetRoots,
      ...(packageAssets.webTreeSitterDir ? [packageAssets.webTreeSitterDir] : []),
    ]),
    grammarWasmPath: resolveExistingAsset(descriptor.grammarFileName, [
      ...assetRoots.map((root) => path.join(root, "wasm")),
      ...assetRoots,
      ...(packageAssets.treeSitterWasmsOutDir ? [packageAssets.treeSitterWasmsOutDir] : []),
    ]),
    queryPath: resolveExistingAsset(descriptor.queryFileName, [
      ...assetRoots.map((root) => path.join(root, "queries")),
      ...assetRoots,
    ]),
  };
}

export async function parseSourceFile(options: TreeSitterParseOptions): Promise<TreeSitterParseResult> {
  const descriptor = getTreeSitterLanguageForPath(options.filePath);
  const assets = resolveTreeSitterAssets(descriptor, options);
  const source = options.source ?? (await fs.readFile(options.filePath, "utf8"));

  await initializeTreeSitter(assets.runtimeWasmPath);
  const language = await loadLanguage(descriptor, assets.grammarWasmPath);
  const parser = new Parser();
  parser.setLanguage(language);

  const query = await loadQuery(language, descriptor, assets.queryPath);
  const tree = parser.parse(source);
  if (!tree?.rootNode) {
    throw new TreeSitterRuntimeError("parse_failed", `tree-sitter returned no parse tree for '${options.filePath}'.`, {
      filePath: options.filePath,
      languageId: descriptor.languageId,
    });
  }

  return {
    filePath: options.filePath,
    language: descriptor,
    assets,
    source,
    sourceLength: source.length,
    treeSitterLanguage: language,
    query,
    tree,
    rootNodeType: tree.rootNode.type,
    hasError: tree.rootNode.hasError,
    dispose: () => {
      tree.delete();
    },
  };
}

async function initializeTreeSitter(runtimeWasmPath: string): Promise<void> {
  const normalizedRuntimeWasmPath = path.resolve(runtimeWasmPath);
  if (parserInitPromise) {
    if (initializedRuntimeWasmPath !== normalizedRuntimeWasmPath) {
      throw new TreeSitterRuntimeError(
        "init_failed",
        `tree-sitter runtime is already initialized from '${initializedRuntimeWasmPath}' and cannot be re-initialized with '${normalizedRuntimeWasmPath}'. Parser.init() is process-global.`,
      );
    }

    return parserInitPromise;
  }

  initializedRuntimeWasmPath = normalizedRuntimeWasmPath;
  parserInitPromise ??= Parser.init({
    locateFile(scriptName: string) {
      return scriptName === "tree-sitter.wasm"
        ? normalizedRuntimeWasmPath
        : path.join(path.dirname(normalizedRuntimeWasmPath), scriptName);
    },
  }).catch((error: unknown) => {
    parserInitPromise = undefined;
    initializedRuntimeWasmPath = undefined;
    throw new TreeSitterRuntimeError("init_failed", `Failed to initialize tree-sitter runtime: ${formatError(error)}`);
  });

  return parserInitPromise;
}

async function loadLanguage(
  descriptor: TreeSitterLanguageDescriptor,
  grammarWasmPath: string,
): Promise<Parser.Language> {
  const cacheKey = `${descriptor.languageId}:${grammarWasmPath}`;
  const cachedLanguage = languageCache.get(cacheKey);
  if (cachedLanguage) {
    return cachedLanguage;
  }

  try {
    const language = await Parser.Language.load(grammarWasmPath);
    languageCache.set(cacheKey, language);
    return language;
  } catch (error) {
    throw new TreeSitterRuntimeError(
      "language_load_failed",
      `Failed to load tree-sitter grammar '${descriptor.grammarFileName}': ${formatError(error)}`,
      { grammarWasmPath },
    );
  }
}

async function loadQuery(
  language: Parser.Language,
  descriptor: TreeSitterLanguageDescriptor,
  queryPath: string,
): Promise<Parser.Query> {
  const queryText = await fs.readFile(queryPath, "utf8");
  const cacheKey = `${descriptor.languageId}:${path.resolve(queryPath)}`;
  const cachedQuery = queryCache.get(cacheKey);
  if (cachedQuery) {
    return cachedQuery;
  }

  try {
    const query = language.query(queryText);
    queryCache.set(cacheKey, query);
    return query;
  } catch (error) {
    throw new TreeSitterRuntimeError(
      "query_load_failed",
      `Failed to compile tree-sitter query '${path.basename(queryPath)}' for ${descriptor.languageId}: ${formatError(error)}`,
      { queryPath, languageId: descriptor.languageId },
    );
  }
}

function resolveExistingAsset(fileName: string, directories: string[]): string {
  const checkedPaths = directories.map((directory) => path.resolve(directory, fileName));
  const foundPath = checkedPaths.find((candidate) => existsSync(candidate));

  if (!foundPath) {
    throw new TreeSitterRuntimeError("missing_asset", `Missing tree-sitter asset '${fileName}'.`, {
      fileName,
      checkedPaths,
    });
  }

  return foundPath;
}

function getDefaultAssetRoots(moduleUrl: string): string[] {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  return [
    path.join(moduleDir, "assets"), // built dist layout: dist/tree-sitter/assets/{wasm,queries}
    moduleDir, // source/test layout: src/tree-sitter/queries plus package WASM fallback
  ];
}

function getPackageAssetRoots(): { webTreeSitterDir?: string; treeSitterWasmsOutDir?: string } {
  const webTreeSitterDir = resolvePackageDir("web-tree-sitter");
  const treeSitterWasmsDir = resolvePackageDir("tree-sitter-wasms");

  return {
    webTreeSitterDir,
    treeSitterWasmsOutDir: treeSitterWasmsDir ? path.join(treeSitterWasmsDir, "out") : undefined,
  };
}

function resolvePackageDir(packageName: string): string | undefined {
  try {
    return path.dirname(requireFromRuntime.resolve(`${packageName}/package.json`));
  } catch {
    return undefined;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
