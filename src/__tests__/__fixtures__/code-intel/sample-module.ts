// Fixture module for code-intel MCP server deterministic tests.
// Provides named exports (functions + class) that workspace_symbols can discover.

export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

export class Calculator {
  private acc: number;

  constructor(initial = 0) {
    this.acc = initial;
  }

  add(n: number): this {
    this.acc += n;
    return this;
  }

  multiply(n: number): this {
    this.acc *= n;
    return this;
  }

  result(): number {
    return this.acc;
  }
}
