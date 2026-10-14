import { Inject, Injectable, Logger } from '@nestjs/common';
import { request } from 'undici';
import { AppConfigService } from '../config/app-config.service.js';

/**
 * Resend's transactional send endpoint. Deliberately spoken to as plain REST
 * (`undici.request` + a Bearer key + a JSON body) rather than through the
 * `resend` SDK: the whole surface we need is one POST, and this backend already
 * depends on undici for every other outbound call.
 */
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Short on purpose. A verification mail is sent INLINE on signup / resend /
 * profile-edit, so this timeout is the worst case a customer waits for a
 * provider that has stopped answering — and the fallback below is a log line,
 * not an error, so waiting longer buys nothing.
 */
const SEND_TIMEOUT_MS = 5000;

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain text. NEVER logged — verification codes travel in here. */
  text: string;
}

/**
 * The one outbound mail path.
 *
 * TWO RULES, both load-bearing:
 *
 *  1. FAIL-OPEN. `send` never throws and never rejects — a mail outage must not
 *     fail a signup or a profile update. Every failure mode (not configured,
 *     non-2xx, socket error, timeout) returns `false` and logs; the caller
 *     decides what to do without one, which today means falling back to the
 *     console path `CustomerAuthService` used before a mailer existed.
 *
 *  2. NEVER LOG THE BODY. `text` carries the verification code, so nothing here
 *     logs the message, the subject or the request payload — only the recipient
 *     and the outcome. Same reasoning as `oauthJson`, which logs neither the
 *     client secret it posts nor the token it receives.
 *
 * "Configured" is `AppConfigService.mailConfigured` and nothing else: BOTH
 * `RESEND_API_KEY` and `MAIL_FROM` present. A key with no verified sender cannot
 * send, so half-configured must read as NOT configured (a console fallback) and
 * not as a runtime failure on every single email.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(@Inject(AppConfigService) private readonly config: AppConfigService) {}

  /** Whether a real send can be attempted at all. Single source of truth. */
  isConfigured(): boolean {
    return this.config.mailConfigured;
  }

  /**
   * Hand one message to Resend.
   *
   * @returns `true` only when the provider ACCEPTED it (2xx). Acceptance is not
   *   delivery — a bounce happens later and out of band — but it is the strongest
   *   signal available synchronously, and it is exactly the question the caller
   *   needs answered: "may I stop worrying about getting this code to them?"
   */
  async send(msg: MailMessage): Promise<boolean> {
    const apiKey = this.config.resendApiKey;
    const from = this.config.mailFrom;
    if (!apiKey || !from) {
      // Not an error: an operator who has configured no mailer gets the console
      // fallback, which is the documented unconfigured behaviour.
      this.logger.warn(`No mail transport configured — nothing sent to ${msg.to}`);
      return false;
    }

    const replyTo = this.config.mailReplyTo;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const response = await request(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          from,
          // Resend accepts a string or an array; the array form is unambiguous.
          to: [msg.to],
          subject: msg.subject,
          text: msg.text,
          ...(replyTo ? { reply_to: replyTo } : {}),
        }),
        signal: controller.signal,
        bodyTimeout: SEND_TIMEOUT_MS,
        headersTimeout: SEND_TIMEOUT_MS,
      });

      const statusCode = response.statusCode;

      if (statusCode >= 200 && statusCode < 300) {
        // Nothing useful in a success body beyond a message id, and draining
        // keeps undici from pinning the connection.
        await drain(response);
        this.logger.log(`Mail accepted by the provider for ${msg.to}`);
        return true;
      }

      // READ the failure body. It was previously discarded on the theory that
      // "the status is all the caller can act on" — which is true for the
      // CALLER and false for the OPERATOR. A bare `HTTP 403` cost two rounds of
      // manual curl to become "the yourdomain.com domain is not verified";
      // the provider had said exactly that and we threw it away.
      //
      // Safe to log: the verification code travels in the REQUEST. A provider's
      // error reply is diagnostics about configuration — key, sender, domain,
      // quota — and never contains the message text we sent.
      const detail = await readErrorDetail(response);
      this.logger.warn(
        `Mail provider rejected the message for ${msg.to} (HTTP ${statusCode})${detail ? `: ${detail}` : ''}`,
      );
      return false;
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Mail send ${aborted ? 'timed out' : 'failed'} for ${msg.to}: ${reason}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Consume the response body so the socket is released. Swallows everything: a
 * body already consumed, or a stubbed transport in a test, must not turn an
 * accepted send into a reported failure (the status has already been read).
 */
async function drain(response: { body?: { dump?: () => Promise<unknown> } }): Promise<void> {
  try {
    await response.body?.dump?.();
  } catch {
    /* nothing to drain */
  }
}

/** Longest provider error we will put in a log line. */
const MAX_ERROR_DETAIL = 300;

/**
 * The provider's own explanation for a rejected send, for the log line.
 *
 * Reads the body — which also releases the socket, so a caller that uses this
 * must NOT also `drain`. Total: a body that is missing, already consumed,
 * non-JSON or stubbed in a test yields `null` rather than turning a reported
 * failure into a thrown one. Truncated, because an operator needs the first
 * sentence and a log is not a place for an unbounded remote string.
 */
async function readErrorDetail(response: {
  body?: { text?: () => Promise<string>; dump?: () => Promise<unknown> };
}): Promise<string | null> {
  try {
    const raw = await response.body?.text?.();
    if (!raw) return null;
    let message = raw;
    try {
      const parsed = JSON.parse(raw) as { message?: unknown; error?: unknown };
      const picked = parsed.message ?? parsed.error;
      if (typeof picked === 'string' && picked.length > 0) message = picked;
    } catch {
      /* not JSON — fall back to the raw text */
    }
    const flat = message.replace(/\s+/g, ' ').trim();
    return flat.length > MAX_ERROR_DETAIL ? `${flat.slice(0, MAX_ERROR_DETAIL)}…` : flat;
  } catch {
    await drain(response);
    return null;
  }
}
