export type OscNotificationProtocol = 'osc9' | 'osc777' | 'osc99';

export type OscNotification = {
  title: string;
  body: string;
  protocol: OscNotificationProtocol;
};

export const DEFAULT_OSC_NOTIFICATION_TITLE = 'Netcatty';
export const OSC_NOTIFICATION_TITLE_MAX = 120;
export const OSC_NOTIFICATION_BODY_MAX = 500;

const CONEMU_OSC9_COMMAND = /^\d+(?:;|$)/;
const OSC_NOTIFICATION_CARRY_MAX = 8192;
const OSC99_PENDING_TTL_MS = 10_000;
const OSC99_PENDING_MAX = 16;

const DEFAULT_LIMIT_WINDOW_MS = 10_000;
const DEFAULT_LIMIT_MAX = 4;
const DEFAULT_LIMIT_MIN_GAP_MS = 400;

const isForbiddenOscNotificationChar = (code: number): boolean => (
  code <= 8
  || code === 0x0b
  || code === 0x0c
  || (code >= 0x0e && code <= 0x1f)
  || code === 0x7f
);

export function sanitizeOscNotificationText(value: string, max: number): string {
  if (typeof value !== 'string' || max <= 0) return '';
  let cleaned = '';
  for (const char of value) {
    if (!isForbiddenOscNotificationChar(char.charCodeAt(0))) cleaned += char;
  }
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function resolveOscNotificationPresentation(
  notification: OscNotification,
  fallbackTitle = DEFAULT_OSC_NOTIFICATION_TITLE,
): { title: string; body: string } {
  const fallback = sanitizeOscNotificationText(fallbackTitle, OSC_NOTIFICATION_TITLE_MAX)
    || DEFAULT_OSC_NOTIFICATION_TITLE;
  const title = sanitizeOscNotificationText(notification.title, OSC_NOTIFICATION_TITLE_MAX);
  const body = sanitizeOscNotificationText(notification.body, OSC_NOTIFICATION_BODY_MAX);
  if (title && body) return { title, body };
  if (body) return { title: fallback, body };
  if (title) return { title: fallback, body: title };
  return { title: fallback, body: '' };
}

export function shouldShowOscDesktopNotification(
  mode: 'off' | 'unfocused' | 'always' | undefined,
  context: { windowFocused: boolean; sessionFocused: boolean },
): boolean {
  if (mode === 'off') return false;
  if (mode === 'unfocused') return !context.windowFocused || !context.sessionFocused;
  return true;
}

export function parseOsc9Payload(data: string): OscNotification | null {
  if (typeof data !== 'string') return null;
  const payload = data.trim();
  if (!payload) return null;
  // ConEmu/Windows Terminal also use OSC 9;n (especially 9;4 progress).
  // Those must not become desktop notifications.
  if (CONEMU_OSC9_COMMAND.test(payload)) return null;
  return {
    title: '',
    body: payload,
    protocol: 'osc9',
  };
}

export function parseOsc777Payload(data: string): OscNotification | null {
  if (typeof data !== 'string') return null;
  const match = data.match(/^notify;(.*)$/i);
  if (!match) return null;
  const rest = match[1] ?? '';
  const separator = rest.indexOf(';');
  if (separator < 0) {
    const body = rest.trim();
    if (!body) return null;
    return { title: '', body, protocol: 'osc777' };
  }
  const title = rest.slice(0, separator).trim();
  const body = rest.slice(separator + 1).trim();
  if (!title && !body) return null;
  return { title, body, protocol: 'osc777' };
}

type Osc99Pending = {
  title: string;
  body: string;
  updatedAt: number;
};

const decodeOsc99Payload = (payload: string, encoded: boolean): string => {
  if (!encoded) return payload;
  try {
    const binary = atob(payload);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
};

export class Osc99Assembler {
  private readonly pending = new Map<string, Osc99Pending>();

  consume(data: string, now = Date.now()): OscNotification | null {
    if (typeof data !== 'string') return null;
    this.prune(now);

    const separator = data.indexOf(';');
    const metadata = separator < 0 ? '' : data.slice(0, separator);
    const rawPayload = separator < 0 ? data : data.slice(separator + 1);
    const fields = parseOsc99Metadata(metadata);
    if (fields.close) {
      if (fields.id) this.pending.delete(fields.id);
      return null;
    }

    const payload = decodeOsc99Payload(rawPayload, fields.encoded);
    const current = this.pending.get(fields.id) ?? { title: '', body: '', updatedAt: now };
    if (fields.part === 'body') current.body += payload;
    else current.title += payload;
    current.updatedAt = now;

    if (!fields.done) {
      this.pending.set(fields.id, current);
      this.evictOldest();
      return null;
    }

    this.pending.delete(fields.id);
    if (!current.title.trim() && !current.body.trim()) return null;
    return {
      title: current.title,
      body: current.body,
      protocol: 'osc99',
    };
  }

  private prune(now: number): void {
    for (const [id, entry] of this.pending) {
      if (now - entry.updatedAt > OSC99_PENDING_TTL_MS) this.pending.delete(id);
    }
  }

  private evictOldest(): void {
    while (this.pending.size > OSC99_PENDING_MAX) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) return;
      this.pending.delete(oldest);
    }
  }
}

function parseOsc99Metadata(metadata: string): {
  id: string;
  part: 'title' | 'body';
  done: boolean;
  encoded: boolean;
  close: boolean;
} {
  const fields = {
    id: '',
    part: 'title' as 'title' | 'body',
    done: true,
    encoded: false,
    close: false,
  };
  if (!metadata.trim()) return fields;

  for (const token of metadata.split(':')) {
    const eq = token.indexOf('=');
    if (eq <= 0) continue;
    const key = token.slice(0, eq).trim();
    const value = token.slice(eq + 1).trim();
    if (key === 'i') fields.id = value;
    else if (key === 'p' && (value === 'title' || value === 'body')) fields.part = value;
    else if (key === 'd') fields.done = value !== '0';
    else if (key === 'e') fields.encoded = value === '1';
    else if ((key === 'p' || key === 'a') && value === 'close') fields.close = true;
  }
  return fields;
}

type OscScanResult =
  | { incomplete: true }
  | { incomplete: false; notification: boolean; aborted?: boolean; id: number; payload: string; end: number };

const isNotificationOscId = (id: number): boolean => id === 9 || id === 777 || id === 99;

const readOscAt = (input: string, start: number): OscScanResult => {
  if (input[start] !== '\x1b') return { incomplete: false, notification: false, id: -1, payload: '', end: start + 1 };
  if (start + 1 >= input.length) return { incomplete: true };
  if (input[start + 1] !== ']') {
    return { incomplete: false, notification: false, id: -1, payload: '', end: start + 1 };
  }

  let index = start + 2;
  if (index >= input.length) return { incomplete: true };

  let id = 0;
  let sawDigit = false;
  while (index < input.length) {
    const code = input.charCodeAt(index);
    if (code >= 48 && code <= 57) {
      sawDigit = true;
      id = id * 10 + (code - 48);
      index += 1;
      continue;
    }
    break;
  }
  if (!sawDigit) {
    return { incomplete: index >= input.length, notification: false, id: -1, payload: '', end: index };
  }
  if (index >= input.length) return { incomplete: true };

  if (input[index] === ';') index += 1;

  const payloadStart = index;
  while (index < input.length) {
    if (input[index] === '\x07') {
      return {
        incomplete: false,
        notification: isNotificationOscId(id),
        id,
        payload: input.slice(payloadStart, index),
        end: index + 1,
      };
    }
    if (input[index] === '\x18' || input[index] === '\x1a') {
      return {
        incomplete: false,
        notification: false,
        aborted: isNotificationOscId(id),
        id,
        payload: '',
        end: index + 1,
      };
    }
    if (input[index] === '\x1b') {
      if (index + 1 >= input.length) {
        return isNotificationOscId(id) ? { incomplete: true } : {
          incomplete: false,
          notification: false,
          id,
          payload: '',
          end: index,
        };
      }
      if (input[index + 1] === '\\') {
        return {
          incomplete: false,
          notification: isNotificationOscId(id),
          id,
          payload: input.slice(payloadStart, index),
          end: index + 2,
        };
      }
      // xterm aborts an OSC at a non-ST ESC and then processes that ESC.
      return { incomplete: false, notification: false, aborted: isNotificationOscId(id), id, payload: '', end: index };
    }
    index += 1;
  }

  return isNotificationOscId(id) ? { incomplete: true } : {
    incomplete: false,
    notification: false,
    id,
    payload: '',
    end: input.length,
  };
};

export class OscNotificationStreamScanner {
  private carry = '';
  private readonly assembler = new Osc99Assembler();

  consume(chunk: string): { notifications: OscNotification[]; remainder: string } {
    const input = this.carry + (typeof chunk === 'string' ? chunk : '');
    this.carry = '';
    const notifications: OscNotification[] = [];
    let remainder = '';
    let index = 0;

    while (index < input.length) {
      const esc = input.indexOf('\x1b', index);
      if (esc < 0) {
        remainder += input.slice(index);
        break;
      }
      remainder += input.slice(index, esc);
      const scanned = readOscAt(input, esc);
      if (scanned.incomplete) {
        const leftover = input.slice(esc);
        if (leftover.length > OSC_NOTIFICATION_CARRY_MAX) {
          remainder += leftover;
        } else {
          this.carry = leftover;
        }
        break;
      }
      if (scanned.notification) {
        const notification = scanned.id === 9
          ? parseOsc9Payload(scanned.payload)
          : scanned.id === 777
            ? parseOsc777Payload(scanned.payload)
            : this.assembler.consume(scanned.payload);
        if (notification) notifications.push(notification);
      } else if (!scanned.aborted) {
        remainder += input.slice(esc, scanned.end);
      }
      index = scanned.end;
    }

    return { notifications, remainder };
  }

  flush(): string {
    const leftover = this.carry;
    this.carry = '';
    return leftover;
  }
}

export class OscNotificationLimiter {
  private readonly stamps = new Map<string, number[]>();

  constructor(
    private readonly windowMs = DEFAULT_LIMIT_WINDOW_MS,
    private readonly max = DEFAULT_LIMIT_MAX,
    private readonly minGapMs = DEFAULT_LIMIT_MIN_GAP_MS,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const recent = (this.stamps.get(key) ?? []).filter((stamp) => now - stamp < this.windowMs);
    const last = recent[recent.length - 1];
    if (last !== undefined && now - last < this.minGapMs) {
      this.stamps.set(key, recent);
      return false;
    }
    if (recent.length >= this.max) {
      this.stamps.set(key, recent);
      return false;
    }
    recent.push(now);
    this.stamps.set(key, recent);
    return true;
  }
}
