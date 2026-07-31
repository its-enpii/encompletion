/**
 * Absolute date + clock for the model so relative phrases (yesterday,
 * last week, kemarin, minggu lalu, "sekarang") resolve before tool calls.
 *
 * TZ: explicit arg, else APP_TIMEZONE, process TZ, else UTC.
 * Date is YYYY-MM-DD; time is 24h HH:mm in that zone.
 */

export function buildTodayContextBlock(now = new Date(), timeZone) {
  const tz = timeZone
    || process.env.APP_TIMEZONE
    || process.env.TZ
    || 'UTC';
  let iso;
  let weekday;
  let clock;
  try {
    iso = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now); // en-CA → YYYY-MM-DD
    weekday = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'long',
    }).format(now);
    clock = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(now); // HH:mm
  } catch {
    iso = now.toISOString().slice(0, 10);
    weekday = 'unknown';
    clock = now.toISOString().slice(11, 16);
  }
  return [
    '<system>',
    `Current date and time: ${iso} ${clock} (${weekday}, timezone ${tz}).`,
    'When the user says relative dates (yesterday, day before yesterday, last week, last month, kemarin, kemarin lusa, minggu lalu, bulan lalu, etc.), convert them to absolute YYYY-MM-DD yourself before calling any tool.',
    'Tool parameters that are dates must always be YYYY-MM-DD — never relative phrases. Use the clock above for "sekarang" / now / this morning.',
    '</system>',
  ].join('\n');
}

export default { buildTodayContextBlock };
