// Atomic file write — write to a temp file, fsync, rename over target.
// This prevents corrupt JSON if the process crashes mid-write.

import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export function atomicWriteFileSync(
  path: string,
  data: string | Uint8Array,
  opts?: { encoding?: BufferEncoding },
): void {
  const dir = dirname(path);
  const rand = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  const tmp = join(dir, `${basename(path)}.tmp.${process.pid}.${rand}`);

  const buf: Buffer =
    typeof data === "string"
      ? Buffer.from(data, opts?.encoding ?? "utf8")
      : Buffer.from(data);

  let fd: number | undefined;
  try {
    fd = openSync(tmp, "w");
    writeSync(fd, buf);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close error during cleanup
      }
    }
    try {
      rmSync(tmp, { force: true });
    } catch {
      // ignore cleanup error — best effort
    }
    throw err;
  }
}
