// Pure-functional shared-memory I/O — shared by the MCP server.
// Path resolution: OMCP_SHARED_MEMORY_ROOT env var overrides the default,
// so tests can isolate to a tmp directory without polluting .omcp/.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import { assertSafeSlug } from "./safe-slug.js";

export interface SharedMemoryEntry {
  value: unknown;
  expiresAt: number | null;
}

export function sharedMemoryRoot(): string {
  return (
    process.env.OMCP_SHARED_MEMORY_ROOT ??
    join(process.cwd(), ".omcp", "state", "shared-memory")
  );
}

function keyPath(key: string, root: string): string {
  assertSafeSlug(key, "key");
  return join(root, `${key}.json`);
}

function readEntryRaw(path: string): SharedMemoryEntry | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as SharedMemoryEntry;
  } catch {
    return null;
  }
}

export function writeSharedMemory(
  key: string,
  value: unknown,
  ttl_ms?: number,
  root?: string,
): SharedMemoryEntry {
  const r = root ?? sharedMemoryRoot();
  assertSafeSlug(key, "key");
  mkdirSync(r, { recursive: true });
  const expiresAt = ttl_ms != null ? Date.now() + ttl_ms : null;
  const entry: SharedMemoryEntry = { value, expiresAt };
  atomicWriteFileSync(keyPath(key, r), JSON.stringify(entry));
  return entry;
}

export function readSharedMemory(
  key: string,
  root?: string,
): SharedMemoryEntry | null {
  const r = root ?? sharedMemoryRoot();
  const entry = readEntryRaw(keyPath(key, r));
  if (!entry) return null;
  if (entry.expiresAt !== null && entry.expiresAt < Date.now()) return null;
  return entry;
}

export function listSharedMemory(root?: string): { keys: string[] } {
  const r = root ?? sharedMemoryRoot();
  if (!existsSync(r)) return { keys: [] };
  const now = Date.now();
  const keys: string[] = [];
  let files: string[];
  try {
    files = readdirSync(r);
  } catch {
    return { keys: [] };
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const key = f.slice(0, -5);
    const entry = readEntryRaw(join(r, f));
    if (!entry) continue;
    if (entry.expiresAt !== null && entry.expiresAt < now) continue;
    keys.push(key);
  }
  return { keys };
}

export function deleteSharedMemory(
  key: string,
  root?: string,
): { deleted: boolean } {
  const r = root ?? sharedMemoryRoot();
  assertSafeSlug(key, "key");
  const p = keyPath(key, r);
  if (!existsSync(p)) return { deleted: false };
  try {
    rmSync(p, { force: true });
    return { deleted: true };
  } catch {
    return { deleted: false };
  }
}

export function cleanupSharedMemory(root?: string): { removed: number } {
  const r = root ?? sharedMemoryRoot();
  if (!existsSync(r)) return { removed: 0 };
  const now = Date.now();
  let removed = 0;
  let files: string[];
  try {
    files = readdirSync(r);
  } catch {
    return { removed: 0 };
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const entry = readEntryRaw(join(r, f));
    if (!entry) continue;
    if (entry.expiresAt !== null && entry.expiresAt < now) {
      try {
        rmSync(join(r, f), { force: true });
        removed++;
      } catch {
        // best effort
      }
    }
  }
  return { removed };
}
