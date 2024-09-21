import { defineConfig } from "@tanstack/start/config";
import { cjsInterop } from "vite-plugin-cjs-interop";
import tsConfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  vite: {
    plugins: () => [
      tsConfigPaths({
        projects: ["./tsconfig.json"],
      }),
      cjsInterop({
        // List of CJS dependencies that require interop
        dependencies: ["ts-dedent", "suncalc"],
      }),
    ],
  },
});
