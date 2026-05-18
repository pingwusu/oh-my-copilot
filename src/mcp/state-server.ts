// omcp state MCP server — exposes state_read/write/clear/list_active/get_status
// to Copilot CLI sessions, backed by a per-session JSON file under .omcp/state/.
//
// This is the M4-target functional surface; v0.1 ships a minimal in-memory
// stub for tests + a file-backed real path to be wired in M4.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "../runtime/atomic-write.js";
import { assertSafeSlug } from "../runtime/safe-slug.js";

export interface StateStore {
  read(sessionId: string, key: string): string | undefined;
  write(sessionId: string, key: string, value: string): void;
  clear(sessionId: string, key?: string): void;
  list_active(): string[];
  get_status(sessionId: string): { keys: string[]; size: number };
}

export class FileStateStore implements StateStore {
  constructor(private root: string) {
    mkdirSync(this.root, { recursive: true });
  }

  private sessionFile(sessionId: string): string {
    // DD4 Lane B fix: reject path-traversal — sessionId may be MCP-client-
    // supplied and could escape this.root via "../..".
    assertSafeSlug(sessionId, "sessionId");
    return join(this.root, `${sessionId}.json`);
  }

  private load(sessionId: string): Record<string, string> {
    const f = this.sessionFile(sessionId);
    if (!existsSync(f)) return {};
    return JSON.parse(readFileSync(f, "utf8")) as Record<string, string>;
  }

  private save(sessionId: string, data: Record<string, string>): void {
    atomicWriteFileSync(this.sessionFile(sessionId), JSON.stringify(data, null, 2));
  }

  read(sessionId: string, key: string): string | undefined {
    return this.load(sessionId)[key];
  }

  write(sessionId: string, key: string, value: string): void {
    const data = this.load(sessionId);
    data[key] = value;
    this.save(sessionId, data);
  }

  clear(sessionId: string, key?: string): void {
    const data = this.load(sessionId);
    if (key) delete data[key];
    else for (const k of Object.keys(data)) delete data[k];
    this.save(sessionId, data);
  }

  list_active(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  }

  get_status(sessionId: string): { keys: string[]; size: number } {
    const data = this.load(sessionId);
    const keys = Object.keys(data);
    const size = keys.reduce((acc, k) => acc + (data[k]?.length ?? 0), 0);
    return { keys, size };
  }
}

// In-memory store for tests + as a fallback when filesystem is unavailable.
export class MemoryStateStore implements StateStore {
  private data = new Map<string, Map<string, string>>();

  private ensure(sessionId: string): Map<string, string> {
    let m = this.data.get(sessionId);
    if (!m) {
      m = new Map();
      this.data.set(sessionId, m);
    }
    return m;
  }

  read(sessionId: string, key: string): string | undefined {
    return this.data.get(sessionId)?.get(key);
  }

  write(sessionId: string, key: string, value: string): void {
    this.ensure(sessionId).set(key, value);
  }

  clear(sessionId: string, key?: string): void {
    const m = this.data.get(sessionId);
    if (!m) return;
    if (key) m.delete(key);
    else m.clear();
  }

  list_active(): string[] {
    return Array.from(this.data.keys()).filter(
      (s) => (this.data.get(s)?.size ?? 0) > 0,
    );
  }

  get_status(sessionId: string): { keys: string[]; size: number } {
    const m = this.data.get(sessionId);
    if (!m) return { keys: [], size: 0 };
    const keys = Array.from(m.keys());
    const size = keys.reduce((acc, k) => acc + (m.get(k)?.length ?? 0), 0);
    return { keys, size };
  }
}
