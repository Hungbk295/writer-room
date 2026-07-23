fn main() {
    let target = std::env::var("TARGET").expect("Cargo TARGET");
    println!("cargo:rustc-env=WRITER_ROOM_TARGET_TRIPLE={target}");
    tauri_build::build()
}
