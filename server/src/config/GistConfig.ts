export function resolveGistServerToken(
  raw: string | undefined,
  forbiddenCredentials: readonly string[],
): string | null {
  const token = raw?.trim() ?? "";
  if (!token) return null;
  if (forbiddenCredentials.some((credential) => credential && credential === token)) {
    throw new Error(
      "The server Gist credential must be distinct from repository and controller API credentials",
    );
  }
  return token;
}
