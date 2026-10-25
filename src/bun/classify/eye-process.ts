// The Eye inference process. Runs as a separate Bun process spawned by eye-client.ts, with
// the main bundle re-entered under CATAGLYPH_ROLE=eye (see src/bun/index.ts).
//
// Why a separate process rather than running Eye in the main process:
// - LiteRT finds its GPU accelerator (libLiteRtWebGpuAccelerator.so) by dlopen()ing the bare
//   name, and the dynamic linker reads LD_LIBRARY_PATH once at process start. Setting it from
//   inside the running main process has no effect, so the only way to get the GPU path is a
//   process launched with it in its environment.
// - A Vulkan driver fault takes down this process, not the window. The client notices, and
//   respawns on the CPU.
// - Inference and image decoding are CPU/GPU heavy and would otherwise compete with the RPC
//   and file server for the main event loop.

import jpeg from "jpeg-js";

import { Analysis, Eye } from "@desert-ant-labs/eye/native";

import type { EyeRequest, EyeResponse } from "./eye-protocol.ts";
import { ANALYSIS_EDGE } from "./eye-protocol.ts";
import { summarize } from "./summarize.ts";

const send = (msg: EyeResponse) => process.send?.(msg);

const accelerator: "gpu" | "cpu" = process.env.CATAGLYPH_EYE_GPU === "1" ? "gpu" : "cpu";
let eye: Eye | null = null;

// The decoded pixels Eye wants come from Bun.Image (libjpeg-turbo with DCT-domain shrink on
// load: a 61 MP A7CR JPEG to 1536 px in well under 100 ms) re-encoded as a high-quality JPEG
// and decoded with jpeg-js, because Bun.Image has no raw-pixel output. 1536 px is enough for
// every Eye network (the largest inputs are 768 px; faces are cropped from what we pass, so
// a bit of headroom keeps small faces analysable).
async function decode(path: string): Promise<{ data: Uint8Array; width: number; height: number }> {
    const bytes = await new Bun.Image(path)
        .resize(ANALYSIS_EDGE, ANALYSIS_EDGE, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 92 })
        .bytes();
    const px = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: false, maxMemoryUsageInMB: 256 });
    return { data: px.data, width: px.width, height: px.height };
}

// Decoding the next photo overlaps the current inference: the GPU run and the JPEG work use
// different resources, and the queue is fed one request at a time by the client anyway.
let chain: Promise<void> = Promise.resolve();

async function handle(msg: EyeRequest) {
    switch (msg.type) {
        case "init": {
            try {
                eye = await Eye.load({ directory: msg.modelDir });
                send({ type: "ready", accelerator });
            } catch (err) {
                send({ type: "fatal", message: err instanceof Error ? err.message : String(err) });
            }
            return;
        }
        case "analyze": {
            const pixels = decode(msg.path);
            chain = chain.then(async () => {
                try {
                    if (!eye) throw new Error("model not loaded");
                    const input = await pixels;
                    const started = performance.now();
                    const analysis = await eye.analyze(input);
                    const ms = performance.now() - started;
                    send({
                        type: "result",
                        id: msg.id,
                        summary: summarize(analysis, accelerator, ms),
                        json: JSON.stringify(analysis),
                    });
                } catch (err) {
                    send({ type: "error", id: msg.id, message: err instanceof Error ? err.message : String(err) });
                }
            });
            return;
        }
        case "group": {
            // Duplicate grouping needs the restored analyses (embeddings), which only this
            // process holds the SDK for; it is pure math, no model run.
            try {
                const analyses = msg.analyses.map(json => Analysis.fromJSON(json));
                const groups = Eye.duplicates(analyses, { dates: msg.dates });
                const best = groups.map(group => {
                    const pick = Eye.best(group.map(i => analyses[i]!));
                    return pick === null ? group[0]! : group[pick]!;
                });
                send({ type: "groups", id: msg.id, groups, best });
            } catch (err) {
                send({ type: "error", id: msg.id, message: err instanceof Error ? err.message : String(err) });
            }
            return;
        }
        case "shutdown": {
            await chain;
            eye?.dispose();
            process.exit(0);
        }
    }
}

export function runEyeProcess() {
    process.on("message", (msg: EyeRequest) => { void handle(msg); });
    // The parent going away (crash, kill) must not leave a GPU process running.
    process.on("disconnect", () => process.exit(0));
}
