import { Logger } from '@nestjs/common';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { request } from 'undici';
import type { AppConfigService } from '../src/config/app-config.service.js';
import { MailService } from '../src/mail/mail.service.js';

// The transport is stubbed, never the network: these tests assert what we PUT
// ON THE WIRE and what we do with each answer, and a real call would be both
// slow and non-deterministic.
vi.mock('undici', () => ({ request: vi.fn() }));

const API_KEY = 're_test_key_do_not_use';
const FROM = 'Tickwise <noreply@example.test>';

/**
 * A config double exposing exactly what `MailService` reads. `mailConfigured`
 * mirrors the real getter (BOTH halves, blanks are absent) so a drift in that
 * rule shows up here rather than only in production.
 */
function configWith(overrides: Partial<Record<'key' | 'from' | 'replyTo', string>> = {}): AppConfigService {
  const present = (raw: string | undefined) => (raw?.trim() ? raw.trim() : undefined);
  const resendApiKey = present(overrides.key);
  const mailFrom = present(overrides.from);
  return {
    resendApiKey,
    mailFrom,
    mailReplyTo: present(overrides.replyTo),
    mailConfigured: Boolean(resendApiKey && mailFrom),
  } as unknown as AppConfigService;
}

/** A stubbed undici response. `dump` stands in for draining the socket. */
function response(statusCode: number) {
  return { statusCode, body: { dump: vi.fn(async () => undefined) } };
}

/** Every line the service logged, at any level. */
let logLines: string[] = [];

beforeEach(() => {
  logLines = [];
  vi.mocked(request).mockReset();
  for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
      logLines.push(`${level}: ${String(message)}`);
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MailService.isConfigured', () => {
  // Half-configured must read as NOT configured. A key with no verified sender
  // cannot send, so the alternative is a runtime 422 on every single email
  // instead of a clean fall back to the console path.
  it('is false with neither RESEND_API_KEY nor MAIL_FROM', () => {
    expect(new MailService(configWith()).isConfigured()).toBe(false);
  });

  it('is false with a key but no MAIL_FROM', () => {
    expect(new MailService(configWith({ key: API_KEY })).isConfigured()).toBe(false);
  });

  it('is false with a MAIL_FROM but no key', () => {
    expect(new MailService(configWith({ from: FROM })).isConfigured()).toBe(false);
  });

  it('is true only when both are set', () => {
    expect(new MailService(configWith({ key: API_KEY, from: FROM })).isConfigured()).toBe(true);
  });

  it('treats a blank env value as absent, not as a configured empty string', () => {
    expect(new MailService(configWith({ key: '   ', from: FROM })).isConfigured()).toBe(false);
  });
});

describe('MailService.send', () => {
  it('POSTs the Resend endpoint with a Bearer key and the from/to/subject/text body', async () => {
    vi.mocked(request).mockResolvedValueOnce(response(200) as never);
    const service = new MailService(configWith({ key: API_KEY, from: FROM }));

    const accepted = await service.send({
      to: 'customer@example.test',
      subject: 'Your Tickwise verification code',
      text: 'code 424242',
    });

    expect(accepted).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    const [url, options] = vi.mocked(request).mock.calls[0] as [string, Record<string, never>];
    expect(url).toBe('https://api.resend.com/emails');
    expect(options.method).toBe('POST');
    const headers = options.headers as unknown as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(options.body as unknown as string)).toEqual({
      from: FROM,
      to: ['customer@example.test'],
      subject: 'Your Tickwise verification code',
      text: 'code 424242',
    });
  });

  it('adds reply_to only when MAIL_REPLY_TO is configured', async () => {
    vi.mocked(request).mockResolvedValueOnce(response(200) as never);
    const service = new MailService(
      configWith({ key: API_KEY, from: FROM, replyTo: 'support@example.test' }),
    );

    await service.send({ to: 'customer@example.test', subject: 's', text: 't' });

    const [, options] = vi.mocked(request).mock.calls[0] as [string, Record<string, never>];
    expect(JSON.parse(options.body as unknown as string).reply_to).toBe('support@example.test');
  });

  it('returns false WITHOUT calling the provider when mail is not configured', async () => {
    const service = new MailService(configWith({ key: API_KEY })); // no MAIL_FROM

    await expect(service.send({ to: 'customer@example.test', subject: 's', text: 't' })).resolves.toBe(
      false,
    );
    expect(request).not.toHaveBeenCalled();
  });

  // FAIL-OPEN: every failure mode is a `false`, never a throw. A mail outage
  // must not be able to fail a signup or a profile update.
  it('returns false on a non-2xx instead of throwing', async () => {
    vi.mocked(request).mockResolvedValueOnce(response(422) as never); // unverified sender
    const service = new MailService(configWith({ key: API_KEY, from: FROM }));

    await expect(service.send({ to: 'customer@example.test', subject: 's', text: 't' })).resolves.toBe(
      false,
    );
    expect(logLines.join('\n')).toContain('customer@example.test');
  });

  // The provider ALREADY says why it refused; we used to throw that away and log
  // a bare status. A live `HTTP 403` then took two rounds of manual curl to
  // become "the yourdomain.com domain is not verified" — which Resend had said
  // in the body all along.
  it("logs the provider's own reason for a rejection, not just the status", async () => {
    vi.mocked(request).mockResolvedValueOnce({
      statusCode: 403,
      body: {
        text: async () =>
          JSON.stringify({
            statusCode: 403,
            message: 'The yourdomain.com domain is not verified. Please, add and verify your domain on https://resend.com/domains',
            name: 'validation_error',
          }),
        dump: vi.fn(async () => undefined),
      },
    } as never);
    const service = new MailService(configWith({ key: API_KEY, from: FROM }));

    await expect(service.send({ to: 'customer@example.test', subject: 's', text: 't' })).resolves.toBe(
      false,
    );
    const logged = logLines.join('\n');
    expect(logged).toContain('HTTP 403');
    expect(logged).toContain('domain is not verified');
  });

  // Reading the failure body must never become a way for the SECRET to escape.
  // It cannot: the code rides in the REQUEST, and a provider error describes
  // configuration. This pins that, including when the provider echoes our
  // payload back at us.
  it('never logs the verification code, even if the provider echoes the body back', async () => {
    const secret = '424242';
    vi.mocked(request).mockResolvedValueOnce({
      statusCode: 422,
      body: {
        text: async () => JSON.stringify({ message: 'Unprocessable', echoed: `your code is ${secret}` }),
        dump: vi.fn(async () => undefined),
      },
    } as never);
    const service = new MailService(configWith({ key: API_KEY, from: FROM }));

    await service.send({ to: 'customer@example.test', subject: 's', text: `code ${secret}` });

    // Only the picked `message` field is logged — never the whole payload.
    expect(logLines.join('\n')).not.toContain(secret);
  });

  it('still reports a rejection when the body cannot be read', async () => {
    vi.mocked(request).mockResolvedValueOnce({
      statusCode: 500,
      body: {
        text: async () => {
          throw new Error('stream already consumed');
        },
        dump: vi.fn(async () => undefined),
      },
    } as never);
    const service = new MailService(configWith({ key: API_KEY, from: FROM }));

    await expect(service.send({ to: 'customer@example.test', subject: 's', text: 't' })).resolves.toBe(
      false,
    );
    expect(logLines.join('\n')).toContain('HTTP 500');
  });

  it('returns false when the transport throws (network error) instead of rejecting', async () => {
    vi.mocked(request).mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND api.resend.com'));
    const service = new MailService(configWith({ key: API_KEY, from: FROM }));

    await expect(service.send({ to: 'customer@example.test', subject: 's', text: 't' })).resolves.toBe(
      false,
    );
  });

  it('returns false on a timeout (AbortError) instead of hanging the caller', async () => {
    const aborted = new Error('The operation was aborted');
    aborted.name = 'AbortError';
    vi.mocked(request).mockRejectedValueOnce(aborted);
    const service = new MailService(configWith({ key: API_KEY, from: FROM }));

    await expect(service.send({ to: 'customer@example.test', subject: 's', text: 't' })).resolves.toBe(
      false,
    );
    expect(logLines.join('\n')).toContain('timed out');
  });

  it('passes an AbortSignal so a hanging provider cannot pin the request', async () => {
    vi.mocked(request).mockResolvedValueOnce(response(200) as never);
    const service = new MailService(configWith({ key: API_KEY, from: FROM }));

    await service.send({ to: 'customer@example.test', subject: 's', text: 't' });

    const [, options] = vi.mocked(request).mock.calls[0] as [string, Record<string, never>];
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  // The message body carries a live credential. NOTHING this service logs may
  // contain it — not on success, not on rejection, not on a transport error.
  it('never logs the message body, on any path', async () => {
    const code = '424242';
    const text = `Here is your Tickwise verification code:\n\n    ${code}\n`;
    const outcomes = [
      () => vi.mocked(request).mockResolvedValueOnce(response(200) as never),
      () => vi.mocked(request).mockResolvedValueOnce(response(500) as never),
      () => vi.mocked(request).mockRejectedValueOnce(new Error('socket hang up')),
    ];

    for (const stub of outcomes) {
      stub();
      const service = new MailService(configWith({ key: API_KEY, from: FROM }));
      await service.send({ to: 'customer@example.test', subject: 'Your code', text });
    }
    // …and the unconfigured path, which logs without touching the provider.
    await new MailService(configWith()).send({ to: 'customer@example.test', subject: 'Your code', text });

    const logged = logLines.join('\n');
    expect(logged).not.toContain(code);
    expect(logged).not.toContain('verification code:');
    // The recipient and the outcome ARE logged — that is the operable signal.
    expect(logged).toContain('customer@example.test');
  });

  it('never logs the API key', async () => {
    vi.mocked(request).mockResolvedValueOnce(response(401) as never);
    const service = new MailService(configWith({ key: API_KEY, from: FROM }));

    await service.send({ to: 'customer@example.test', subject: 's', text: 't' });

    expect(logLines.join('\n')).not.toContain(API_KEY);
  });
});
