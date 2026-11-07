import { describe, expect, it } from 'vitest';
import { decodeBase64Image, isPublicAddress, sniffImage } from '../src/lib/images.js';

describe('images', () => {
  it('sniffs image types from bytes', () => {
    const png = decodeBase64Image(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    );
    expect(sniffImage(png)).toBe('image/png');
    expect(sniffImage(Buffer.from('GIF89a0000000000'))).toBe('image/gif');
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(
      'image/jpeg',
    );
    expect(sniffImage(Buffer.from('<svg xmlns="x"></svg>'))).toBeNull();
  });

  it('only treats public addresses as reachable', () => {
    const blocked = [
      '127.0.0.1',
      '10.1.2.3',
      '192.168.1.10',
      '172.20.0.1',
      '169.254.169.254',
      '100.100.1.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
    ];
    for (const a of blocked) expect(isPublicAddress(a), a).toBe(false);
    for (const a of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111'])
      expect(isPublicAddress(a), a).toBe(true);
  });
});
