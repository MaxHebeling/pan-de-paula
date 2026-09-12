import js from "@eslint/js";
import tseslint from "typescript-eslint";

/** Reglas base compartidas por todos los paquetes. */
export default tseslint.config(
  { ignores: ["dist/**", ".next/**", "coverage/**", "node_modules/**", "src/generated/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "no-console": ["warn", { allow: ["warn", "error", "info"] }],
      "no-empty": ["error", { allowEmptyCatch: false }],
      eqeqeq: ["error", "always"],
    },
  },
);
