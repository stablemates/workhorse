import { requireDevelopmentApiPort } from "./development-port.js";

process.env.PORT = String(requireDevelopmentApiPort(process.env.WORKHORSE_API_PORT));

await import("./index.js");
