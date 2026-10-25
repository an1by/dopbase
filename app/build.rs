// `sqlx::migrate!` embeds the migrations directory at compile time, but
// cargo does not know that. Without this, adding a migration file leaves the
// binary running the old set until some Rust source changes.
fn main() {
  println!("cargo:rerun-if-changed=migrations");
}
