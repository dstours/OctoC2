import { describe, expect, it } from "bun:test";
import {
  isLoopbackHost,
  readBooleanFlag,
  readListenerConfig,
} from "../config/RuntimeConfig.ts";

describe("listener runtime configuration", () => {
  it("opens no HTTP or gRPC listener by default", () => {
    const config = readListenerConfig({});
    expect(config.http.enabled).toBe(false);
    expect(config.grpc.enabled).toBe(false);
  });

  it("uses loopback hosts when listeners are explicitly enabled", () => {
    const config = readListenerConfig({
      OCTOC2_HTTP_ENABLED: "true",
      OCTOC2_HTTP_SERVER_CERT: "certs/http.crt",
      OCTOC2_HTTP_SERVER_KEY: "certs/http.key",
      OCTOC2_GRPC_ENABLED: "1",
    });
    expect(config.http).toEqual({
      enabled: true,
      host: "127.0.0.1",
      port: 8080,
      tlsCertificateFile: "certs/http.crt",
      tlsPrivateKeyFile: "certs/http.key",
    });
    expect(config.grpc).toEqual({
      enabled: true,
      host: "127.0.0.1",
      port: 50_051,
    });
  });

  it("requires deliberate host overrides and valid ports", () => {
    const config = readListenerConfig({
      OCTOC2_HTTP_ENABLED: "yes",
      OCTOC2_HTTP_HOST: "0.0.0.0",
      OCTOC2_HTTP_PORT: "8443",
      OCTOC2_HTTP_SERVER_CERT: "server.crt",
      OCTOC2_HTTP_SERVER_KEY: "server.key",
      OCTOC2_GRPC_ENABLED: "on",
      OCTOC2_GRPC_HOST: "::1",
      OCTOC2_GRPC_PORT: "55051",
    });
    expect(config.http.host).toBe("0.0.0.0");
    expect(config.http.port).toBe(8443);
    expect(config.grpc.host).toBe("::1");
    expect(config.grpc.port).toBe(55_051);

    expect(() =>
      readListenerConfig({ OCTOC2_HTTP_PORT: "0" })
    ).toThrow("OCTOC2_HTTP_PORT");
    expect(() =>
      readListenerConfig({ OCTOC2_GRPC_PORT: "not-a-port" })
    ).toThrow("OCTOC2_GRPC_PORT");
  });

  it("requires a certificate and private key for the HTTP listener", () => {
    expect(() =>
      readListenerConfig({ OCTOC2_HTTP_ENABLED: "true" })
    ).toThrow("OCTOC2_HTTP_SERVER_CERT");
    expect(() =>
      readListenerConfig({
        OCTOC2_HTTP_ENABLED: "true",
        OCTOC2_HTTP_SERVER_CERT: "server.crt",
      })
    ).toThrow("OCTOC2_HTTP_SERVER_KEY");
  });

  it("classifies explicit feature flags and loopback hosts consistently", () => {
    expect(readBooleanFlag("TRUE")).toBe(true);
    expect(readBooleanFlag("off")).toBe(false);
    expect(isLoopbackHost("127.0.0.2")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });
});
