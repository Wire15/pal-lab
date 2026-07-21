//! Compiles the vendored powzix/ooz Kraken decompressor (C++) into a static
//! library linked into this crate. See `vendor/ooz/README.md` for provenance
//! and license status. Decompression only; the upstream CLI `main` was removed.

fn main() {
    let mut build = cc::Build::new();
    build
        .cpp(true)
        .file("vendor/ooz/kraken.cpp")
        .file("vendor/ooz/bitknit.cpp")
        .file("vendor/ooz/lzna.cpp")
        // The vendored sources are warning-noisy legacy C++; silence them so
        // they do not drown out this crate's diagnostics.
        .warnings(false);

    if build.get_compiler().is_like_msvc() {
        // C++ exception model required by <Windows.h>/MSVC headers.
        build.flag("/EHsc");
        build.flag("/w");
    } else {
        build.flag("-w");
    }

    build.compile("ooz");

    println!("cargo:rerun-if-changed=vendor/ooz/kraken.cpp");
    println!("cargo:rerun-if-changed=vendor/ooz/bitknit.cpp");
    println!("cargo:rerun-if-changed=vendor/ooz/lzna.cpp");
    println!("cargo:rerun-if-changed=vendor/ooz/stdafx.h");
}
