// Types-only ambient declaration for the bun test runner, so `bunx tsc --noEmit`
// resolves `import { ... } from "bun:test"` without adding `@types/bun` as a
// dependency. Erased at compile time; bun provides the real module at runtime.
// This is a global (script-context) declaration file — it deliberately has no
// top-level import/export, so `declare module` creates a fresh ambient module
// rather than an augmentation.

declare module "bun:test" {
  interface Matchers {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeNull(): void;
    toBeUndefined(): void;
    toBeDefined(): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toHaveLength(length: number): void;
    toContain(item: unknown): void;
    toThrow(expected?: unknown): void;
    readonly not: Matchers;
    readonly resolves: Matchers;
    readonly rejects: Matchers;
  }
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export function beforeAll(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export function expect(actual: unknown): Matchers;
}
