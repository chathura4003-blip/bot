"use strict";

/**
 * Premium Utility Functions
 * Provides advanced formatting and processing for a high-end bot experience.
 */

const FANCY_MAP = {
  a: "𝒶", b: "𝒷", c: "𝒸", d: "𝒹", e: "ℯ", f: "𝒻", g: "ℊ", h: "𝒽", i: "𝒾", j: "𝒿", k: "𝓀", l: "𝓁", m: "𝓂",
  n: "𝓃", o: "ℴ", p: "𝓅", q: "𝓆", r: "𝓇", s: "𝓈", t: "𝓉", u: "𝓊", v: "𝓋", w: "𝓌", x: "𝓍", y: "𝓎", z: "𝓏",
  A: "𝒜", B: "ℬ", C: "𝒞", D: "𝒟", E: "ℰ", F: "ℱ", G: "𝒢", H: "ℋ", I: "ℐ", J: "𝒥", K: "𝒦", L: "ℒ", M: "ℳ",
  N: "𝒩", O: "𝒪", P: "𝒫", Q: "𝒬", R: "ℛ", S: "𝒮", T: "𝒯", U: "𝒰", V: "𝒱", W: "𝒲", X: "𝒳", Y: "𝒴", Z: "𝒵",
  0: "𝟘", 1: "𝟙", 2: "𝟚", 3: "𝟛", 4: "𝟜", 5: "𝟝", 6: "𝟞", 7: "𝟟", 8: "𝟠", 9: "𝟡"
};

/**
 * Converts text to a premium fancy font style.
 */
function toFancy(text) {
  if (!text) return "";
  return text.split("").map(char => FANCY_MAP[char] || char).join("");
}

/**
 * Generates a premium progress bar.
 */
function progressBar(current, total, length = 12) {
  const progress = Math.min(1, Math.max(0, current / total));
  const fill = Math.round(length * progress);
  const empty = length - fill;
  return "█".repeat(fill) + "░".repeat(empty);
}

/**
 * Formats bytes to a human-readable string with premium precision.
 */
function formatSize(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/**
 * Premium random tip generator.
 */
const TIPS = [
  "Use .menu to see all available commands.",
  "You can download HD videos by replying '1' to search results.",
  "Check your balance with .bal and shop in the .shop!",
  "Add your friends as mods to help manage the group.",
  "Stay premium by following our official channel."
];

function getRandomTip() {
  return TIPS[Math.floor(Math.random() * TIPS.length)];
}

module.exports = {
  toFancy,
  progressBar,
  formatSize,
  getRandomTip
};
