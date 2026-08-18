import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

/**
 * ESLint flat config.
 *
 * The rule that matters here is `no-restricted-properties` on `process.env`.
 * The environment layer only holds if it is the single door: one validated,
 * typed module rather than thirty scattered `process.env.FOO!` reads that each
 * silently return undefined in some deployment.
 */
const config = [
  ...nextCoreWebVitals,
  ...nextTypescript,

  {
    ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'],
  },

  {
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'Do not read process.env directly. Import `env` from "@/lib/env" on the server, or `clientEnv` from "@/lib/env.client" in a Client Component. Those modules validate every value at boot; process.env does not.',
        },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  {
    // The environment modules are the door itself, and the check script must
    // load dotenv before that door opens. They carry inline disables for the
    // specific lines that read process.env.
    files: ['scripts/**/*.ts'],
    rules: {
      'no-restricted-properties': 'off',
      'no-console': 'off',
    },
  },
];

export default config;
