import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Manifest } from './snapshot-store.js';

/**
 * The DURABLE copy of the snapshot set (design §3.5): every 6th set (≈ 30
 * min at the default interval) is also written here, and it is read ONLY when
 * redis-models has no manifest — turning "redis-models AND the holder lost"
 * from a 7–20 min cold scan into a load plus a resume inside the oplog window.
 *
 * `READ_MODELS_DURABLE_SNAPSHOT_URL`:
 *  - unset          → `NoopSnapshotSink` (the default; the store is an open decision, D-3);
 *  - `file://<dir>` → `FileSnapshotSink`, a directory (dev, the rig, a single-
 *                      replica service with a volume — a Railway volume forbids
 *                      replicas, so not the multi-replica API);
 *  - anything else  → refused at boot with `[alert] read_models.durable_snapshot_unsupported`
 *                      (S3-compatible storage is the recommended concrete store; not in R1).
 */
export interface SnapshotSink {
  readonly kind: 'none' | 'file';
  /** Store one chunk of the set being written. */
  chunk(key: string, data: Uint8Array): Promise<void>;
  /** Commit the set: the manifest becomes the sink's latest. */
  commit(manifest: Manifest): Promise<void>;
  latest(): Promise<Manifest | null>;
  getChunk(key: string): Promise<Uint8Array | null>;
}

export class NoopSnapshotSink implements SnapshotSink {
  readonly kind = 'none' as const;
  async chunk(): Promise<void> {}
  async commit(): Promise<void> {}
  async latest(): Promise<Manifest | null> {
    return null;
  }
  async getChunk(): Promise<Uint8Array | null> {
    return null;
  }
}

/** One directory: `chunks/<key>` files plus `manifest.json` (written last, by rename). */
export class FileSnapshotSink implements SnapshotSink {
  readonly kind = 'file' as const;

  constructor(private readonly dir: string) {}

  private chunkPath(key: string): string {
    return join(this.dir, 'chunks', encodeURIComponent(key));
  }

  async chunk(key: string, data: Uint8Array): Promise<void> {
    await mkdir(join(this.dir, 'chunks'), { recursive: true });
    await writeFile(this.chunkPath(key), data);
  }

  async commit(manifest: Manifest): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = join(this.dir, `manifest.json.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify(manifest));
    await rename(tmp, join(this.dir, 'manifest.json'));
  }

  async latest(): Promise<Manifest | null> {
    try {
      return JSON.parse(await readFile(join(this.dir, 'manifest.json'), 'utf8')) as Manifest;
    } catch {
      return null;
    }
  }

  async getChunk(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.chunkPath(key)));
    } catch {
      return null;
    }
  }
}

/** The sink for `READ_MODELS_DURABLE_SNAPSHOT_URL`, or an error message for an unsupported scheme. */
export function snapshotSinkFor(url: string | undefined): { sink: SnapshotSink; error?: string } {
  if (!url) return { sink: new NoopSnapshotSink() };
  if (url.startsWith('file://')) return { sink: new FileSnapshotSink(fileURLToPath(url)) };
  return {
    sink: new NoopSnapshotSink(),
    error: `READ_MODELS_DURABLE_SNAPSHOT_URL scheme is not supported in this build (only file://): ${url.replace(/\/\/[^@/]*@/, '//***@')}`,
  };
}
