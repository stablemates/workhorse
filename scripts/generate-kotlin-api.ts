import { writeOrCheck } from "./api-snapshot.js";
import { kotlinContract, readJvmSnapshot } from "./jvm-api.js";

/** Write or verify `api/kotlin.txt` from the `workhorse-kotlin` sources. */

await writeOrCheck(
  kotlinContract,
  await readJvmSnapshot("kotlinApi", "kotlin.txt"),
  process.argv.includes("--check"),
);
