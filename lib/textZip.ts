export interface TextZipFile {
  name: string;
  content: string;
}

const ZIP_UTF8_FLAG = 0x0800;

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  bytes.forEach((byte) => {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  });
  return (crc ^ 0xffffffff) >>> 0;
};

const pushUint16 = (parts: number[], value: number) => {
  parts.push(value & 0xff, (value >>> 8) & 0xff);
};

const pushUint32 = (parts: number[], value: number) => {
  parts.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
};

const concatZipParts = (header: number[], ...parts: Uint8Array[]): Uint8Array => {
  const headerBytes = Uint8Array.from(header);
  const chunk = new Uint8Array(
    headerBytes.length + parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  chunk.set(headerBytes, offset);
  offset += headerBytes.length;
  parts.forEach((part) => {
    chunk.set(part, offset);
    offset += part.length;
  });
  return chunk;
};

export const buildTextFilesZipBlob = (files: TextZipFile[]): Blob => {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const centralDirectory: Uint8Array[] = [];
  let offset = 0;

  files.forEach((file) => {
    const nameBytes = encoder.encode(file.name);
    const contentBytes = encoder.encode(file.content);
    const checksum = crc32(contentBytes);

    const localHeader: number[] = [];
    pushUint32(localHeader, 0x04034b50);
    pushUint16(localHeader, 20);
    pushUint16(localHeader, ZIP_UTF8_FLAG);
    pushUint16(localHeader, 0);
    pushUint16(localHeader, 0);
    pushUint16(localHeader, 0);
    pushUint32(localHeader, checksum);
    pushUint32(localHeader, contentBytes.length);
    pushUint32(localHeader, contentBytes.length);
    pushUint16(localHeader, nameBytes.length);
    pushUint16(localHeader, 0);
    const localChunk = concatZipParts(localHeader, nameBytes, contentBytes);
    chunks.push(localChunk);

    const centralHeader: number[] = [];
    pushUint32(centralHeader, 0x02014b50);
    pushUint16(centralHeader, 20);
    pushUint16(centralHeader, 20);
    pushUint16(centralHeader, ZIP_UTF8_FLAG);
    pushUint16(centralHeader, 0);
    pushUint16(centralHeader, 0);
    pushUint16(centralHeader, 0);
    pushUint32(centralHeader, checksum);
    pushUint32(centralHeader, contentBytes.length);
    pushUint32(centralHeader, contentBytes.length);
    pushUint16(centralHeader, nameBytes.length);
    pushUint16(centralHeader, 0);
    pushUint16(centralHeader, 0);
    pushUint16(centralHeader, 0);
    pushUint16(centralHeader, 0);
    pushUint32(centralHeader, 0);
    pushUint32(centralHeader, offset);
    centralDirectory.push(concatZipParts(centralHeader, nameBytes));

    offset += localChunk.length;
  });

  const centralDirectorySize = centralDirectory.reduce((total, chunk) => total + chunk.length, 0);
  const endRecord: number[] = [];
  pushUint32(endRecord, 0x06054b50);
  pushUint16(endRecord, 0);
  pushUint16(endRecord, 0);
  pushUint16(endRecord, files.length);
  pushUint16(endRecord, files.length);
  pushUint32(endRecord, centralDirectorySize);
  pushUint32(endRecord, offset);
  pushUint16(endRecord, 0);

  return new Blob([...chunks, ...centralDirectory, new Uint8Array(endRecord)], {
    type: "application/zip",
  });
};
