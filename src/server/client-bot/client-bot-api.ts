import "server-only";

const TELEGRAM_API = "https://api.telegram.org";
const REQUEST_TIMEOUT_MS = 10_000;

/** The one method the customer bot needs from Telegram. Tests replace it with a fake. */
export interface BotApi {
  call(method: string, body: Record<string, unknown>): Promise<unknown>;
}

export class TelegramBotApi implements BotApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async call(method: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await this.fetchImpl(`${TELEGRAM_API}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: unknown;
      description?: string;
    };
    if (!res.ok || !json.ok) {
      const detail = json.description ? `: ${json.description}` : "";
      throw new Error(`Telegram ${method} failed (HTTP ${res.status})${detail}`);
    }
    return json.result;
  }
}
