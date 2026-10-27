"use client";

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { apiErrorMessage, logError } from "@/lib/apiError";
import { useBrokerAccount } from "@/context/BrokerAccountContext";
import type { AchRelationship, BrokerAccount, BrokerTransfer, FundingTerms, RecipientBank } from "@/lib/types";

// Transfers still on their way, polled until they finish
export const IN_PROGRESS = ["QUEUED", "APPROVAL_PENDING", "PENDING", "SENT_TO_CLEARING", "APPROVED"];
const POLL_MS = 5000;

// The active account's bank links, wire recipient banks and transfers, the holder's name (bank accounts must be in it), and the
// transfer limits and fees. Polls while a link is being verified or a transfer is in progress, so their status changes show up.
export const useFunding = () => {
    const { active } = useBrokerAccount();
    const accountId = active?.accountId ?? null;
    const [relationships, setRelationships] = useState<AchRelationship[] | null>(null);
    const [banks, setBanks] = useState<RecipientBank[]>([]);
    const [transfers, setTransfers] = useState<BrokerTransfer[]>([]);
    const [holderName, setHolderName] = useState("");
    const [terms, setTerms] = useState<FundingTerms | null>(null);
    const [error, setError] = useState<string | null>(null);

    const reload = useCallback(async () => {
        if (!accountId) return;
        try {
            const [links, recipients, history, account, funding] = await Promise.all([
                axios.get<AchRelationship[]>(`/api/accounts/${accountId}/ach`),
                axios.get<RecipientBank[]>(`/api/accounts/${accountId}/banks`),
                axios.get<BrokerTransfer[]>(`/api/accounts/${accountId}/transfers`),
                axios.get<BrokerAccount>(`/api/accounts/${accountId}`),
                axios.get<FundingTerms>("/api/funding")
            ]);
            setTerms(funding.data);
            setRelationships(links.data);
            setBanks(recipients.data);
            setTransfers(history.data);
            setHolderName([account.data.identity?.given_name, account.data.identity?.family_name].filter(Boolean).join(" "));
            setError(null);
        } catch (error) {
            logError(error);
            setError(apiErrorMessage(error));
        }
    }, [accountId]);

    useEffect(() => {
        // reload only sets state once its requests finish
        // eslint-disable-next-line react-hooks/set-state-in-effect
        reload();
    }, [reload]);

    const busy = (relationships ?? []).some(({ status }) => status === "QUEUED") || transfers.some(({ status }) => IN_PROGRESS.includes(status));
    useEffect(() => {
        if (!busy) return;
        const timer = setInterval(reload, POLL_MS);
        return () => clearInterval(timer);
    }, [busy, reload]);

    const approved = relationships?.find(({ status }) => status === "APPROVED") ?? null;
    return { accountId, relationships, approved, banks, transfers, holderName, terms, error, reload };
};
