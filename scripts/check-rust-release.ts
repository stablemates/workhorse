import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
function run(command: string, args: string[], cwd = root): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} ${args.join(" ")} exited with ${code}`)),
    );
  });
}
const cargo = (...args: string[]) => run("mise", ["exec", "--", "cargo", ...args]);

await cargo("fmt", "--all", "--", "--check");
await cargo("clippy", "--workspace", "--all-targets", "--all-features", "--", "-D", "warnings");
await cargo("test", "--workspace");
await cargo("package", "-p", "workhorse-client", "--allow-dirty", "--no-verify");

const consumer = await mkdtemp(path.join(tmpdir(), "workhorse-rust-consumer-"));
try {
  await mkdir(path.join(consumer, "src"));
  await writeFile(
    path.join(consumer, "Cargo.toml"),
    `[package]\nname = "clean-consumer"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nworkhorse-client = { path = ${JSON.stringify(path.join(root, "rust"))} }\n`,
  );
  await writeFile(
    path.join(consumer, "src", "main.rs"),
    "fn main() { assert_eq!(workhorse_client::CLIENT_PROTOCOL_VERSION, 4); }\n",
  );
  await cargo("check", "--manifest-path", path.join(consumer, "Cargo.toml"));
  await cargo("check", "--manifest-path", path.join(consumer, "Cargo.toml"), "--locked");
} finally {
  await rm(consumer, { recursive: true, force: true });
}
