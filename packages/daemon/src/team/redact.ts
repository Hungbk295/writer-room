/** Redact tokens/secrets from team messages and audit. */

const PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /Bearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
  /(api[_-]?key|token|secret|password|passwd|credential)(\s*[=:]\s*)['"]?[^\s'"]{8,}['"]?/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const p of PATTERNS) {
    out = out.replace(p, (m, ...groups) => {
      if (typeof groups[0] === 'string' && typeof groups[1] === 'string' && m.toLowerCase().includes(groups[0].toLowerCase())) {
        return `${groups[0]}${groups[1]}[redacted]`;
      }
      return '[redacted]';
    });
  }
  return out;
}
