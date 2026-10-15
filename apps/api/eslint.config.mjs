// ESLint for apps/api. One job today: keep Solana out of the shared core
// (plan 20261015-testmyagent-web2-client, ADR-3 / ADR-6).
//
// `@solana/*` is forbidden in apps/api/src/** except in the files below. The list grandfathers the
// files that imported Solana when the auth adapter seam landed. A NEW file must not import Solana:
// put Solana code behind an adapter (auth/adapters/siws*, a payment adapter, chain/**).
import tseslint from "typescript-eslint";

const SOLANA_ALLOWED = [
  "src/auth/adapters/siws*",
  "src/chain/**",
  "src/domain/solana-attestation*",
  "src/evaluations/solana-pay*",
  // Grandfathered (imported @solana/kit before the seam). Move behind an adapter when touched.
  "src/http/credentials-router.ts",
  "src/http/profile-router.ts",
  // Tests may use @solana/kit to build fixtures (wallets, signatures).
  "src/**/*.test.ts",
];

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  {
    files: ["src/**/*.ts"],
    languageOptions: { parser: tseslint.parser },
    // Registered (no rules enabled) so existing `eslint-disable @typescript-eslint/*` comments resolve.
    plugins: { "@typescript-eslint": tseslint.plugin },
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@solana/*", "@solana-program/*"],
              message:
                "Solana belongs behind an adapter (auth/adapters/siws*, payments, chain/**). See apps/api/eslint.config.mjs.",
            },
          ],
        },
      ],
    },
  },
  {
    files: SOLANA_ALLOWED,
    rules: { "no-restricted-imports": "off" },
  },
);
