import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  listMcpServers,
  resolveMcpServer,
} from "../cli/commands/mcp-serve.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..", "..");

describe("omcp mcp-serve", () => {
  it("listMcpServers returns the set of servers actually present under dist/mcp/", () => {
    const servers = listMcpServers(PKG_ROOT);
    // We don't pin the exact set (the build may add more over time), but the
    // four servers known to ship today must be discoverable.
    expect(servers).toEqual(
      expect.arrayContaining([
        "state",
        "notepad",
        "trace",
        "project-memory",
        "loop",
      ]),
    );
  });

  it("resolveMcpServer maps 'state' to state-server-main.js", () => {
    const r = resolveMcpServer("state", PKG_ROOT);
    expect(r.name).toBe("state");
    expect(r.path.endsWith("state-server-main.js")).toBe(true);
  });

  it("resolveMcpServer maps 'notepad' to notepad-server.js", () => {
    const r = resolveMcpServer("notepad", PKG_ROOT);
    expect(r.path.endsWith("notepad-server.js")).toBe(true);
  });

  it("resolveMcpServer maps 'project-memory' to project-memory-server.js", () => {
    const r = resolveMcpServer("project-memory", PKG_ROOT);
    expect(r.path.endsWith("project-memory-server.js")).toBe(true);
  });

  it("resolveMcpServer maps 'trace' and 'loop' to their server files", () => {
    expect(resolveMcpServer("trace", PKG_ROOT).path.endsWith("trace-server.js")).toBe(true);
    expect(resolveMcpServer("loop", PKG_ROOT).path.endsWith("loop-server.js")).toBe(true);
  });

  it("resolveMcpServer rejects an unknown name with a helpful message", () => {
    expect(() => resolveMcpServer("definitely-not-a-server", PKG_ROOT)).toThrow(
      /unknown mcp server/,
    );
  });

  it("resolveMcpServer flags missing build artifacts", () => {
    expect(() => resolveMcpServer("state", "/tmp/no-such-pkg-root")).toThrow(
      /not built/,
    );
  });
});
