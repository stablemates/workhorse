import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
function run(args: string[], cwd = root): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("cargo", args, {
      cwd,
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`cargo exited with ${code}`)),
    );
  });
}
await run(["package", "--manifest-path", "rust/Cargo.toml", "--allow-dirty"]);
const consumer = await mkdtemp(path.join(tmpdir(), "workhorse-rust-consumer-"));
try {
  await mkdir(path.join(consumer, "src"));
  await writeFile(
    path.join(consumer, "Cargo.toml"),
    `[package]\nname = "clean-consumer"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nworkhorse-client = { path = ${JSON.stringify(path.join(root, "rust"))} }\n`,
  );
  await writeFile(
    path.join(consumer, "src", "main.rs"),
    "fn main() { let _ = workhorse_client::CLIENT_PROTOCOL_VERSION; }\n",
  );
  await run(["check", "--manifest-path", path.join(consumer, "Cargo.toml")]);
} finally {
  await rm(consumer, { recursive: true, force: true });
}
