// Flat ESLint config. Enforces the architecture boundary (req §13):
// the UI must never import providers, store, vault, or credential code directly.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.d.ts"]
  },
  {
    files: ["apps/ui/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@frolo/store",
                "@frolo/store/*",
                "@frolo/vault",
                "@frolo/vault/*",
                "@frolo/providers-*",
                "@frolo/providers-*/*",
                "@frolo/controller",
                "@frolo/controller/*",
                "playwright",
                "playwright-core",
                "better-sqlite3"
              ],
              message:
                "UI must not import providers, store, vault, controller, Playwright, or SQLite directly. Use the authenticated web API."
            }
          ]
        }
      ]
    }
  }
);
