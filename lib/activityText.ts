// How an activity's description reads in the pages (shared by the server's cash rows and the activity feed; pure). Alpaca describes a
// transfer's cash activity as key-value pairs ("type: ach, subtype: none, statement_id: …, direction: INCOMING"), shown as the
// transfer's kind; other descriptions, and the simulator's sentences, are kept as they are.
export const readableDescription = (description: string): string => {
    const pairs = Object.fromEntries(description.split(/,\s*/).map(part => part.split(/:\s*/)).filter(pair => pair.length === 2).map(([key, value]) => [key.trim(), value.trim()]));
    if (!pairs.type || !pairs.direction) return description;
    const kind = pairs.type.toLowerCase() === "ach" ? "ACH" : pairs.type.toLowerCase() === "wire" ? "Wire" : pairs.type;
    return `${kind} ${pairs.direction === "INCOMING" ? "deposit" : "withdrawal"}`;
};
