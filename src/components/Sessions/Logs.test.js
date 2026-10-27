import { downloadAllPages, sanitizeCsvValue } from "./LogsUtils";

test("sanitizeCsvValue neutralizes spreadsheet formulas", () => {
  expect(sanitizeCsvValue("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)");
  expect(sanitizeCsvValue("normal")).toBe("normal");
});

test("downloadAllPages follows every continuation token", async () => {
  const fetchPage = jest
    .fn()
    .mockResolvedValueOnce({
      status: "COMPLETE",
      events: [{ eventID: "one" }],
      nextToken: "page-two",
      potentiallyTruncated: false,
    })
    .mockResolvedValueOnce({
      status: "COMPLETE",
      events: [{ eventID: "two" }],
      nextToken: null,
      potentiallyTruncated: true,
    });

  await expect(downloadAllPages("request-id", fetchPage)).resolves.toEqual({
    events: [{ eventID: "one" }, { eventID: "two" }],
    potentiallyTruncated: true,
  });
  expect(fetchPage).toHaveBeenNthCalledWith(1, "request-id", null);
  expect(fetchPage).toHaveBeenNthCalledWith(2, "request-id", "page-two");
});

test("downloadAllPages rejects a partial or failed page", async () => {
  const fetchPage = jest.fn().mockResolvedValue({
    status: "FAILED",
    events: [],
    errorCode: "QUERY_FAILED",
  });

  await expect(downloadAllPages("request-id", fetchPage)).rejects.toThrow("QUERY_FAILED");
});

test("downloadAllPages rejects a repeated continuation token", async () => {
  const fetchPage = jest.fn().mockResolvedValue({
    status: "COMPLETE",
    events: [],
    nextToken: "same-token",
  });

  await expect(downloadAllPages("request-id", fetchPage)).rejects.toThrow("REPEATED_PAGE_TOKEN");
});
