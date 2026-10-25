// Size and clean-up of the on-disk cache, on the user's request (settings → Cache).
//
// Everything in the cache dir rebuilds itself (db.ts), so clearing is never a loss of work,
// only of time: thumbnails and display sources come back as the grid scrolls, video proxies
// on the next play, analyses on the next run. Only plain files are counted and removed;
// whatever else turns up in these directories is left alone.
//
// `*.tmp` files are writes in progress (thumbs.ts `once`, video.ts encodes). They are renamed
// into place when done, so deleting one under a running ffmpeg or Bun.Image would fail that
// build for no gain; they are skipped and the next clean-up gets whatever a crash left behind.

import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

export interface DirUsage {
    bytes: number;
    count: number;
}

const inProgress = (name: string) => name.endsWith(".tmp");

async function files(dir: string): Promise<{ path: string; size: number }[]> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const out: { path: string; size: number }[] = [];
    for (const e of entries) {
        if (!e.isFile() || inProgress(e.name)) continue;
        const path = join(dir, e.name);
        const size = await stat(path).then(s => s.size, () => null);
        if (size !== null) out.push({ path, size });
    }
    return out;
}

export async function dirUsage(dir: string): Promise<DirUsage> {
    const list = await files(dir);
    return { bytes: list.reduce((sum, f) => sum + f.size, 0), count: list.length };
}

/** Deletes the files in `dir` (not the directory: builds in flight rename into it). */
export async function clearDir(dir: string): Promise<DirUsage> {
    const freed: DirUsage = { bytes: 0, count: 0 };
    for (const f of await files(dir)) {
        try {
            await unlink(f.path);
            freed.bytes += f.size;
            freed.count++;
        } catch {
            // Gone already, or not ours to delete; the next look shows what is left.
        }
    }
    return freed;
}
