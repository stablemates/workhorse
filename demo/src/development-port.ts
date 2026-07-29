export function requireDevelopmentApiPort(value: string | undefined): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(
      "WORKHORSE_API_PORT must be a positive port assigned by the root development launcher. Run `pnpm demo` from the repository root.",
    );
  }

  return port;
}
