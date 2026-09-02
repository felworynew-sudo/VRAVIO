/**
 * Root test config. `research/` holds vendored reference checkouts (Patchy, openDAW,
 * GIMP, VoidCut) that are studied, not built — their tests reference tsconfigs and
 * toolchains we do not install, so a bare `vitest run` from the repo root fails on
 * hundreds of files that are not ours. Restrict discovery to first-party code.
 *
 * Exported as a plain object rather than via `defineConfig`: vitest is a devDependency
 * of the individual packages, not of the workspace root, so `vitest/config` is not
 * resolvable from here.
 */
export default {
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "research/**", "**/dist/**"],
  },
};
