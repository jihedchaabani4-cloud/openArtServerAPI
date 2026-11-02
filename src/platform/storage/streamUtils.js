/**
 * Duck-typing predicate detecting Readable stream instances.
 *
 * @param {unknown} candidate - Value to inspect
 * @returns {boolean} True if value implements Node stream or Web stream reader contracts
 */
export function isStream(candidate) {
    return (
        candidate !== null &&
        typeof candidate === "object" &&
        (typeof candidate.pipe === "function" ||
            typeof candidate[Symbol.asyncIterator] === "function" ||
            typeof candidate.getReader === "function")
    );
}
