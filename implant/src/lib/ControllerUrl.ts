export function requireHttpsControllerUrl(
  raw: string | undefined,
  label = "controller serverUrl",
): string {
  const value = raw?.trim();
  if (!value) throw new Error(`${label} is required`);

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid absolute URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not contain credentials`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`${label} must not contain a query or fragment`);
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error(`${label} must not contain a path`);
  }
  return parsed.origin;
}
