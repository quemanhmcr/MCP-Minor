import path from "node:path";

import { getWorkspaceFileSkeleton, type SkeletonEntry } from "../filesystem/file-skeleton.js";
import { parseSourceFile, TreeSitterRuntimeError } from "./runtime.js";

async function main(): Promise<void> {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    throw new Error("Usage: node dist/tree-sitter/smoke.js <file> [file...]");
  }

  for (const file of files) {
    const filePath = path.resolve(file);
    const result = await parseSourceFile({ filePath, includeNodeModulesFallback: false });
    const skeleton = await getWorkspaceFileSkeleton(
      {
        cwd: process.cwd(),
        sessionId: "tree-sitter-smoke",
        workspaceRoots: [process.cwd(), path.resolve(process.cwd(), "..")],
      },
      { paths: [filePath] },
    );
    const skeletonFile = skeleton.files[0];
    const sampleEntries = flattenEntries(skeletonFile.entries)
      .slice(0, 5)
      .map((entry) => ({ kind: entry.kind, name: entry.name }));
    const relativePath = path.relative(process.cwd(), filePath).split(path.sep).join("/");
    console.log(
      JSON.stringify({
        path: relativePath,
        language: result.language.languageId,
        rootNodeType: result.rootNodeType,
        sourceLength: result.sourceLength,
        hasError: result.hasError,
        runtimeAssetFromDist: result.assets.runtimeWasmPath.includes(`${path.sep}dist${path.sep}`),
        grammarAssetFromDist: result.assets.grammarWasmPath.includes(`${path.sep}dist${path.sep}`),
        queryAssetFromDist: result.assets.queryPath.includes(`${path.sep}dist${path.sep}`),
        skeletonSourceLength: skeletonFile.sourceLength,
        skeletonEntries: skeletonFile.entryCount,
        skeletonTruncated: skeletonFile.truncated,
        sampleEntries,
      }),
    );
    result.dispose();
  }
}

function flattenEntries(entries: SkeletonEntry[]): Array<{ kind: string; name: string }> {
  return entries.flatMap((entry) => [entry, ...flattenEntries(entry.children)]);
}

main().catch((error: unknown) => {
  if (error instanceof TreeSitterRuntimeError) {
    console.error(`${error.code}: ${error.message}`);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
