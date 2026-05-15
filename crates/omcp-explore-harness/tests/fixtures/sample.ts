// Fixture for the symbols test on TypeScript.
export interface Options {
  verbose: boolean;
}

export class Runner {
  constructor(private opts: Options) {}
  run() {
    return "ok";
  }
}

export function helper(x: number): number {
  return x + 1;
}

export const PI = 3.14;

type Result = { ok: boolean };
