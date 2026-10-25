/// <reference types="vite/client" />

// vue-tsc patches TypeScript through Node's module loader and doesn't work under Bun (there
// is no Node on this machine), so SFCs are typed as opaque components here and checked by
// the Vue compiler during `vite build` instead.
declare module "*.vue" {
    const component: any;
    export default component;
}
