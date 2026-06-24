export async function readTextFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);

  let encoding: string = "utf-8";
  let offset = 0;

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le";
    offset = 2;
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
    offset = 2;
  } else if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    encoding = "utf-8";
    offset = 3;
  }

  const decoder = new TextDecoder(encoding);
  return decoder.decode(bytes.slice(offset));
}
