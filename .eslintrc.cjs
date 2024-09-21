/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    ecmaFeatures: {
      jsx: true,
    },
    parser: "@typescript-eslint/parser",
    project: "tsconfig.json",
  },
  env: {
    browser: true,
    commonjs: true,
    es6: true,
  },

  // Base config
  extends: ["eslint:recommended"],

  overrides: [
    // React
    {
      files: ["**/*.{js,jsx,ts,tsx}"],
      plugins: ["react", "jsx-a11y"],
      extends: [
        "plugin:react/recommended",
        "plugin:react/jsx-runtime",
        "plugin:react-hooks/recommended",
        "plugin:jsx-a11y/recommended",
      ],
      settings: {
        react: {
          version: "detect",
        },
        "import/parsers": {
          "@typescript-eslint/parser": [".ts", ".tsx"],
        },
        "import/resolver": {
          typescript: {},
        },
      },
      rules: {
        "react/no-unescaped-entities": ["error", { forbid: [">", "}"] }],
      },
    },

    // Typescript
    {
      files: ["**/*.{ts,tsx}"],
      plugins: [
        "@typescript-eslint",
        "import",
        "unused-imports",
        "simple-import-sort",
      ],
      parser: "@typescript-eslint/parser",
      settings: {
        "import/internal-regex": "^@/",
        "import/resolver": {
          node: {
            extensions: [".ts", ".tsx"],
          },
          typescript: {
            alwaysTryTypes: true,
          },
        },
      },
      extends: [
        "plugin:@typescript-eslint/recommended",
        "plugin:import/recommended",
        "plugin:import/typescript",
      ],
      rules: {
        "react/no-unknown-property": "off", // https://github.com/pmndrs/react-three-fiber/issues/2623
        "react/display-name": "off",
        "@typescript-eslint/no-unused-vars": "off",
        "unused-imports/no-unused-vars": [
          "warn",
          {
            vars: "all",
            varsIgnorePattern: "^_",
            args: "after-used",
            argsIgnorePattern: "^_",
          },
        ],
        "unused-imports/no-unused-imports": "warn",
        "simple-import-sort/imports": [
          "warn",
          {
            groups: [["^\\u0000"], ["^react$", "^@?\\w"], ["^"], ["^\\."]],
          },
        ],
        "simple-import-sort/exports": "off",
        "import/no-named-as-default": "off",
      },
    },

    // Node
    {
      files: [".eslintrc.js"],
      env: {
        node: true,
      },
    },
  ],
};
