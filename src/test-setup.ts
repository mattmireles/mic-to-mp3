/**
 * Vitest global test setup.
 *
 * Extends Vitest's `expect` with DOM-specific matchers from `@testing-library/jest-dom`
 * (e.g. `toBeInTheDocument()`, `toHaveTextContent()`). Loaded automatically via
 * the `setupFiles` option in `vitest.config.ts`.
 */
import "@testing-library/jest-dom/vitest";
