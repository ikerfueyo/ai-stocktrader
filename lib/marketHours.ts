// U.S. equity market hours (NYSE/Nasdaq regular session, plus the 4:00 a.m. pre-market and the after-hours session to 8:00 p.m.),
// shared by the server (order eligibility, buy-ins) and the pages (the market status badge). All exchange times are Eastern;
// dates are "YYYY-MM-DD" in Eastern time.

export const MARKET_TIME_ZONE = "America/New_York";

// NYSE holidays and 1:00 p.m. early closes, from NYSE Group's 2026-2028 calendar (announced December 23, 2025).
// Outside these years only weekends are known, so extend the lists when NYSE publishes the next calendar.
const CALENDAR_YEARS = [2026, 2027, 2028];
const HOLIDAYS = new Set([
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
    "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
    "2028-01-17", "2028-02-21", "2028-04-14", "2028-05-29", "2028-06-19", "2028-07-04", "2028-09-04", "2028-11-23", "2028-12-25"
]);
const EARLY_CLOSES = new Set(["2026-11-27", "2026-12-24", "2027-11-26", "2028-07-03", "2028-11-24"]);

const OPEN_TIME = "09:30";
const CLOSE_TIME = "16:00";
const EARLY_CLOSE_TIME = "13:00";
const PRE_MARKET_TIME = "04:00";
const AFTER_HOURS_END_TIME = "20:00";
// After an early close, the after-hours session ends at 5:00 p.m.
const EARLY_AFTER_HOURS_END_TIME = "17:00";

// A trading day as Alpaca's calendar gives it (GET /v2/calendar): regular open and close, the extended session's start and end,
// and the day its trades settle (T+1)
export interface CalendarDay {
    date: string;
    open: string;
    close: string;
    sessionOpen: string;
    sessionClose: string;
    settlementDate: string;
}

// Alpaca's calendar, registered on the server (registerCalendar) for the dates it covers. It takes precedence over the lists
// above, so unscheduled closures and future years are known; the pages use the lists. Kept on globalThis since Next.js can load
// this module more than once.
const registry = globalThis as typeof globalThis & { __marketCalendar?: { days: Map<string, CalendarDay>; from: string; to: string } };

export const registerCalendar = (calendar: { days: CalendarDay[]; from: string; to: string } | null) => {
    registry.__marketCalendar = calendar ? { days: new Map(calendar.days.map(day => [day.date, day])), from: calendar.from, to: calendar.to } : undefined;
};

const registeredDay = (dateKey: string): CalendarDay | null | undefined => {
    const calendar = registry.__marketCalendar;
    if (!calendar || dateKey < calendar.from || dateKey > calendar.to) return undefined;
    return calendar.days.get(dateKey) ?? null;
};

export interface MarketStatus {
    open: boolean;
    // pre-market and after-hours are on trading days only; closed covers weekends, holidays and overnight
    session: "pre-market" | "regular" | "after-hours" | "closed";
    // Whether extended-hours orders can trade now (the pre-market or after-hours session), and when that session ends (ISO)
    extendedOpen: boolean;
    extendedClose: string | null;
    // ISO timestamps: the next regular-session open (after now), and the current session's close while open
    nextOpen: string;
    nextClose: string | null;
    earlyClose: boolean;
    // False outside the years whose holidays are listed (or Alpaca's registered calendar covers), when only weekends are known
    calendarKnown: boolean;
}

const easternFormat = new Intl.DateTimeFormat("en-US", {
    timeZone: MARKET_TIME_ZONE, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
});

// The Eastern calendar date ("YYYY-MM-DD") and time of an instant
export const easternParts = (date: Date) => {
    const parts = Object.fromEntries(easternFormat.formatToParts(date).map(({ type, value }) => [type, value]));
    return { dateKey: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, second: Number(parts.second) };
};

// Eastern's offset from UTC at an instant, in minutes (-240 in summer, -300 in winter)
const easternOffset = (date: Date): number => {
    const { dateKey, time, second } = easternParts(date);
    const asUtc = Date.parse(`${dateKey}T${time}:${String(second).padStart(2, "0")}Z`);
    return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
};

// The instant of an Eastern wall-clock time, such as easternTime("2026-03-09", "09:30"). Checking the offset twice handles
// times near a daylight-saving switch.
export const easternTime = (dateKey: string, time: string): Date => {
    const wallClock = Date.parse(`${dateKey}T${time}:00Z`);
    let instant = wallClock - easternOffset(new Date(wallClock)) * 60000;
    instant = wallClock - easternOffset(new Date(instant)) * 60000;
    return new Date(instant);
};

// Parses an Eastern "YYYY-MM-DD HH:MM:SS(.sss)" timestamp, the format of Alpha Vantage's realtime quotes
export const parseEasternTimestamp = (timestamp: string): Date => {
    const [dateKey, clock = "00:00:00"] = timestamp.trim().split(" ");
    const start = easternTime(dateKey, clock.slice(0, 5));
    return new Date(start.getTime() + parseFloat(clock.slice(6) || "0") * 1000);
};

export const addDays = (dateKey: string, days: number): string => new Date(Date.parse(`${dateKey}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

export const isTradingDay = (dateKey: string): boolean => {
    const registered = registeredDay(dateKey);
    if (registered !== undefined) return registered !== null;
    const weekday = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
    return weekday !== 0 && weekday !== 6 && !HOLIDAYS.has(dateKey);
};

export interface Session {
    open: Date;
    close: Date;
    earlyClose: boolean;
    // The extended session around it: pre-market from 4:00 a.m., after-hours until 8:00 p.m. (5:00 p.m. after an early close)
    extendedOpen: Date;
    extendedClose: Date;
}

// "0400" or "04:00" as "04:00"
const clockTime = (time: string) => time.includes(":") ? time : `${time.slice(0, 2)}:${time.slice(2, 4)}`;

// The regular and extended sessions of a trading day, or null on weekends and holidays
export const sessionOn = (dateKey: string): Session | null => {
    if (!isTradingDay(dateKey)) return null;
    const registered = registeredDay(dateKey);
    if (registered) {
        const close = clockTime(registered.close);
        return {
            open: easternTime(dateKey, clockTime(registered.open)), close: easternTime(dateKey, close), earlyClose: close < CLOSE_TIME,
            extendedOpen: easternTime(dateKey, clockTime(registered.sessionOpen)), extendedClose: easternTime(dateKey, clockTime(registered.sessionClose))
        };
    }
    const earlyClose = EARLY_CLOSES.has(dateKey);
    return {
        open: easternTime(dateKey, OPEN_TIME), close: easternTime(dateKey, earlyClose ? EARLY_CLOSE_TIME : CLOSE_TIME), earlyClose,
        extendedOpen: easternTime(dateKey, PRE_MARKET_TIME), extendedClose: easternTime(dateKey, earlyClose ? EARLY_AFTER_HOURS_END_TIME : AFTER_HOURS_END_TIME)
    };
};

// The day a trade made on dateKey settles: the next trading day (T+1), or the date Alpaca's calendar gives
export const settlementDate = (dateKey: string): string => registeredDay(dateKey)?.settlementDate ?? nextTradingDay(dateKey);

// The first trading day after dateKey
export const nextTradingDay = (dateKey: string): string => {
    let next = addDays(dateKey, 1);
    while (!isTradingDay(next)) next = addDays(next, 1);
    return next;
};

// The most recent trading day on or before dateKey
export const latestTradingDay = (dateKey: string): string => {
    let day = dateKey;
    while (!isTradingDay(day)) day = addDays(day, -1);
    return day;
};

// Whether the regular session is open at now, and when it next opens and closes
export const marketStatus = (now: Date = new Date()): MarketStatus => {
    const { dateKey } = easternParts(now);
    const today = sessionOn(dateKey);
    const calendarKnown = registeredDay(dateKey) !== undefined || CALENDAR_YEARS.includes(Number(dateKey.slice(0, 4)));
    const nextOpenDay = today && now < today.open ? dateKey : nextTradingDay(dateKey);
    const nextOpen = sessionOn(nextOpenDay)!.open.toISOString();
    const closed = { open: false, session: "closed" as const, extendedOpen: false, extendedClose: null, nextOpen, nextClose: null, calendarKnown };
    if (!today) {
        return { ...closed, earlyClose: false };
    }
    if (now < today.extendedOpen || now >= today.extendedClose) {
        return { ...closed, earlyClose: today.earlyClose };
    }
    if (now < today.open) {
        return { ...closed, session: "pre-market", extendedOpen: true, extendedClose: today.open.toISOString(), earlyClose: today.earlyClose };
    }
    if (now < today.close) {
        return { open: true, session: "regular", extendedOpen: false, extendedClose: null, nextOpen, nextClose: today.close.toISOString(), earlyClose: today.earlyClose, calendarKnown };
    }
    return { ...closed, session: "after-hours", extendedOpen: true, extendedClose: today.extendedClose.toISOString(), earlyClose: today.earlyClose };
};

// Formats an instant in Eastern time, such as "Thu 9:30 AM ET" (withDay) or "4:00 PM ET"
export const formatEastern = (iso: string, { withDay = false } = {}): string => {
    const formatted = new Date(iso).toLocaleString("en-US", {
        timeZone: MARKET_TIME_ZONE, hour: "numeric", minute: "2-digit", ...(withDay && { weekday: "short" })
    });
    return `${formatted} ET`;
};
