// Secondary fixture module for code-intel MCP server deterministic tests.

export function greet(name: string): string {
  return `Hello, ${name}!`;
}

export function farewell(name: string): string {
  return `Goodbye, ${name}!`;
}

export interface Greeter {
  greet(name: string): string;
}
