import "server-only";
import { fetchAlpacaCalendar, isAlpacaConfigured } from "./marketData";
import { addDays, easternParts, registerCalendar } from "../marketHours";

// Registers Alpaca's market calendar (a year back to two years ahead) with lib/marketHours.ts, so the server knows unscheduled
// closures, future years' holidays and early closes, and each day's settlement date. It covers only the dates Alpaca returned,
// from its first trading day to its last; outside them the hard-coded lists still apply. Without Alpaca keys it does nothing.
export const syncCalendar = async (label: string): Promise<number> => {
    if (!isAlpacaConfigured()) return 0;
    const today = easternParts(new Date()).dateKey;
    const days = await fetchAlpacaCalendar(addDays(today, -370), addDays(today, 730));
    if (days.length === 0) throw new Error("Alpaca's calendar came back empty");
    const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
    registerCalendar({
        days: sorted.map(({ date, open, close, session_open, session_close, settlement_date }) => ({
            date, open, close, sessionOpen: session_open, sessionClose: session_close, settlementDate: settlement_date
        })),
        from: sorted[0].date,
        to: sorted.at(-1)!.date
    });
    console.log(`${label}: registered Alpaca's market calendar from ${sorted[0].date} to ${sorted.at(-1)!.date}`);
    return days.length;
};
