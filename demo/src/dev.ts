process.env.PORT = process.env.IRONSHIFT_API_PORT ?? "3001";

await import("./index.js");
