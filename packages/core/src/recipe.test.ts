import { describe, it, expect } from "vitest";
import {
  validateRecipeShape,
  recipeChecksum,
  verifyChecksum,
  enforceConstraints,
  preflightRecipe,
  normalizePosixPath,
  RecipeValidationError,
} from "./recipe.js";
import { NGINX_RECIPE } from "./nginx-recipe.js";

describe("recipe validation", () => {
  it("accepts the builtin Nginx recipe", () => {
    expect(() => validateRecipeShape(NGINX_RECIPE)).not.toThrow();
  });

  it("rejects unknown operation types", () => {
    const bad = {
      ...NGINX_RECIPE,
      operations: [{ type: "shell.exec", cmd: "rm -rf /" }],
    };
    expect(() => validateRecipeShape(bad)).toThrow(RecipeValidationError);
  });
});

describe("recipe checksum immutability", () => {
  it("verifies matching checksum", () => {
    const sum = recipeChecksum(NGINX_RECIPE);
    expect(() => verifyChecksum(NGINX_RECIPE, sum)).not.toThrow();
  });

  it("fails on tampered recipe", () => {
    const sum = recipeChecksum(NGINX_RECIPE);
    const tampered = {
      ...NGINX_RECIPE,
      operations: [
        ...NGINX_RECIPE.operations,
        { type: "pkg.install" as const, packages: ["nginx"] },
      ],
    };
    expect(() => verifyChecksum(tampered, sum)).toThrow(RecipeValidationError);
  });
});

describe("path normalization + constraints", () => {
  it("normalizes traversal", () => {
    expect(normalizePosixPath("/var/www/html/../../../etc/passwd")).toBe("/etc/passwd");
    expect(normalizePosixPath("/var/www/html/./index.html")).toBe("/var/www/html/index.html");
  });

  it("allows writes within the allow-list", () => {
    expect(() =>
      enforceConstraints(NGINX_RECIPE, {
        type: "file.write",
        path: "/var/www/html/index.html",
        contentRef: "frolo-index",
      }),
    ).not.toThrow();
  });

  it("rejects writes outside the allow-list", () => {
    expect(() =>
      enforceConstraints(NGINX_RECIPE, {
        type: "file.write",
        path: "/etc/passwd",
        contentRef: "frolo-index",
      }),
    ).toThrow();
  });

  it("rejects path traversal escapes", () => {
    expect(() =>
      enforceConstraints(NGINX_RECIPE, {
        type: "file.write",
        path: "/var/www/html/../../etc/shadow",
        contentRef: "frolo-index",
      }),
    ).toThrow();
  });

  it("rejects packages/services not in allow-list", () => {
    expect(() =>
      enforceConstraints(NGINX_RECIPE, { type: "pkg.install", packages: ["curl"] }),
    ).toThrow();
    expect(() =>
      enforceConstraints(NGINX_RECIPE, { type: "service.start", name: "sshd" }),
    ).toThrow();
  });

  it("rejects unknown asset references", () => {
    expect(() =>
      enforceConstraints(NGINX_RECIPE, {
        type: "file.write",
        path: "/var/www/html/x.html",
        contentRef: "does-not-exist",
      }),
    ).toThrow();
  });

  it("preflights the whole Nginx recipe", () => {
    expect(() => preflightRecipe(NGINX_RECIPE)).not.toThrow();
  });
});
