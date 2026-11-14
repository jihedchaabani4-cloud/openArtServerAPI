/**
 * Canonical aspect ratio calculations and standard preset snapping (#shared).
 */

export function gcd(a, b) {
    let x = Math.abs(Math.round(a));
    let y = Math.abs(Math.round(b));
    while (y !== 0) {
        const t = y;
        y = x % y;
        x = t;
    }
    return x || 1;
}

export const CANONICAL_PRESETS = [
    [16 / 9, "16:9"],
    [9 / 16, "9:16"],
    [4 / 3,  "4:3"],
    [3 / 4,  "3:4"],
    [1,      "1:1"],
    [3 / 2,  "3:2"],
    [2 / 3,  "2:3"],
    [21 / 9, "21:9"],
    [9 / 21, "9:21"],
    [4 / 5,  "4:5"],
    [5 / 4,  "5:4"],
];

export function calculateAspectRatio(width, height) {
    const w = Number(width);
    const h = Number(height);
    if (!w || !h || isNaN(w) || isNaN(h) || w <= 0 || h <= 0) {
        return "1:1";
    }

    const r = w / h;

    for (const [val, label] of CANONICAL_PRESETS) {
        if (Math.abs(r - val) / val < 0.05) {
            return label;
        }
    }

    const d = gcd(w, h);
    const rw = Math.round(w / d);
    const rh = Math.round(h / d);

    if (rw > 50 || rh > 50) {
        return `${Number(r.toFixed(2))}:1`;
    }

    return `${rw}:${rh}`;
}
