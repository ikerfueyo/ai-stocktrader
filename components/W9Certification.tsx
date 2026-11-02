"use client";

import { useEffect, useState } from "react";
import axios from "axios";
import { apiErrorMessage, logError } from "@/lib/apiError";
import type { W9Certification as Certification } from "@/lib/types";

// The account's W-9 certification on the Settings page: whether backup withholding applies (24% of dividends and sale proceeds), and
// certifying again, as after the IRS says it no longer applies
const W9Certification = ({ accountId }: { accountId: string }) => {
    const [certification, setCertification] = useState<Certification | null>(null);
    const [subject, setSubject] = useState(false);
    const [certify, setCertify] = useState(false);
    const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

    useEffect(() => {
        const load = async () => {
            try {
                const { data } = await axios.get<Certification>(`/api/accounts/${accountId}/w9`);
                setCertification(data);
                setSubject(data.backupWithholding);
            } catch (error) {
                logError(error);
            }
        };
        load();
    }, [accountId]);

    const onSave = async () => {
        setMessage(null);
        try {
            const { data } = await axios.post<Certification>(`/api/accounts/${accountId}/w9`, { backupWithholding: subject, certify: true });
            setCertification(data);
            setCertify(false);
            setMessage({ ok: true, text: data.backupWithholding ? "Saved: backup withholding applies." : "Saved: no backup withholding." });
        } catch (error) {
            logError(error);
            setMessage({ ok: false, text: apiErrorMessage(error) });
        }
    };

    if (!certification) return null;
    return (
        <div>
            <p>
                {!certification.onFile ? "No W-9 certification is on file, so 24% of dividends and sale proceeds is withheld (backup withholding)."
                    : certification.backupWithholding ? "Your W-9 certification says you're subject to backup withholding: 24% of dividends and sale proceeds is withheld."
                        : "Your W-9 certification is on file: no backup withholding."}
                {certification.signedAt && <span className="text-muted"> Certified {new Date(certification.signedAt).toLocaleDateString()}.</span>}
            </p>
            <label className="d-block">
                <input type="radio" checked={!subject} onChange={() => setSubject(false)} /> I am not subject to backup withholding
            </label>
            <label className="d-block">
                <input type="radio" checked={subject} onChange={() => setSubject(true)} /> I have been notified by the IRS that I am subject to backup withholding
            </label>
            <label className="d-block mt-2">
                <input type="checkbox" checked={certify} onChange={e => setCertify(e.target.checked)} /> Under penalties of perjury, I certify that my taxpayer
                identification number is correct, that the statement above is true, and that I am a U.S. person (simulated: test data only)
            </label>
            <button type="button" className="btn btn-sm btn-outline-primary mt-2" onClick={onSave} disabled={!certify}>Certify</button>
            {message && <p className={message.ok ? "text-success" : "text-danger"}>{message.text}</p>}
        </div>
    );
};

export default W9Certification;
