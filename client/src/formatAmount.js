// Formats a number (or numeric string) with two decimals and thousands
// separators: 1234.5 -> "1,234.50". Leaves null/undefined untouched so
// components render nothing while data is still loading.
const formatAmount = (value) => {
    if (value === null || value === undefined) return value;
    return Number(value).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
};

export default formatAmount;
