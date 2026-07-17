const FALLBACK_CONTROLLER_ORIGIN = 'https://127.0.0.1:8080';

const CONTROLLER_URL_ERROR =
  'Controller URL must be a pathless HTTPS origin without userinfo, query, or fragment';

/**
 * Validate and canonicalize a controller base URL before it reaches fetch.
 *
 * Only a bare HTTPS origin is accepted. A single trailing slash is harmless
 * and is removed; every other suffix is rejected so URL concatenation cannot
 * redirect credentials to an attacker-controlled authority or path.
 */
export function normalizeControllerOrigin(input: string): string {
  const candidate = input.trim();
  let parsed: URL;

  try {
    parsed = new URL(candidate);
  } catch {
    throw new TypeError(CONTROLLER_URL_ERROR);
  }

  const schemeSeparator = candidate.indexOf('://');
  const authorityStart = schemeSeparator + 3;
  const suffixOffset = candidate.slice(authorityStart).search(/[/?#]/u);
  const authorityEnd =
    suffixOffset === -1 ? candidate.length : authorityStart + suffixOffset;
  const authority = candidate.slice(authorityStart, authorityEnd);
  const suffix = candidate.slice(authorityEnd);

  if (
    parsed.protocol !== 'https:' ||
    schemeSeparator <= 0 ||
    authority.length === 0 ||
    authority.includes('@') ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    /[\u0000-\u0020\u007f]/u.test(candidate) ||
    (suffix !== '' && suffix !== '/')
  ) {
    throw new TypeError(CONTROLLER_URL_ERROR);
  }

  return parsed.origin;
}

export const DEFAULT_CONTROLLER_ORIGIN = normalizeControllerOrigin(
  (import.meta.env['VITE_C2_SERVER_URL'] as string | undefined) ??
    FALLBACK_CONTROLLER_ORIGIN,
);
