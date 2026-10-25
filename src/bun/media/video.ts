// In-app video playback.
//
// The bundled CEF is built without the patent-encumbered codecs: canPlayType() says no to
// H.264, HEVC and AAC, and yes only to AV1, VP9/VP8 and Opus/Vorbis. Every camera here records
// H.264 or HEVC (DJI, Sony XAVC, phones), so most clips can't be played as they are.
//
//   AV1/VP9/VP8 video with Opus/Vorbis audio (or none) in MP4/WebM  -> the original file
//   anything else                                                    -> a WebM proxy
//
// The proxy is AV1 at up to 720p with Opus audio, cached under ~/.cache/org.mkuhlmann.cataglyph/video. It
// is encoded on the GPU through VAAPI where possible: a 28 s 1080p H.264 DJI clip took 2.5 s
// on a Radeon 890M, against 6.7 s with SVT-AV1 on the CPU, which is the fallback (and VP9
// after that, for an ffmpeg built without SVT-AV1).

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { Item } from "../../shared/types.ts";
import { CACHE_DIR } from "../store/db.ts";
import { toolPaths } from "../tools.ts";

export const VIDEO_DIR = join(CACHE_DIR, "video");
mkdirSync(VIDEO_DIR, { recursive: true });

const NATIVE_VIDEO = new Set(["av1", "vp9", "vp8"]);
const NATIVE_AUDIO = new Set(["opus", "vorbis"]);
const NATIVE_CONTAINER = new Set(["mp4", "m4v", "webm"]);

export interface Playable {
    path: string;
    contentType: string;
}

interface Probe {
    video: string | null;
    audio: string | null;
    duration: number;
}

async function probe(path: string): Promise<Probe> {
    const ffprobe = Bun.which("ffprobe");
    if (!ffprobe) throw new Error("ffprobe not installed");
    const proc = Bun.spawn([ffprobe, "-v", "error", "-show_entries", "stream=codec_type,codec_name:format=duration", "-of", "json", path], {
        stdout: "pipe", stderr: "ignore",
    });
    const out = JSON.parse(await new Response(proc.stdout).text()) as {
        streams?: { codec_type?: string; codec_name?: string }[];
        format?: { duration?: string };
    };
    await proc.exited;
    const streams = out.streams ?? [];
    return {
        video: streams.find(s => s.codec_type === "video")?.codec_name ?? null,
        audio: streams.find(s => s.codec_type === "audio")?.codec_name ?? null,
        duration: Number(out.format?.duration) || 0,
    };
}

function keyName(contentKey: string): string {
    return new Bun.CryptoHasher("sha1").update(contentKey).digest("hex");
}

// The encoders to try, best first. Each gets the same input/output arguments around it.
function encoders(): { name: string; pre: string[]; args: string[] }[] {
    // 720p proxy: the short side at most 720, so portrait phone clips get 720x1280 rather
    // than 404x720. Scaled in software before the upload: scale_vaapi to 720p failed on RADV
    // with "Cannot allocate memory" on every frame, and 1080->720 costs the CPU little.
    const scale = "scale='if(gt(iw,ih),-2,min(720,iw))':'if(gt(iw,ih),min(720,ih),-2)'";
    const out: { name: string; pre: string[]; args: string[] }[] = [];
    const render = existsSync("/dev/dri") ? readdirSync("/dev/dri").find(f => f.startsWith("renderD")) : undefined;
    if (render) {
        out.push({
            name: "av1_vaapi",
            pre: ["-vaapi_device", `/dev/dri/${render}`],
            args: ["-vf", `${scale},format=nv12,hwupload`, "-c:v", "av1_vaapi", "-b:v", "3M"],
        });
    }
    out.push({ name: "libsvtav1", pre: [], args: ["-vf", scale, "-c:v", "libsvtav1", "-preset", "10", "-crf", "35"] });
    out.push({ name: "libvpx-vp9", pre: [], args: ["-vf", scale, "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "2500k"] });
    return out;
}

// The encoder that worked last, so a machine without VAAPI doesn't retry it for every clip.
let preferred = 0;

async function encode(input: string, output: string, duration: number, onProgress: (pct: number) => void): Promise<void> {
    const ffmpeg = toolPaths().ffmpeg;
    if (!ffmpeg) throw new Error("ffmpeg not installed");
    const list = encoders();
    let lastError = "";
    for (let i = preferred; i < list.length; i++) {
        const enc = list[i]!;
        const proc = Bun.spawn([
            ffmpeg, "-v", "error", "-y", ...enc.pre, "-i", input,
            "-map", "0:v:0", "-map", "0:a:0?", ...enc.args,
            "-c:a", "libopus", "-b:a", "128k",
            "-f", "webm", "-progress", "pipe:1", "-nostats", output,
        ], { stdout: "pipe", stderr: "pipe" });
        const stderr = new Response(proc.stderr).text();
        // -progress writes key=value blocks; out_time_us is the position encoded so far.
        let buffer = "";
        for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
            buffer += new TextDecoder().decode(chunk);
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
                const m = /^out_time_us=(\d+)/.exec(line);
                if (m && duration > 0) onProgress(Math.min(99, (Number(m[1]) / 1e6 / duration) * 100));
            }
        }
        if (await proc.exited === 0) {
            preferred = i;
            return;
        }
        lastError = `${enc.name}: ${(await stderr).trim().split("\n").pop() ?? "failed"}`;
        console.warn(`[video] ${lastError}`);
    }
    throw new Error(lastError || "no encoder worked");
}

const inflight = new Map<string, Promise<Playable>>();
// Resolved answers by content key: <video> fires a Range request per seek, and each would
// otherwise start an ffprobe.
const resolved = new Map<string, Playable>();

export class TranscodeDisabled extends Error {
    constructor() {
        super("video transcoding is turned off");
    }
}

/**
 * Something the view's <video> can play for this item: the original when CEF can decode it,
 * otherwise the cached proxy, encoding it first unless `transcode` is off (then it rejects
 * with TranscodeDisabled). Concurrent calls share one encode.
 */
export function playable(item: Item, transcode: boolean, onProgress: (pct: number) => void = () => {}): Promise<Playable> {
    const known = resolved.get(item.contentKey);
    if (known) return Promise.resolve(known);
    const running = inflight.get(item.id);
    if (running) return running;
    // (TranscodeDisabled is not cached in `resolved`, so turning the setting on takes effect.)
    const task = (async (): Promise<Playable> => {
        const info = await probe(item.primary.path);
        const nativeAudio = info.audio === null || NATIVE_AUDIO.has(info.audio);
        if (info.video && NATIVE_VIDEO.has(info.video) && nativeAudio && NATIVE_CONTAINER.has(item.primary.ext)) {
            return { path: item.primary.path, contentType: item.primary.ext === "webm" ? "video/webm" : "video/mp4" };
        }
        const out = join(VIDEO_DIR, `${keyName(item.contentKey)}.webm`);
        // A proxy made while transcoding was on is still used: it costs nothing to play.
        if (await stat(out).then(s => s.size > 0, () => false)) return { path: out, contentType: "video/webm" };
        if (!transcode) throw new TranscodeDisabled();
        const tmp = `${out}.${process.pid}.tmp`;
        try {
            await encode(item.primary.path, tmp, info.duration, onProgress);
            await rename(tmp, out);
        } finally {
            await unlink(tmp).catch(() => {});
        }
        return { path: out, contentType: "video/webm" };
    })()
        .then(p => (resolved.set(item.contentKey, p), p))
        .finally(() => inflight.delete(item.id));
    inflight.set(item.id, task);
    return task;
}

/**
 * A file response honouring Range requests. <video> asks for byte ranges to seek and won't
 * let the user scrub without 206 answers.
 */
export function rangeResponse(req: Request, file: Playable, headers: Record<string, string>): Response {
    const body = Bun.file(file.path);
    const size = body.size;
    const base = { ...headers, "Content-Type": file.contentType, "Accept-Ranges": "bytes" };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
    if (!m) return new Response(body, { headers: { ...base, "Content-Length": String(size) } });
    let start = m[1] ? Number(m[1]) : NaN;
    let end = m[2] ? Number(m[2]) : size - 1;
    if (Number.isNaN(start)) {
        // "bytes=-N": the last N bytes.
        start = Math.max(0, size - end);
        end = size - 1;
    }
    end = Math.min(end, size - 1);
    if (start > end || start >= size) {
        return new Response(null, { status: 416, headers: { ...base, "Content-Range": `bytes */${size}` } });
    }
    return new Response(body.slice(start, end + 1), {
        status: 206,
        headers: { ...base, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
    });
}
