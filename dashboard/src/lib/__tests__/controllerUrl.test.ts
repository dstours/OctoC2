import { describe, expect, it } from 'bun:test';
import { normalizeControllerOrigin } from '../controllerUrl';

describe('normalizeControllerOrigin', () => {
  it('returns a canonical, pathless HTTPS origin', () => {
    expect(normalizeControllerOrigin(' https://Controller.Example:443/ ')).toBe(
      'https://controller.example',
    );
    expect(normalizeControllerOrigin('https://127.0.0.1:8080')).toBe(
      'https://127.0.0.1:8080',
    );
  });

  it('rejects insecure HTTP', () => {
    expect(() => normalizeControllerOrigin('http://controller.example')).toThrow(
      /pathless HTTPS origin/i,
    );
  });

  it('rejects userinfo, including an empty userinfo delimiter', () => {
    expect(() =>
      normalizeControllerOrigin('https://operator:secret@controller.example'),
    ).toThrow(/pathless HTTPS origin/i);
    expect(() => normalizeControllerOrigin('https://@controller.example')).toThrow(
      /pathless HTTPS origin/i,
    );
  });

  it('rejects query strings and fragments, including empty delimiters', () => {
    expect(() =>
      normalizeControllerOrigin('https://controller.example?target=attacker'),
    ).toThrow(/pathless HTTPS origin/i);
    expect(() => normalizeControllerOrigin('https://controller.example?')).toThrow(
      /pathless HTTPS origin/i,
    );
    expect(() => normalizeControllerOrigin('https://controller.example#')).toThrow(
      /pathless HTTPS origin/i,
    );
  });

  it('rejects paths and normalized dot-segment paths', () => {
    expect(() =>
      normalizeControllerOrigin('https://controller.example/proxy'),
    ).toThrow(/pathless HTTPS origin/i);
    expect(() => normalizeControllerOrigin('https://controller.example/.')).toThrow(
      /pathless HTTPS origin/i,
    );
    expect(() =>
      normalizeControllerOrigin('https://controller.example\\proxy'),
    ).toThrow(/pathless HTTPS origin/i);
  });
});
