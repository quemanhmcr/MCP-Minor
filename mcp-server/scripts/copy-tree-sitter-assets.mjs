import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distAssetsRoot = path.join(packageRoot, "dist", "tree-sitter", "assets");
const sourceQueriesRoot = path.join(packageRoot, "src", "tree-sitter", "queries");
const wasmTargets = [
  {
    from: path.join(packageRoot, "node_modules", "web-tree-sitter", "tree-sitter.wasm"),
    to: path.join(distAssetsRoot, "wasm", "tree-sitter.wasm"),
  },
  {
    from: path.join(packageRoot, "node_modules", "tree-sitter-wasms", "out", "tree-sitter-javascript.wasm"),
    to: path.join(distAssetsRoot, "wasm", "tree-sitter-javascript.wasm"),
  },
  {
    from: path.join(packageRoot, "node_modules", "tree-sitter-wasms", "out", "tree-sitter-typescript.wasm"),
    to: path.join(distAssetsRoot, "wasm", "tree-sitter-typescript.wasm"),
  },
  {
    from: path.join(packageRoot, "node_modules", "tree-sitter-wasms", "out", "tree-sitter-tsx.wasm"),
    to: path.join(distAssetsRoot, "wasm", "tree-sitter-tsx.wasm"),
  },
];

await rm(distAssetsRoot, { recursive: true, force: true });
await mkdir(path.join(distAssetsRoot, "wasm"), { recursive: true });
await mkdir(path.join(distAssetsRoot, "queries"), { recursive: true });

for (const target of wasmTargets) {
  await cp(target.from, target.to);
}

await cp(sourceQueriesRoot, path.join(distAssetsRoot, "queries"), { recursive: true });
