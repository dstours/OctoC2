/**
 * OctoC2 — Shared constants
 *
 * Centralizes magic strings used across the implant so they don't drift
 * between tentacles, crypto modules, and the main loop.
 */

/** User-Agent string mimicking the official GitHub CLI for OPSEC blending. */
export const GH_UA = "GitHub CLI/gh/2.48.0 (linux; amd64) go/1.23.0";

/** Name of the repo variable that holds the operator's X25519 public key. */
export const OPERATOR_PUBKEY_VAR = "MONITORING_PUBKEY";
