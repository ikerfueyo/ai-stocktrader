// When a scheduled job is due. Pure, so it can be unit tested; lib/server/jobs.ts runs the jobs.
import { addDays, easternParts, easternTime } from "../marketHours";

// Whether a daily Eastern time in slots ("HH:MM") has passed since lastRun (null: never run, so due at once). Checks today's and
// yesterday's slots, so one missed while the server was down runs once when it's back.
export const isSlotDue = (slots: string[], lastRun: Date | null, now: Date = new Date()): boolean => {
    if (!lastRun) return true;
    const today = easternParts(now).dateKey;
    return [addDays(today, -1), today].some(day => slots.some(slot => {
        const at = easternTime(day, slot);
        return at > lastRun && at <= now;
    }));
};
