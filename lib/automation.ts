// Recurring investments' schedules and price alerts' conditions, shared by the server (which runs them) and the pages (which describe
// them). Pure, so they can be unit tested.
import { addDays, isTradingDay, nextTradingDay } from "./marketHours";

export type Frequency = "daily" | "weekly" | "biweekly" | "monthly";
export const FREQUENCY_LABELS: Record<Frequency, string> = { daily: "Every trading day", weekly: "Every week", biweekly: "Every two weeks", monthly: "Every month" };

const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
const lastDayOf = (month: string) => addDays(`${addDays(`${month}-01`, 31).slice(0, 7)}-01`, -1);

// The first date of the schedule on or after from: every day; every 7 or 14 days from the start; or the start's day of the month
// (the month's last day when it has fewer days)
export const nextScheduledDate = (frequency: Frequency, start: string, from: string): string => {
    const date = from > start ? from : start;
    if (frequency === "daily") return date;
    if (frequency === "weekly" || frequency === "biweekly") {
        const step = frequency === "weekly" ? 7 : 14;
        return addDays(start, Math.ceil(days(start, date) / step) * step);
    }
    const day = Number(start.slice(8, 10));
    let month = date.slice(0, 7);
    for (;;) {
        const last = lastDayOf(month);
        const scheduled = `${month}-${String(Math.min(day, Number(last.slice(8, 10)))).padStart(2, "0")}`;
        if (scheduled >= date) return scheduled;
        month = addDays(`${month}-01`, 31).slice(0, 7);
    }
};

// The trading day a scheduled date runs on: itself, or the next trading day when the market's closed that day
export const runDateFor = (scheduled: string): string => isTradingDay(scheduled) ? scheduled : nextTradingDay(scheduled);

// The schedule's next date after the one that just ran
export const followingDate = (frequency: Frequency, start: string, scheduled: string): string => nextScheduledDate(frequency, start, addDays(scheduled, 1));

export type AlertCondition = "above" | "below" | "change_up" | "change_down";
export const ALERT_LABELS: Record<AlertCondition, string> = {
    above: "Price rises to", below: "Price falls to", change_up: "Up today by", change_down: "Down today by"
};

export const describeAlert = (symbol: string, condition: AlertCondition, threshold: number) =>
    condition === "above" ? `${symbol} rises to $${threshold}` : condition === "below" ? `${symbol} falls to $${threshold}`
        : `${symbol} is ${condition === "change_up" ? "up" : "down"} ${threshold}% today`;

export interface AlertState {
    condition: AlertCondition;
    threshold: number;
    // The price when last checked (the price when it was set, at first): a level alert fires when the price crosses the level
    lastPrice: number | null;
    // The day a change alert last fired (it fires once a day at most)
    triggeredOn: string | null;
}

// Whether an alert fires on this quote: a level alert when the price crosses it (from below for above, from above for below), a
// change alert when the day's change from the previous close reaches the percentage, once a day
export const alertFires = (alert: AlertState, quote: { price: number; previousClose: number | null }, today: string): boolean => {
    const { condition, threshold, lastPrice } = alert;
    if (condition === "above") return lastPrice !== null && lastPrice < threshold && quote.price >= threshold;
    if (condition === "below") return lastPrice !== null && lastPrice > threshold && quote.price <= threshold;
    if (!quote.previousClose || alert.triggeredOn === today) return false;
    const change = (quote.price / quote.previousClose - 1) * 100;
    return condition === "change_up" ? change >= threshold : change <= -threshold;
};
