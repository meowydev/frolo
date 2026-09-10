// Sanitizer (req §11.3, §11.12). A single function that every log/audit/error
// string passes through. It redacts known secret patterns. Additional literal
// secret values (a specific token/password/key currently in memory) can be
// registered transiently so they never leak even if concatenated into a message.

const REDACTED = "[REDACTED]";

// Patterns that redact structured secrets regardless of registration.
const PATTERNS: Array<{ re: RegExp; replace: string }> = [
  // Authorization header: redact everything after the header name.
  { re: /\b(authorization)\s*[:=]\s*[^\r\n]+/gi, replace: `$1: ${REDACTED}` },
  { re: /\bBearer\s+[A-Za-z0-9._~+/-]+=*/g, replace: `Bearer ${REDACTED}` },
  // Proxmox API tokens: PVEAPIToken=user@realm!tokenid=secret
  {
    re: /PVEAPIToken=[^\s,;]+/gi,
    replace: `PVEAPIToken=${REDACTED}`,
  },
  // Cookies
  { re: /\b(set-cookie|cookie)\s*[:=]\s*[^\r\n]+/gi, replace: `$1: ${REDACTED}` },
  // CSRF tokens
  {
    re: /\b(csrf[_-]?token|x-csrf-token|csrfpreventiontoken)\s*[:=]\s*\S+/gi,
    replace: `$1: ${REDACTED}`,
  },
  // Generic token/secret/password/apikey key=value
  {
    re: /\b(pass(word)?|secret|api[_-]?key|token|private[_-]?key)\s*[:=]\s*("?)[^\s,;"]+\3/gi,
    replace: `$1: ${REDACTED}`,
  },
  // PEM private key blocks
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: `${REDACTED}-PRIVATE-KEY`,
  },
];

export class Sanitizer {
  // Literal secret values registered at runtime (never persisted).
  private readonly literals = new Set<string>();

  /** Register a literal secret value so it is redacted verbatim anywhere. */
  register(value: string | undefined | null): void {
    if (value && value.length >= 4) this.literals.add(value);
  }

  unregister(value: string): void {
    this.literals.delete(value);
  }

  sanitize(input: unknown): string {
    let s = typeof input === "string" ? input : safeStringify(input);
    // Redact registered literals first (exact matches).
    for (const lit of this.literals) {
      if (lit && s.includes(lit)) {
        s = s.split(lit).join(REDACTED);
      }
    }
    for (const { re, replace } of PATTERNS) {
      s = s.replace(re, replace);
    }
    return s;
  }
}

function safeStringify(input: unknown): string {
  if (input instanceof Error) return `${input.name}: ${input.message}`;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

// A shared default instance for convenience; callers may also make their own.
export const defaultSanitizer = new Sanitizer();
export function sanitize(input: unknown): string {
  return defaultSanitizer.sanitize(input);
}
