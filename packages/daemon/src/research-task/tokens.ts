/**
 * Server-side Bearer-token → actor ACL for the ResearchTask MCP (plan §7: shared
 * MCP tokens do not prove identity — each Hermes profile gets its own scoped
 * token). Tokens are secrets: persisted under <dataDir>/config with mode 0600,
 * never written to logs, never returned by any tool or route.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Actor } from './store.ts';

export type ActorGrant =
  | { role: 'operator'; subject: string; token: string }
  | { role: 'worker'; subject: string; profile: string; token: string };

interface RegistryFile {
  actors: ActorGrant[];
}

export class ResearchTokenRegistry {
  readonly path: string;
  private grants: ActorGrant[] = [];

  constructor(path: string) {
    this.path = path;
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as RegistryFile;
        this.grants = Array.isArray(raw.actors) ? raw.actors : [];
      } catch {
        this.grants = [];
      }
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify({ actors: this.grants }, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  /**
   * Returns the grant for role+subject, minting a token only when absent.
   * If an existing worker grant carries a different profile (e.g. the file was
   * provisioned before the subject↔profile contract settled), the profile is
   * healed in place — the token is kept so already-distributed credentials
   * stay valid — and the correction is logged. A registry row is never deleted
   * here; revocation stays an explicit `revoke()`.
   */
  ensure(grant: { role: 'operator'; subject: string } | { role: 'worker'; subject: string; profile: string }): ActorGrant {
    const found = this.grants.find((g) => g.role === grant.role && g.subject === grant.subject);
    if (found) {
      if (grant.role === 'worker' && found.role === 'worker' && found.profile !== grant.profile) {
        console.warn(`[research-mcp] actor ${grant.subject}: profile '${found.profile}' → '${grant.profile}' (token kept)`);
        found.profile = grant.profile;
        this.save();
      }
      return found;
    }
    const created = { ...grant, token: randomBytes(24).toString('hex') } as ActorGrant;
    this.grants.push(created);
    this.save();
    return created;
  }

  revoke(role: Actor['role'], subject: string): boolean {
    const before = this.grants.length;
    this.grants = this.grants.filter((g) => !(g.role === role && g.subject === subject));
    if (this.grants.length !== before) this.save();
    return this.grants.length !== before;
  }

  /** Resolve a Bearer token to an actor; null when the token is unknown. */
  resolve(token: string): Actor | null {
    const grant = this.grants.find((g) => g.token === token);
    if (!grant) return null;
    return grant.role === 'worker'
      ? { role: 'worker', subject: grant.subject, profile: grant.profile }
      : { role: 'operator', subject: grant.subject };
  }

  /** Safe listing for bootstrap tooling — token values are masked. */
  list(): { role: string; subject: string; profile?: string; tokenHint: string }[] {
    return this.grants.map((g) => ({
      role: g.role,
      subject: g.subject,
      ...(g.role === 'worker' ? { profile: g.profile } : {}),
      tokenHint: `${g.token.slice(0, 6)}…`,
    }));
  }

  /** Full token for a known subject — bootstrap/config-file generation only. */
  tokenFor(role: Actor['role'], subject: string): string | null {
    return this.grants.find((g) => g.role === role && g.subject === subject)?.token ?? null;
  }
}
