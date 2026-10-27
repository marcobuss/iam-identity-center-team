const FORMULA_PREFIX_PATTERN = /^[=+\-@]/;

/**
 * Prevent spreadsheet software from interpreting exported values as formulas.
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeCsvValue(value) {
  const text = String(value ?? "");
  return FORMULA_PREFIX_PATTERN.test(text) ? `'${text}` : text;
}

/**
 * Retrieve every native CloudWatch result page for a browser-generated export.
 * @param {string} requestId
 * @param {(requestId: string, nextToken: string | null) => Promise<any>} fetchPage
 * @returns {Promise<{events: Array<Record<string, string>>, potentiallyTruncated: boolean}>}
 */
export async function downloadAllPages(requestId, fetchPage) {
  const events = [];
  const observedTokens = new Set();
  let nextToken = null;
  let potentiallyTruncated = false;

  do {
    const page = await fetchPage(requestId, nextToken);
    if (page.status !== "COMPLETE" || page.errorCode) {
      throw new Error(page.errorCode ?? "QUERY_NOT_COMPLETE");
    }
    events.push(...(page.events ?? []));
    potentiallyTruncated ||= Boolean(page.potentiallyTruncated);
    nextToken = page.nextToken ?? null;
    if (nextToken && observedTokens.has(nextToken)) {
      throw new Error("REPEATED_PAGE_TOKEN");
    }
    if (nextToken) {
      observedTokens.add(nextToken);
    }
  } while (nextToken);

  return { events, potentiallyTruncated };
}
