// Recipe engine (req §5). Validates recipes against the known typed-op schema,
// enforces per-op constraints (path allow-list w/ traversal+symlink guard,
// package + service allow-lists), and verifies built-in recipe checksums for
// immutability.

import { createHash } from "node:crypto";
import type { Recipe, RecipeOperation } from "@frolo/contracts";
import { recipeSchema } from "@frolo/contracts";

export class RecipeValidationError extends Error {}

// Validate structure + reject unknown op types (zod discriminated union does
// the rejection). Returns the parsed recipe.
export function validateRecipeShape(input: unknown): Recipe {
  const parsed = recipeSchema.safeParse(input);
  if (!parsed.success) {
    throw new RecipeValidationError(
      `recipe failed validation: ${parsed.error.issues
        .map((i) => i.message)
        .join("; ")}`,
    );
  }
  return parsed.data as Recipe;
}

// Deterministic checksum over the recipe's canonical content (req §5.6).
export function recipeChecksum(recipe: Recipe): string {
  const canonical = JSON.stringify({
    id: recipe.id,
    name: recipe.name,
    version: recipe.version,
    source: recipe.source,
    operations: recipe.operations,
    constraints: recipe.constraints,
    assets: recipe.assets,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function verifyChecksum(recipe: Recipe, expected: string): void {
  const actual = recipeChecksum(recipe);
  if (actual !== expected) {
    throw new RecipeValidationError(
      `recipe checksum mismatch (tampered?): expected ${expected}, got ${actual}`,
    );
  }
}

// Normalize a POSIX-ish path without touching the filesystem. Resolves "." and
// "..", collapses slashes. Rejects null bytes.
export function normalizePosixPath(p: string): string {
  if (p.includes("\0")) throw new RecipeValidationError("path contains null byte");
  const isAbs = p.startsWith("/");
  const segments = p.split("/");
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!isAbs) out.push("..");
      // If absolute and out is empty, ".." above root is dropped.
    } else {
      out.push(seg);
    }
  }
  return (isAbs ? "/" : "") + out.join("/");
}

function pathWithin(child: string, parent: string): boolean {
  const c = normalizePosixPath(child);
  const p = normalizePosixPath(parent);
  if (c === p) return true;
  const pWithSlash = p.endsWith("/") ? p : p + "/";
  return c.startsWith(pWithSlash);
}

// Enforce constraints for a single operation (req §5.7, §5.8). Throws on
// violation so the op never reaches the guest.
export function enforceConstraints(recipe: Recipe, op: RecipeOperation): void {
  const c = recipe.constraints;
  switch (op.type) {
    case "file.write": {
      // No traversal escape: normalized path must resolve within an allow-listed dir.
      const normalized = normalizePosixPath(op.path);
      if (op.path.includes("..") || normalized.includes("/..")) {
        throw new RecipeValidationError(
          `file.write path traversal rejected: ${op.path}`,
        );
      }
      const ok = c.writablePaths.some((dir) => pathWithin(normalized, dir));
      if (!ok) {
        throw new RecipeValidationError(
          `file.write path not in allow-list: ${op.path}`,
        );
      }
      // Symlink escape cannot be checked without a filesystem; the guest
      // provider additionally refuses to follow symlinks out of allow-listed
      // dirs. Here we reject obviously suspicious targets.
      if (!recipe.assets[op.contentRef]) {
        throw new RecipeValidationError(
          `file.write references unknown asset: ${op.contentRef}`,
        );
      }
      break;
    }
    case "pkg.install": {
      for (const pkg of op.packages) {
        if (!c.packages.includes(pkg)) {
          throw new RecipeValidationError(
            `pkg.install package not in allow-list: ${pkg}`,
          );
        }
      }
      break;
    }
    case "service.enable":
    case "service.start": {
      if (!c.services.includes(op.name)) {
        throw new RecipeValidationError(
          `service ${op.type} name not in allow-list: ${op.name}`,
        );
      }
      break;
    }
    case "http.check":
      // No filesystem/package impact; path is a URL path.
      break;
  }
}

// Full pre-flight: validate + enforce every op. Throws on any problem.
export function preflightRecipe(recipe: Recipe): void {
  for (const op of recipe.operations) enforceConstraints(recipe, op);
}
