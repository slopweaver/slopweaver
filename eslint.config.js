// Flat ESLint config — the type-aware lane oxlint can't cover (needs the TS program): floating promises,
// misused promises, switch exhaustiveness, only-throw-error, and the repo's house rules expressed as AST
// selectors. Ported from the shared base in the private archive; tailwind/nestjs/framework bits dropped.
// Formatting is Biome's job, linting-for-bugs is split oxlint (syntactic) + this (type-aware).
import regexpPlugin from "eslint-plugin-regexp";
import sonarjsPlugin from "eslint-plugin-sonarjs";
import tseslint from "typescript-eslint";

const TS_GLOBS = ["src/**/*.ts", "eval/**/*.ts", "hooks/**/*.ts"];
const TEST_GLOBS = ["**/*.test.ts", "**/*.spec.ts"];

// The house rules — enforced everywhere, tests included (see [[slopweaver-code-conventions]]):
// fail loud (no empty-string coalesce), entry-point files (no isDirectInvocation), no process.argv[1].
const HOUSE_RULES = [
  {
    message: 'Do not coalesce to an empty string (`?? ""`). Fail loud — throw, or use an honest `x!` assertion.',
    selector: "LogicalExpression[operator='??'][right.type='Literal'][right.value='']",
  },
  {
    message:
      "Do not coalesce to an empty template literal (`?? ``). Fail loud — throw, or use an honest `x!` assertion.",
    selector:
      "LogicalExpression[operator='??'][right.type='TemplateLiteral'][right.expressions.length=0][right.quasis.0.value.cooked='']",
  },
  {
    message:
      "Use the entry-point-file pattern (a tiny *.entry.ts that runs importable logic), not an isDirectInvocation guard.",
    selector: "Identifier[name='isDirectInvocation']",
  },
  {
    message: "Do not read process.argv[1]. Use the entry-point-file pattern instead of self-invocation guards.",
    selector:
      "MemberExpression[object.type='MemberExpression'][object.object.name='process'][object.property.name='argv'][property.value=1]",
  },
];

// Cast/escape-hatch bans — relaxed in tests (casts are common test ergonomics), house rules are not.
const CAST_BANS = [
  // `metadata` is untrusted shape — decode it with a runtime schema (Zod), never assert.
  {
    message: "Do not assert types for `metadata`. Decode with a runtime schema (Zod) instead.",
    selector: "TSAsExpression[expression.name='metadata']",
  },
  {
    message: "Do not assert types for `*.metadata`. Decode with a runtime schema (Zod) instead.",
    selector: "TSAsExpression[expression.property.name='metadata']",
  },
  {
    message: "Do not assert types for `metadata`. Decode with a runtime schema (Zod) instead.",
    selector: "TSTypeAssertion[expression.name='metadata']",
  },
  {
    message: "Do not assert types for `*.metadata`. Decode with a runtime schema (Zod) instead.",
    selector: "TSTypeAssertion[expression.property.name='metadata']",
  },
  {
    message: "Do not use `as any` in production code. Narrow with a type guard or decode with a schema.",
    selector: "TSAsExpression[typeAnnotation.type='TSAnyKeyword']",
  },
  {
    message: "Do not use `<any>` in production code. Narrow with a type guard or decode with a schema.",
    selector: "TSTypeAssertion[typeAnnotation.type='TSAnyKeyword']",
  },
  {
    message: "Do not use double casts (`as unknown as`). Narrow with a type guard or decode with a schema.",
    selector: "TSAsExpression[expression.type='TSAsExpression']",
  },
  {
    message: "Do not use z.any(). Define a concrete schema instead.",
    selector: "CallExpression[callee.object.name='z'][callee.property.name='any']",
  },
  {
    message: "Do not use z.coerce.boolean(). Boolean('false') === true. Use z.string().transform() instead.",
    selector: "CallExpression[callee.object.property.name='coerce'][callee.property.name='boolean']",
  },
];

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "eval/fixtures/**",
      "stubs/**",
      "**/*.js",
      "**/*.cjs",
      "**/*.mjs",
      "*.config.ts",
    ],
  },

  // TypeScript type-aware linting for catching critical bugs.
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: TS_GLOBS,
  })),

  {
    files: TS_GLOBS,
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.eslint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-confusing-void-expression": "warn",
      "@typescript-eslint/no-deprecated": "warn",
      "@typescript-eslint/no-explicit-any": "off",
      // Promise safety — the type-aware rules that catch silent async failures.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-for-in-array": "error",
      "@typescript-eslint/no-implied-eval": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksConditionals: true, checksVoidReturn: { arguments: true, returns: true, variables: true } },
      ],
      "@typescript-eslint/no-mixed-enums": "error",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/no-require-imports": "off",
      // Autofix is destructive when undefined vs false need different treatment (archive-disabled).
      "@typescript-eslint/no-unnecessary-boolean-literal-compare": "off",
      "@typescript-eslint/no-unnecessary-condition": "warn",
      "@typescript-eslint/no-unnecessary-type-conversion": "warn",

      // Disabled from recommendedTypeChecked — handled by oxlint, or too noisy.
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/only-throw-error": "error",
      "@typescript-eslint/prefer-nullish-coalescing": "warn",

      // Safer idioms.
      "@typescript-eslint/prefer-optional-chain": "error",
      "@typescript-eslint/promise-function-async": ["warn", { checkArrowFunctions: false }],
      "@typescript-eslint/related-getter-setter-pairs": "error",
      "@typescript-eslint/require-array-sort-compare": ["error", { ignoreStringArrays: true }],
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/restrict-plus-operands": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/return-await": ["error", "in-try-catch"],

      // Type-aware bug rules oxlint cannot express.
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      // Fires on default-param injection (`exit = process.exit`) — a false positive for that pattern (archive-disabled).
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/use-unknown-in-catch-callback-variable": "warn",
      "max-lines": ["error", { max: 1000, skipBlankLines: false, skipComments: true }],

      "no-restricted-syntax": ["error", ...CAST_BANS, ...HOUSE_RULES],
    },
  },

  // eslint-plugin-regexp: ReDoS + unicode safety.
  {
    files: TS_GLOBS,
    plugins: { regexp: regexpPlugin },
    rules: {
      "regexp/no-misleading-unicode-character": "warn",
      "regexp/no-super-linear-backtracking": "error",
    },
  },

  // eslint-plugin-sonarjs: duplication + complexity smells.
  {
    files: TS_GLOBS,
    plugins: { sonarjs: sonarjsPlugin },
    rules: {
      "sonarjs/no-collapsible-if": "warn",
      "sonarjs/no-duplicated-branches": "warn",
      "sonarjs/no-identical-functions": "warn",
    },
  },

  // Tests: relax ergonomics, but keep the fail-loud house rules on.
  {
    files: TEST_GLOBS,
    rules: {
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-deprecated": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/only-throw-error": "off",
      "@typescript-eslint/promise-function-async": "off",
      "@typescript-eslint/use-unknown-in-catch-callback-variable": "off",
      "max-lines": "off",
      "no-restricted-syntax": ["error", ...HOUSE_RULES],
    },
  },
];
