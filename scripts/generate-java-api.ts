import { writeOrCheck } from "./api-snapshot.js";
import { javaContract, readJvmSnapshot } from "./jvm-api.js";

/** Write or verify `api/java.txt` from the `workhorse` and `workhorse-spring-boot-starter` jars. */

await writeOrCheck(
  javaContract,
  await readJvmSnapshot("javaApi", "java.txt"),
  process.argv.includes("--check"),
);
