// Local HTTP server for image bytes.
//
// Thumbnails, previews and originals go to the view as plain <img src> URLs rather than
// through RPC: RPC payloads are JSON, so megabytes of image data would be base64-encoded,
// copied through the bridge and decoded again, and the browser could neither cache nor
// decode them off the main thread. A loopback server lets Chromium do what it is good at.
//
// Bound to 127.0.0.1 on a random port, and every request must carry a random token that
// only the view receives (over RPC). Other local users or web pages cannot guess either.

import type { Item } from "../../shared/types.ts";
import { displaySource, variant, type Variant } from "./thumbs.ts";
import { playable, rangeResponse } from "./video.ts";

// Thumbnail work is CPU heavy (decoding 61 MP JPEGs). Unbounded, a fast scroll through a
// 1000-photo grid queues hundreds of decodes at once and starves the RPC. Newest requests
// first: what the user is looking at now matters more than what they scrolled past.
class Lifo {
    private queue: (() => void)[] = [];
    private active = 0;
    constructor(private limit: number) {}
    async run<T>(fn: () => Promise<T>): Promise<T> {
        if (this.active >= this.limit) await new Promise<void>(resolve => this.queue.push(resolve));
        this.active++;
        try {
            return await fn();
        } finally {
            this.active--;
            this.queue.pop()?.();
        }
    }
}

export class MediaServer {
    readonly token = crypto.randomUUID();
    private items = new Map<string, Item>();
    private server: ReturnType<typeof Bun.serve>;
    private gate = new Lifo(Math.max(2, Math.min(8, navigator.hardwareConcurrency - 2)));

    /** @param transcode Reads the "transcodeVideos" setting at request time. */
    constructor(private transcode: () => boolean = () => true) {
        this.server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: req => this.handle(req),
        });
    }

    get baseUrl(): string {
        return `http://127.0.0.1:${this.server.port}`;
    }

    setItems(items: Item[]) {
        this.items = new Map(items.map(i => [i.id, i]));
    }

    private async handle(req: Request): Promise<Response> {
        const url = new URL(req.url);
        const headers = {
            "Access-Control-Allow-Origin": "*",
            // URLs carry the content key, so a changed file gets a new URL; cache hard.
            "Cache-Control": "private, max-age=31536000, immutable",
        };
        if (url.searchParams.get("t") !== this.token) return new Response("forbidden", { status: 403 });
        const item = this.items.get(url.searchParams.get("id") ?? "");
        if (!item) return new Response("not found", { status: 404 });

        try {
            const kind = url.pathname.slice(1);
            if (kind === "thumb" || kind === "preview") {
                const path = await this.gate.run(() => variant(item, kind as Variant));
                return new Response(Bun.file(path), { headers: { ...headers, "Content-Type": "image/webp" } });
            }
            if (kind === "original") {
                // Full resolution for 100 % zoom: the file itself when the browser can show
                // it, the decoded display source otherwise (HEIC, RAW preview, video frame).
                // Chromium decodes JPEG XL itself (the JXLImageFormat feature, see
                // src/electron/main.ts), ~1.2 s for 61 MP, so an archived item is served as is
                // rather than waiting for djxl and keeping a full-size JPEG of it on disk.
                if (item.kind === "archived") {
                    return new Response(Bun.file(item.primary.path), { headers: { ...headers, "Content-Type": "image/jxl" } });
                }
                const path = await this.gate.run(() => displaySource(item));
                return new Response(Bun.file(path), { headers });
            }
            if (kind === "video" && item.kind === "video") {
                // Not behind the gate: the view asks for it only after prepareVideo has made
                // sure it exists, so this is a lookup, and seeking must not queue behind
                // thumbnail decodes.
                return rangeResponse(req, await playable(item, this.transcode()), headers);
            }
            return new Response("not found", { status: 404 });
        } catch (err) {
            console.warn(`[media] ${item.id}: ${(err as Error).message}`);
            return new Response((err as Error).message, { status: 500, headers });
        }
    }

    stop() {
        this.server.stop(true);
    }
}
