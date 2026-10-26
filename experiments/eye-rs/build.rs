// litert-sys links libLiteRt.so from its download cache but sets no rpath, so the binary
// failed at start with "libLiteRt.so: cannot open shared object file". Bake the cache dir
// in. LiteRT dlopens libLiteRtWebGpuAccelerator.so by bare name from the same directory:
// a DT_RUNPATH on the executable only covers the executable's own dependencies, not a
// dlopen() made from inside libLiteRt.so, while the old DT_RPATH does. Hence
// --disable-new-dtags.
//
// Mirrors litert-sys 0.2.1's cache layout: <cache>/litert-sys/v0.10.2/<target>.

use std::env;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-env-changed=LITERT_LIB_DIR");
    println!("cargo:rerun-if-env-changed=LITERT_CACHE_DIR");
    let dir = if let Ok(dir) = env::var("LITERT_LIB_DIR") {
        PathBuf::from(dir)
    } else {
        let root = env::var("LITERT_CACHE_DIR").map(PathBuf::from).unwrap_or_else(|_| {
            let cache = env::var("XDG_CACHE_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|_| PathBuf::from(env::var("HOME").unwrap()).join(".cache"));
            cache.join("litert-sys")
        });
        root.join("v0.10.2").join(env::var("TARGET").unwrap())
    };
    println!("cargo:rustc-link-arg=-Wl,--disable-new-dtags,-rpath,{}", dir.display());
}
