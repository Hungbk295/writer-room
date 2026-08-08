export function parseDhashHex(hex: string): bigint {
  return BigInt(`0x${hex}`);
}

/** Hamming distance between two 64-bit perceptual hashes. */
export function hamming64(a: bigint, b: bigint): number {
  let xor = a ^ b;
  let count = 0;
  while (xor > 0n) {
    count += Number(xor & 1n);
    xor >>= 1n;
  }
  return count;
}

export function dhashFromGray9x8(buffer: Uint8Array): bigint {
  if (buffer.length < 72) throw new TypeError(`dhash requires 72 bytes, received ${buffer.length}`);
  let hash = 0n;
  for (let row = 0; row < 8; row++) {
    for (let column = 0; column < 8; column++) {
      const offset = row * 9 + column;
      hash = (hash << 1n) | (buffer[offset]! > buffer[offset + 1]! ? 1n : 0n);
    }
  }
  return hash;
}

export function dhashToHex(value: bigint): string {
  return value.toString(16).padStart(16, '0');
}

export function isDuplicateDhash(value: bigint, kept: readonly bigint[], threshold: number): boolean {
  return kept.some((candidate) => hamming64(value, candidate) <= threshold);
}
