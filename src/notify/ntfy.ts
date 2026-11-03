import type { Secrets } from "../config.ts";

export interface Alert {
  title: string;
  message: string;
  /** 1 (min) – 5 (urgent). */
  priority: number;
  tags: string[];
  click?: string;
}

export interface Notifier {
  /** Resolves true when delivered (or printed); false when delivery failed and should be retried. */
  send(alert: Alert): Promise<boolean>;
  readonly description: string;
}

/** Publishes with ntfy's JSON API, which avoids header-encoding problems with non-ASCII titles. */
export class NtfyNotifier implements Notifier {
  readonly #secrets: Secrets & { ntfyTopic: string };
  readonly #fetch: typeof fetch;
  readonly #log: (line: string) => void;

  constructor(secrets: Secrets & { ntfyTopic: string }, fetchImpl: typeof fetch = fetch, log = console.error) {
    this.#secrets = secrets;
    this.#fetch = fetchImpl;
    this.#log = log;
  }

  get description(): string {
    // The topic works like a password on public ntfy.sh; don't print it.
    return `ntfy (${this.#secrets.ntfyServer}, topic ${"*".repeat(Math.min(8, this.#secrets.ntfyTopic.length))})`;
  }

  async send(alert: Alert): Promise<boolean> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.#secrets.ntfyToken) headers.Authorization = `Bearer ${this.#secrets.ntfyToken}`;
    try {
      const res = await this.#fetch(`${this.#secrets.ntfyServer}/`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          topic: this.#secrets.ntfyTopic,
          title: alert.title,
          message: alert.message,
          priority: alert.priority,
          tags: alert.tags,
          ...(alert.click ? { click: alert.click, actions: [{ action: "view", label: "Open listing", url: alert.click }] } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        this.#log(`ntfy rejected the alert: HTTP ${res.status}`);
        return false;
      }
      return true;
    } catch (e) {
      this.#log(`ntfy delivery failed: ${(e as Error).message}`);
      return false;
    }
  }
}

export class ConsoleNotifier implements Notifier {
  readonly description = "console only (set NTFY_TOPIC for phone alerts)";
  readonly #log: (line: string) => void;
  constructor(log = console.log) {
    this.#log = log;
  }
  async send(alert: Alert): Promise<boolean> {
    this.#log(`\n🔔 [p${alert.priority}] ${alert.title}\n${alert.message}${alert.click ? `\n${alert.click}` : ""}\n`);
    return true;
  }
}

export function notifierFor(secrets: Secrets): Notifier {
  return secrets.ntfyTopic ? new NtfyNotifier({ ...secrets, ntfyTopic: secrets.ntfyTopic }) : new ConsoleNotifier();
}
