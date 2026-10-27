import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
    achTimeline, bankRequestError, fedHolidays, instantAmount, isBankingDay, maskAccountNumber, nextBankingDay, plannedReturn,
    relationshipRequestError, transferRequestError, verifyRelationship, wireTimeline
} from "./funding";
import { easternTime } from "../../../marketHours";

const at = (date: string, time: string) => easternTime(date, time);

describe("Banking days", () => {
    test("the Federal Reserve's 2026 holidays, observed on Monday when they fall on a Sunday", () => {
        assert.deepEqual([...fedHolidays(2026)].sort(), [
            "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-04", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-12-25"
        ]);
        assert.ok(fedHolidays(2027).has("2027-07-05"), "July 4, 2027 is a Sunday");
    });

    test("banks close on Columbus Day and Veterans Day, when stocks trade, but open on Good Friday", () => {
        assert.equal(isBankingDay("2026-10-12"), false);
        assert.equal(isBankingDay("2026-11-11"), false);
        assert.equal(isBankingDay("2026-04-03"), true);
        assert.equal(nextBankingDay("2026-11-10"), "2026-11-12");
        assert.equal(nextBankingDay("2026-10-09"), "2026-10-13", "Friday to Tuesday over Columbus Day");
    });
});

describe("Transfer timelines", () => {
    test("an ACH transfer before the cutoff clears that evening and completes the next banking day", () => {
        const { sentAt, completeAt } = achTimeline(at("2026-10-27", "10:00"));
        assert.equal(sentAt.toISOString(), at("2026-10-27", "16:00").toISOString());
        assert.equal(completeAt.toISOString(), at("2026-10-28", "09:00").toISOString());
    });

    test("after the cutoff or on a weekend, it waits for the next banking day", () => {
        assert.equal(achTimeline(at("2026-10-27", "17:00")).sentAt.toISOString(), at("2026-10-28", "16:00").toISOString());
        const weekend = achTimeline(at("2026-10-24", "12:00"));
        assert.equal(weekend.sentAt.toISOString(), at("2026-10-26", "16:00").toISOString());
        assert.equal(weekend.completeAt.toISOString(), at("2026-10-27", "09:00").toISOString());
        assert.equal(achTimeline(at("2026-11-10", "12:00")).completeAt.toISOString(), at("2026-11-12", "09:00").toISOString(), "over Veterans Day");
    });

    test("an outgoing wire goes the same banking day before 3 p.m.", () => {
        assert.equal(wireTimeline(at("2026-10-27", "11:00")).sentAt.toISOString(), at("2026-10-27", "11:00").toISOString());
        assert.equal(wireTimeline(at("2026-10-27", "15:30")).sentAt.toISOString(), at("2026-10-28", "09:00").toISOString());
        assert.equal(wireTimeline(at("2026-10-27", "06:00")).sentAt.toISOString(), at("2026-10-27", "09:00").toISOString());
    });

    test("the test cents return a deposit 2 banking days after it completes", () => {
        assert.equal(plannedReturn(100, at("2026-10-28", "09:00")), null);
        const returned = plannedReturn(100.01, at("2026-10-28", "09:00"))!;
        assert.equal(returned.code, "R01");
        assert.equal(returned.at.toISOString(), at("2026-10-30", "09:00").toISOString());
        assert.equal(plannedReturn(250.10, at("2026-10-28", "09:00"))!.code, "R10");
    });
});

describe("Instant deposits", () => {
    test("credit up to the limit at once, less what's still outstanding", () => {
        assert.equal(instantAmount(500, 0), 500);
        assert.equal(instantAmount(5000, 0), 1000);
        assert.equal(instantAmount(5000, 800), 200);
        assert.equal(instantAmount(5000, 1000), 0);
    });
});

describe("Bank links", () => {
    const valid = { account_owner_name: "Test User", bank_account_type: "CHECKING", bank_account_number: "123456789", bank_routing_number: "011000015" };

    test("need a valid routing number, a 4- to 17-digit account number and a checking or savings type", () => {
        assert.equal(relationshipRequestError(valid), null);
        assert.match(relationshipRequestError({ ...valid, bank_routing_number: "011000016" })!, /routing/);
        assert.match(relationshipRequestError({ ...valid, bank_account_number: "12-34" })!, /4 to 17 digits/);
        assert.match(relationshipRequestError({ ...valid, bank_account_type: "BROKERAGE" })!, /CHECKING or SAVINGS/);
    });

    test("verify only when the owner is the account holder", () => {
        const holder = { given_name: "Test", family_name: "User" };
        assert.equal(verifyRelationship("TEST A. USER", holder, "123456789"), null);
        assert.match(verifyRelationship("Someone Else", holder, "123456789")!, /doesn't match/);
        assert.match(verifyRelationship("Test User", holder, "123450000")!, /couldn't verify/);
    });

    test("only the last 4 digits are kept", () => {
        assert.equal(maskAccountNumber("123456789"), "••••6789");
    });
});

describe("Transfer requests", () => {
    const ach = { transfer_type: "ach", direction: "INCOMING", amount: "100.00" };

    test("need a valid type, direction and amount of at least $1", () => {
        assert.equal(transferRequestError(ach, { todayTotal: 0 }), null);
        assert.match(transferRequestError({ ...ach, amount: "0.50" }, { todayTotal: 0 })!, /minimum/);
        assert.match(transferRequestError({ ...ach, amount: "10.001" }, { todayTotal: 0 })!, /2 decimals/);
        assert.match(transferRequestError({ ...ach, transfer_type: "wire" }, { todayTotal: 0 })!, /Incoming wires/);
    });

    test("ACH transfers are limited per day", () => {
        assert.match(transferRequestError({ ...ach, amount: "20000" }, { todayTotal: 40000 })!, /limited/);
        assert.equal(transferRequestError({ ...ach, transfer_type: "wire", direction: "OUTGOING", amount: "20000" }, { todayTotal: 40000 }), null, "wires aren't");
    });

    test("wire recipients are domestic banks with valid routing numbers", () => {
        assert.equal(bankRequestError({ name: "Test Bank", bank_code: "011000015", bank_code_type: "ABA", account_number: "123456789" }), null);
        assert.match(bankRequestError({ name: "Test Bank", bank_code: "DEUTDEFF", bank_code_type: "BIC", account_number: "123456789" })!, /domestic/);
    });
});
