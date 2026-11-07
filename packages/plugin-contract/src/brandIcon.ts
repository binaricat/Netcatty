/** Brand metadata only: static, bounded raster input. Decoding still runs in isolation. */
export const PLUGIN_BRAND_ICON_FEATURE = 'metadata.brand-icon';
export const PLUGIN_BRAND_ICON_MAX_BYTES = 256 * 1024;
export const PLUGIN_BRAND_ICON_MAX_EDGE = 512;
export function inspectPluginBrandIcon(bytes: Uint8Array, packagePath: string): { mimeType: string; width: number; height: number } {
  if (!bytes.length || bytes.length > PLUGIN_BRAND_ICON_MAX_BYTES) throw new Error('Plugin brand icon exceeds size limit or is empty');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, count: number) => String.fromCharCode(...bytes.subarray(start, start + count));
  let width = 0; let height = 0; let mimeType = '';
  if (packagePath.endsWith('.png') && bytes.length >= 33 && [137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v)) {
    mimeType = 'image/png';
    let end = false; let data = false;
    for (let offset = 8; offset < bytes.length;) {
      if (offset + 12 > bytes.length) throw new Error('Invalid PNG chunk');
      const size = view.getUint32(offset); const kind = ascii(offset + 4, 4);
      if (offset + 12 + size > bytes.length) throw new Error('Invalid PNG length');
      if (kind === 'acTL' || kind === 'fcTL' || kind === 'fdAT') throw new Error('Animated brand icons are unsupported');
      if (offset === 8) {
        if (kind !== 'IHDR' || size !== 13) throw new Error('Invalid PNG header');
        width = view.getUint32(offset + 8); height = view.getUint32(offset + 12);
      } else if (kind === 'IHDR') throw new Error('Duplicate PNG header');
      if (kind === 'IDAT') data = true;
      offset += 12 + size;
      if (kind === 'IEND') { end = size === 0 && offset === bytes.length; break; }
    }
    if (!end || !data) throw new Error('Incomplete PNG icon');
  } else if (packagePath.endsWith('.webp') && bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    mimeType = 'image/webp';
    if (view.getUint32(4, true) + 8 !== bytes.length) throw new Error('Invalid WebP length');
    let image = false;
    for (let offset = 12; offset < bytes.length;) {
      if (offset + 8 > bytes.length) throw new Error('Invalid WebP chunk');
      const kind = ascii(offset, 4); const size = view.getUint32(offset + 4, true); const start = offset + 8;
      if (start + size + (size % 2) > bytes.length) throw new Error('Invalid WebP chunk length');
      if (kind === 'ANIM' || kind === 'ANMF' || (kind === 'VP8X' && (bytes[start] & 2))) throw new Error('Animated brand icons are unsupported');
      if (kind === 'VP8X' && size === 10) {
        width = 1 + bytes[start+4] + (bytes[start+5]<<8) + (bytes[start+6]<<16);
        height = 1 + bytes[start+7] + (bytes[start+8]<<8) + (bytes[start+9]<<16);
      } else if (kind === 'VP8L' && size >= 5 && bytes[start] === 0x2f) {
        const bits = view.getUint32(start + 1, true);
        const w = 1 + (bits & 0x3fff); const h = 1 + ((bits >>> 14) & 0x3fff);
        if (w > 512 || h > 512) throw new Error('WebP image dimensions exceed limit');
        width ||= w; height ||= h; image = true;
      } else if (kind === 'VP8 ' && size >= 10 && bytes[start+3] === 0x9d && bytes[start+4] === 1 && bytes[start+5] === 0x2a) {
        const w = view.getUint16(start+6, true) & 0x3fff; const h = view.getUint16(start+8, true) & 0x3fff;
        if (w > 512 || h > 512) throw new Error('WebP image dimensions exceed limit');
        width ||= w; height ||= h; image = true;
      }
      offset = start + size + (size % 2);
    }
    if (!image) throw new Error('Missing WebP image');
  } else throw new Error('Brand icons require matching PNG or WebP bytes and extension');
  if (width < 1 || height < 1 || width > PLUGIN_BRAND_ICON_MAX_EDGE || height > PLUGIN_BRAND_ICON_MAX_EDGE) throw new Error('Plugin brand icon dimensions exceed 512px or are invalid');
  return { mimeType, width, height };
}
