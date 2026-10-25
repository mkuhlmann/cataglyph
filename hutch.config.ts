// @hutch cli=0.28.1 cottontail=0.7.2
export default {
    packageManager: "bun",
    scripts: {
        install: ["bun", "install", "--frozen-lockfile"],
        vendor: ["bun", "run", "scripts/fetch-vendor.ts"],
        build: ["bun", "run", "scripts/build.ts"],
        dev: ["bun", "run", "scripts/dev.ts"],
        "dev:hmr": ["bun", "run", "scripts/dev.ts", "--hmr"],
        package: ["bun", "run", "scripts/package.ts"],
        appimage: ["bun", "run", "scripts/package.ts"],
    },
};
