import { writeOrCheck } from "./api-snapshot.js";
import { dotnetContract, readDotnetSnapshot } from "./dotnet-api.js";

/** Write or verify `api/dotnet.txt` from the built assemblies of the four .NET packages. */

await writeOrCheck(dotnetContract, await readDotnetSnapshot(), process.argv.includes("--check"));
