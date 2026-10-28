import { test } from "node:test";
import assert from "node:assert/strict";
import { closeAccountProblem } from "./accounts";

test("an account closes only without positions, open orders or cash", () => {
    const empty = { positions: 0, openOrders: 0, cash: "0", pendingTransferOut: "0" };
    assert.equal(closeAccountProblem(empty), null);
    assert.match(closeAccountProblem({ ...empty, positions: 1, openOrders: 2, cash: "50" })!, /positions/);
    assert.match(closeAccountProblem({ ...empty, openOrders: 1, cash: "50" })!, /open orders/);
    assert.match(closeAccountProblem({ ...empty, cash: "0.01" })!, /cash/);
    // A debit is cash to pay back, not cash to withdraw
    assert.match(closeAccountProblem({ ...empty, cash: "-20" })!, /cash/);
    // Under a cent left, and cash already on its way out, don't hold it open
    assert.equal(closeAccountProblem({ ...empty, cash: "0.004" }), null);
    assert.equal(closeAccountProblem({ ...empty, cash: "1000", pendingTransferOut: "1000" }), null);
    assert.equal(closeAccountProblem({ positions: 0, openOrders: 0 }), null);
});
