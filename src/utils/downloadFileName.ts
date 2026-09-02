// src/utils/downloadFileName.ts
// Turns a user-facing label into something an `a[download]` can carry on every OS.
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001F]/g;

/**
 * Strips the characters Windows, macOS and Linux all refuse in a filename. Also collapses the
 * runs of whitespace left behind so `a - b` does not become `a___b`.
 */
export const sanitizeDownloadFileName = (name: string, fallback = 'download'): string => {
    const cleaned = name.replace(ILLEGAL, '_').replace(/\s+/g, ' ').trim();
    return cleaned || fallback;
};

/** Local `YYYY-MM-DD`, not `toISOString`: the latter is UTC and shifts a day for most users. */
export const formatLocalDateStamp = (date = new Date()): string => {
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    const day = `${date.getDate()}`.padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
};
