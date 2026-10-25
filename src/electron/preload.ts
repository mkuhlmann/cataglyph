// The view's only door to the rest of the app: `window.cataglyph` (Bridge in shared/rpc.ts).
// The renderer runs sandboxed with context isolation, so it gets these two functions and
// nothing of Node or Electron.

import { contextBridge, ipcRenderer } from "electron";

import type { Bridge } from "../shared/rpc.ts";

const bridge: Bridge = {
    request: (method, params) => ipcRenderer.invoke("rpc", method, params),
    onMessage: listener => {
        ipcRenderer.on("rpc-message", (_event, name: string, payload: unknown) => listener(name, payload));
    },
};

contextBridge.exposeInMainWorld("cataglyph", bridge);
