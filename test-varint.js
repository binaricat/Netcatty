function readVarInt(buf, offset) {
  let val = 0;
  let shift = 0;
  let len = 0;
  while (offset + len < buf.length) {
    const b = buf[offset + len];
    val |= (b & 0x7F) << shift;
    shift += 7;
    len++;
    if ((b & 0x80) === 0) break;
  }
  return { val, len };
}

const buf = Buffer.from([0x08, 0x96, 0x01]);
let offset = 1; // skip 0x08
const { val, len } = readVarInt(buf, offset);
console.log(val, len);
