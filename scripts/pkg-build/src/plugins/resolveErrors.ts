import { Package } from "@manypkg/get-packages";
import path from "node:path";
import normalizePath from "normalize-path";
import { Plugin } from "rollup";
import { PackagePredicate } from "../makePackagePredicate";

export function resolveErrors({
  bundledDependenciesDirs,
  bundledIdsCache,
  isBundledDependency,
  isExternal,
  pkg,
}: {
  bundledDependenciesDirs: string[];
  bundledIdsCache: Map<string, string>;
  isBundledDependency: PackagePredicate;
  isExternal: PackagePredicate;
  pkg: Package;
}): Plugin {
  return {
    name: "resolve-errors",
    // based on https://github.com/preconstruct/preconstruct/blob/5113f84397990ff1381b644da9f6bb2410064cf8/packages/cli/src/rollup-plugins/resolve.ts
    async resolveId(source, importer, options) {
      if (source.startsWith("\0") || isBundledDependency(source)) {
        return;
      }
      if (!source.startsWith(".") && !source.startsWith("/") && !isExternal(source)) {
        throw new Error(
          `"${source}" is imported ${
            importer ? `by "${normalizePath(path.relative(pkg.relativeDir, importer))}" ` : ""
          }but the package is not specified in dependencies or peerDependencies`
        );
      }
      const bundledSourceId = importer && bundledIdsCache.get(importer);
      if (bundledSourceId) {
        importer = bundledSourceId;
      }
      const resolved = await this.resolve(source, importer, options);
      if (resolved === null) {
        if (!source.startsWith(".")) {
          throw new Error(
            `"${source}" is imported ${
              importer ? `by "${normalizePath(path.relative(pkg.relativeDir, importer))}" ` : ""
            }but the package is not specified in dependencies or peerDependencies`
          );
        }
        throw new Error(
          `Could not resolve ${source} ` +
            (importer ? `from ${path.relative(pkg.relativeDir, importer)}` : "")
        );
      }

      if (source.startsWith("\0") || resolved.id.startsWith("\0")) {
        return resolved;
      }

      if (
        resolved.id.startsWith(pkg.dir) ||
        bundledDependenciesDirs.some(dir => resolved.id.startsWith(dir))
      ) {
        return resolved;
      }

      throw new Error(
        `all relative imports in a package should only import modules inside of their package directory but ${
          importer ? `"${normalizePath(path.relative(pkg.relativeDir, importer))}"` : "a module"
        } is importing "${source}"`
      );
    },
  };
}
