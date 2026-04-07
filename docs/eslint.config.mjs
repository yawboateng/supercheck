import nextConfig from "eslint-config-next";

const eslintConfig = [
  ...nextConfig,
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      ".source/**",
      "next-env.d.ts",
    ],
  },
];

export default eslintConfig;
