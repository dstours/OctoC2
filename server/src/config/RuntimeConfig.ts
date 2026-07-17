export interface ListenerConfig {
  http: {
    enabled: boolean;
    host: string;
    port: number;
    tlsCertificateFile: string | null;
    tlsPrivateKeyFile: string | null;
  };
  grpc: {
    enabled: boolean;
    host: string;
    port: number;
  };
}

export function readBooleanFlag(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(
    (value ?? "").trim().toLowerCase(),
  );
}

function readPort(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > 65_535
  ) {
    throw new Error(`${name} must be an integer from 1 through 65535`);
  }
  return parsed;
}

function readHost(value: string | undefined): string {
  return value?.trim() || "127.0.0.1";
}

function readRequiredPath(
  value: string | undefined,
  name: string,
  required: boolean,
): string | null {
  const path = value?.trim();
  if (required && !path) {
    throw new Error(`${name} is required when OCTOC2_HTTP_ENABLED is true`);
  }
  return path || null;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized.startsWith("127.");
}

/**
 * Listener exposure is deliberately opt-in. Enabling a listener without
 * selecting a host still binds only to IPv4 loopback.
 */
export function readListenerConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ListenerConfig {
  const httpEnabled = readBooleanFlag(env["OCTOC2_HTTP_ENABLED"]);
  return {
    http: {
      enabled: httpEnabled,
      host: readHost(env["OCTOC2_HTTP_HOST"]),
      port: readPort(env["OCTOC2_HTTP_PORT"], 8080, "OCTOC2_HTTP_PORT"),
      tlsCertificateFile: readRequiredPath(
        env["OCTOC2_HTTP_SERVER_CERT"],
        "OCTOC2_HTTP_SERVER_CERT",
        httpEnabled,
      ),
      tlsPrivateKeyFile: readRequiredPath(
        env["OCTOC2_HTTP_SERVER_KEY"],
        "OCTOC2_HTTP_SERVER_KEY",
        httpEnabled,
      ),
    },
    grpc: {
      enabled: readBooleanFlag(env["OCTOC2_GRPC_ENABLED"]),
      host: readHost(env["OCTOC2_GRPC_HOST"]),
      port: readPort(env["OCTOC2_GRPC_PORT"], 50_051, "OCTOC2_GRPC_PORT"),
    },
  };
}
