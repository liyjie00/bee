import { describe, expect, it } from 'vitest';
import { withShareToken } from '../src/react/extensions.js';

describe('withShareToken', () => {
  it('adds the public link token to Bee uploads', () => {
    expect(withShareToken('/api/uploads/abc', 'tok')).toBe('/api/uploads/abc?share=tok');
  });
  it('leaves other images and signed-in views alone', () => {
    expect(withShareToken('https://example.com/a.png', 'tok')).toBe('https://example.com/a.png');
    expect(withShareToken('/api/uploads/abc', undefined)).toBe('/api/uploads/abc');
    expect(withShareToken('/api/uploads/abc?share=x', 'tok')).toBe('/api/uploads/abc?share=x');
  });
});
