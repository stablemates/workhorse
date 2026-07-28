process.env.PORT = process.env.WORKHORSE_API_PORT ?? "3001";

await import("./index.js");
