import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { ModuleStore } from "../http/ModuleStore.ts";
import { rm } from "node:fs/promises";

const TEST_DIR = "/tmp/svc-modulestore-test";
let store: ModuleStore;

beforeAll(() => { store = new ModuleStore(TEST_DIR); });
afterAll(async () => { await rm(TEST_DIR, { recursive: true, force: true }); });

describe("ModuleStore", () => {
  it("stores and fetches a binary", async () => {
    const data = new Uint8Array([0x7f, 0x45, 0x4c, 0x46]); // ELF magic
    await store.store("beacon1", "recon", data);
    const fetched = await store.fetch("beacon1", "recon");
    expect(fetched).not.toBeNull();
    expect(fetched!).toEqual(data);
  });

  it("returns null for unknown module", async () => {
    const result = await store.fetch("beacon1", "nonexistent");
    expect(result).toBeNull();
  });

  it("returns null for unknown beacon", async () => {
    const result = await store.fetch("unknown-beacon", "recon");
    expect(result).toBeNull();
  });

  it("lists stored modules for a beacon", async () => {
    await store.store("beacon2", "alpha", new Uint8Array([1]));
    await store.store("beacon2", "beta", new Uint8Array([2]));
    const names = await store.list("beacon2");
    expect(names).toEqual(["alpha", "beta"]);
  });

  it("returns empty list for beacon with no modules", async () => {
    const names = await store.list("empty-beacon");
    expect(names).toEqual([]);
  });

  it("overwrites an existing module", async () => {
    const v1 = new Uint8Array([0x01]);
    const v2 = new Uint8Array([0x02]);
    await store.store("beacon3", "mod", v1);
    await store.store("beacon3", "mod", v2);
    const fetched = await store.fetch("beacon3", "mod");
    expect(fetched).toEqual(v2);
  });
});
