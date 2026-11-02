import { Fragment } from "react";
import { formatEastern } from "@/lib/marketHours";
import type { AnalysisDetails } from "@/lib/types";

const SECTIONS: { key: "evidence" | "counterarguments" | "risks" | "catalysts"; label: string }[] = [
    { key: "evidence", label: "Evidence" },
    { key: "counterarguments", label: "Counterarguments" },
    { key: "risks", label: "Risks" },
    { key: "catalysts", label: "Catalysts" }
];

const formatDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

// An AI analysis's verdict line, thesis and collapsible sections (evidence, counterarguments, risks, catalysts, sources), and when
// and by which model it was made
const AnalysisDetailsView = ({ verdictLabel, thesis, details }: { verdictLabel: string; thesis: string; details: AnalysisDetails }) => (
    <Fragment>
        <p className="analysis-verdict">AI verdict: {verdictLabel}</p>
        <p className="analysis-horizon">Horizon: {details.horizon}</p>
        <p className="analysis-thesis">{thesis}</p>
        <div className="analysis-sections">
            {SECTIONS.filter(({ key }) => details[key].length > 0).map(({ key, label }) => (
                <details key={key}>
                    <summary>{label} ({details[key].length})</summary>
                    <ul>{details[key].map(item => <li key={item}>{item}</li>)}</ul>
                </details>
            ))}
            {details.sources.length > 0 && (
                <details>
                    <summary>Sources ({details.sources.length})</summary>
                    <ul>
                        {details.sources.map(({ title, url, published }) => (
                            <li key={`${title}-${published}`}>
                                {url ? <a href={url} target="_blank" rel="noopener noreferrer">{title}</a> : title}
                                <span className="analysis-source-date"> · {formatDate(published)}</span>
                            </li>
                        ))}
                    </ul>
                </details>
            )}
        </div>
        <p className="analysis-freshness">
            Generated {formatDate(details.generatedAt)}, {formatEastern(details.generatedAt)} · {details.model}
            {details.dataAsOf && ` · data through ${formatDate(details.dataAsOf)}`}
            {" · "}Not investment advice.
        </p>
    </Fragment>
);

export default AnalysisDetailsView;
