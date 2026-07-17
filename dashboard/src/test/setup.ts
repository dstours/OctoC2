import { afterEach, expect } from "bun:test";

interface JSDOMWindow extends Window {
  close(): void;
}

interface JSDOMInstance {
  window: JSDOMWindow;
}

interface JSDOMConstructor {
  new (
    html?: string,
    options?: { url?: string; pretendToBeVisual?: boolean },
  ): JSDOMInstance;
}

const { JSDOM } = require("jsdom") as {
  JSDOM: JSDOMConstructor;
};

const dom = new JSDOM(
  "<!doctype html><html><head></head><body></body></html>",
  {
    url: "http://localhost/",
    pretendToBeVisual: true,
  },
);

const explicitlyMappedGlobals = new Set<PropertyKey>([
  "window",
  "document",
  "navigator",
]);

for (const property of Reflect.ownKeys(dom.window)) {
  if (explicitlyMappedGlobals.has(property)) continue;
  if (property in globalThis) continue;
  const descriptor = Object.getOwnPropertyDescriptor(dom.window, property);
  if (descriptor) {
    Object.defineProperty(globalThis, property, descriptor);
  }
}

Object.defineProperties(globalThis, {
  window: {
    configurable: true,
    value: dom.window,
  },
  document: {
    configurable: true,
    value: dom.window.document,
  },
  navigator: {
    configurable: true,
    value: dom.window.navigator,
  },
  IS_REACT_ACT_ENVIRONMENT: {
    configurable: true,
    value: true,
    writable: true,
  },
});

if (!dom.window.matchMedia) {
  Object.defineProperty(dom.window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

if (!globalThis.ResizeObserver) {
  class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: ResizeObserver,
  });
}

const { cleanup } = require("@testing-library/react") as typeof import("@testing-library/react");
const matchers = require("@testing-library/jest-dom/matchers") as typeof import("@testing-library/jest-dom/matchers");

expect.extend(matchers);

afterEach(() => {
  cleanup();
  dom.window.localStorage.clear();
  dom.window.sessionStorage.clear();
});
