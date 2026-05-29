/**
 * Lightweight cron expression parser for scheduled tasks.
 *
 * Supports standard 5-field cron expressions:
 *   +----------- minute (0-59)
 *   | +----------- hour (0-23)
 *   | | +----------- day of month (1-31)
 *   | | | +----------- month (1-12)
 *   | | | | +----------- day of week (0-7, 0 and 7 both = Sunday)
 *   * * * * *
 *
 * Supported syntax:
 *   - Asterisk (*): any value
 *   - Comma (1,3,5): list of values
 *   - Hyphen (1-5): range of values
 *   - Slash (ASTERISK/5): step values â€?e.g. every 5 minutes
 *   - Combined: 1-30/5 = from 1 to 30, step 5
 *
 * No external dependencies required.
 */

// -- Internal types -----------------------------------------------------------

interface CronField {
  /** Sorted array of matching values */
  values: readonly number[];
}

interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dom: CronField;    // day of month
  month: CronField;
  dow: CronField;    // day of week
}

const MONTH_DAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// -- Parsing ------------------------------------------------------------------

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return MONTH_DAYS[month];
}

/**
 * Expand a single field expression into an array of matching values.
 */
function expandField(
  expr: string,
  min: number,
  max: number,
): number[] {
  const result: number[] = [];

  for (const part of expr.split(',')) {
    const stepMatch = part.match(/^(\*|\d+-\d+)\/(\d+)$/);
    if (stepMatch) {
      const range = stepMatch[1];
      const step = parseInt(stepMatch[2], 10);
      let rMin = min;
      let rMax = max;
      if (range !== '*') {
        const [rs, re] = range.split('-').map(Number);
        rMin = rs;
        rMax = re;
      }
      for (let v = rMin; v <= rMax; v += step) {
        if (v >= min && v <= max) result.push(v);
      }
      continue;
    }

    if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number);
      for (let v = start; v <= end; v++) {
        if (v >= min && v <= max) result.push(v);
      }
      continue;
    }

    if (part === '*') {
      for (let v = min; v <= max; v++) result.push(v);
      continue;
    }

    const val = parseInt(part, 10);
    if (isNaN(val) || val < min || val > max) {
      throw new Error(`Invalid cron field value "${part}" (range ${min}-${max})`);
    }
    result.push(val);
  }

  return Array.from(new Set(result)).sort((a, b) => a - b);
}

/**
 * Parse a 5-field cron expression into a structured object.
 */
function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Invalid cron expression "${expr}": expected 5 fields, got ${fields.length}`);
  }

  const [minute, hour, dom, month, dow] = fields;

  return {
    minute:  { values: expandField(minute,  0, 59) },
    hour:    { values: expandField(hour,    0, 23) },
    dom:     { values: expandField(dom,     1, 31) },
    month:   { values: expandField(month,   1, 12) },
    dow:     { values: expandField(dow,     0,  7) },
  };
}

// -- Next occurrence computation ----------------------------------------------

function matchesField(field: CronField, value: number): boolean {
  return field.values.includes(value);
}

/**
 * Adjust day-of-week 7 (some cron dialects use 7 for Sunday) to 0.
 */
function normalizeDow(dow: number): number {
  return dow === 7 ? 0 : dow;
}

/**
 * Find the next cron occurrence after the given date.
 */
function findNext(parsed: ParsedCron, after: Date): Date | null {
  // Start from one minute after `after`
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);

  const MAX_ITERATIONS = 366 * 24 * 60; // ~1 year of minute-level search
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const m  = d.getMinutes();
    const h  = d.getHours();
    const dd = d.getDate();
    const mo = d.getMonth() + 1;  // 1-12
    const dw = normalizeDow(d.getDay()); // 0-6

    // Check month
    if (!matchesField(parsed.month, mo)) {
      // Skip to next month
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }

    // Check day of month and day of week (OR logic per cron standard)
    const domMatch = matchesField(parsed.dom, dd);
    const dowMatch = matchesField(parsed.dow, dw);
    // If both dom and dow are restricted (not just *), use OR
    const domRestricted = parsed.dom.values.length !== 31;
    const dowRestricted = parsed.dow.values.length !== 8;

    if (domRestricted && dowRestricted) {
      if (!domMatch && !dowMatch) {
        d.setDate(dd + 1);
        d.setHours(0, 0, 0, 0);
        continue;
      }
    } else {
      if (!domMatch || !dowMatch) {
        d.setDate(dd + 1);
        d.setHours(0, 0, 0, 0);
        continue;
      }
    }

    // Check hour
    if (!matchesField(parsed.hour, h)) {
      d.setHours(h + 1, 0, 0, 0);
      continue;
    }

    // Check minute
    if (!matchesField(parsed.minute, m)) {
      d.setMinutes(m + 1, 0, 0);
      continue;
    }

    return d;
  }

  return null; // No match found within 1 year
}

// -- Public API ----------------------------------------------------------------

/**
 * Get the next run date for a cron expression.
 * @param expression - 5-field cron expression
 * @param after - Base date to search from (defaults to now)
 * @returns Next execution Date, or null if none found
 */
export function getNextCronRun(expression: string, after: Date = new Date()): Date | null {
  try {
    const parsed = parseCron(expression);
    return findNext(parsed, after);
  } catch {
    return null;
  }
}

/**
 * Validate a cron expression.
 * @returns null if valid, error message string if invalid
 */
export function validateCronExpression(expression: string): string | null {
  try {
    parseCron(expression);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * Get a human-readable description of a cron expression.
 */
export function describeCronExpression(expression: string): string | null {
  try {
    const parsed = parseCron(expression);
    const parts: string[] = [];

    if (parsed.minute.values.length === 60) {
      parts.push('every minute');
    } else if (parsed.minute.values.length === 1) {
      parts.push(`at minute ${parsed.minute.values[0]}`);
    } else {
      parts.push(`at minutes ${parsed.minute.values.join(',')}`);
    }

    if (parsed.hour.values.length < 24) {
      if (parsed.hour.values.length === 1) {
        parts.push(parsed.hour.values[0] === 0 ? 'past midnight' : `at hour ${parsed.hour.values[0]}`);
      } else {
        parts.push(`at hours ${parsed.hour.values.join(',')}`);
      }
    }

    if (parsed.dom.values.length < 31) {
      parts.push(`on day(s) ${parsed.dom.values.join(',')}`);
    }

    if (parsed.month.values.length < 12) {
      const monthNames = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      parts.push(`in ${parsed.month.values.map(m => monthNames[m]).join(',')}`);
    }

    if (parsed.dow.values.length < 8) {
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      parts.push(`on ${parsed.dow.values.map(d => dayNames[d]).join(',')}`);
    }

    return parts.join(', ') || 'every minute';
  } catch {
    return null;
  }
}

/**
 * CronParser - Object-oriented wrapper around the pure cron functions.
 */
export class CronParser {
  /**
   * Parse a cron expression and return the next run date.
   * @param expression - 5-field cron expression
   * @param _timezone - Timezone (reserved for future use; currently UTC-based)
   * @param after - Base date to search from (defaults to now)
   * @returns Next execution Date, or undefined if none found
   */
  getNextDate(expression: string, _timezone?: string, after?: Date): Date | undefined {
    const result = getNextCronRun(expression, after ?? new Date());
    return result ?? undefined;
  }

  /**
   * Validate a cron expression.
   * @returns null if valid, error message string if invalid
   */
  validate(expression: string): string | null {
    return validateCronExpression(expression);
  }

  /**
   * Get a human-readable description of a cron expression.
   */
  describe(expression: string): string | null {
    return describeCronExpression(expression);
  }
}

/**
 * Parse a cron expression and return the next run date.
 * Convenience alias for getNextCronRun().
 */
export function parseCronExpression(expr: string, after?: Date): Date | null {
  return getNextCronRun(expr, after ?? new Date());
}
