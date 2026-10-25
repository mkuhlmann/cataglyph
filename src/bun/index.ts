// Entry of the Bun process. The same bundle serves two roles:
//   default                   the app: RPC handlers, media server, session (app.ts)
//   CATAGLYPH_ROLE=eye        the Eye inference process (see classify/eye-process.ts)
// One bundle instead of two keeps packaging to one file per process kind; the role switch
// keeps the Eye process free of the app's services (databases, media server, IPC handlers).

if (process.env.CATAGLYPH_ROLE === "eye") {
    const { runEyeProcess } = await import("./classify/eye-process.ts");
    runEyeProcess();
} else {
    await import("./app.ts");
}

export {};
