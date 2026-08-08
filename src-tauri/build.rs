fn main() {
    // Emit the Windows manifest (DPI awareness + per-monitor v2) and generate
    // the Tauri codegen context.
    tauri_build::build();

    // Media Foundation + DXGI are delay-loaded on purpose: ClipFlow must still
    // launch on Windows N/KN editions that ship without the media pack, so we
    // can surface a friendly error instead of a hard loader failure.
    #[cfg(windows)]
    {
        println!("cargo:rustc-link-arg=/DELAYLOAD:mf.dll");
        println!("cargo:rustc-link-arg=/DELAYLOAD:mfplat.dll");
        println!("cargo:rustc-link-arg=/DELAYLOAD:mfreadwrite.dll");
        println!("cargo:rustc-link-arg=/DELAYLOAD:mfuuid.dll");
        println!("cargo:rustc-link-lib=dylib=delayimp");
    }
}
