// © 2023 Amazon Web Services, Inc. or its affiliates. All Rights Reserved.
// This AWS Content is provided subject to the terms of the AWS Customer Agreement available at
// http://aws.amazon.com/agreement or other written agreement between Customer and either
// Amazon Web Services, Inc. or Amazon Web Services EMEA SARL or both.
import React, { useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  CollectionPreferences,
  Header,
  Pagination,
  SpaceBetween,
  Table,
  TextFilter,
} from "@awsui/components-react";
import { useCollection } from "@awsui/collection-hooks";
import { API, graphqlOperation } from "aws-amplify";
import { CSVLink } from "react-csv";
import { onUpdateSessions } from "../../graphql/subscriptions";
import {
  fetchSessionActivity,
  refreshSessionActivity,
  startSessionActivity,
} from "../Shared/RequestService";
import { downloadAllPages, sanitizeCsvValue } from "./LogsUtils";
import "../../index.css";

const INITIAL_POLL_DELAY_MS = 1000;
const MAX_POLL_DELAY_MS = 10000;
const MAX_POLL_ATTEMPTS = 360;
const TERMINAL_ERROR_STATUSES = new Set(["FAILED", "CANCELLED", "TIMEOUT", "UNKNOWN"]);
const WAITING_STATUSES = new Set(["QUEUED", "STARTING", "RUNNING"]);

const ERROR_MESSAGES = {
  INVALID_PAGE_TOKEN: "This result page expired. Restart the query or download.",
  NOT_AUTHORIZED: "You are not authorized to view this session activity.",
  QUERY_CANCELLED: "The activity query was cancelled.",
  QUERY_FAILED: "The activity query failed. Try again.",
  QUERY_NOT_FOUND: "No activity query exists for this request.",
  QUERY_RESULTS_UNAVAILABLE: "Session activity is temporarily unavailable.",
  QUERY_START_FAILED: "The activity query could not be started. Try again.",
  QUERY_START_STALLED: "The activity query did not start. Try again.",
  QUERY_STATUS_UNKNOWN: "The activity query returned an unknown status.",
  QUERY_TIMEOUT: "The activity query timed out. Try again.",
};

const COLUMN_DEFINITIONS = [
  {
    id: "eventID",
    sortingField: "eventID",
    header: "eventID",
    cell: (item) => item.eventID,
    minWidth: 180,
  },
  {
    id: "eventName",
    sortingField: "eventName",
    header: "eventName",
    cell: (item) => item.eventName,
    minWidth: 200,
  },
  {
    id: "eventSource",
    sortingField: "eventSource",
    header: "eventSource",
    cell: (item) => item.eventSource,
    minWidth: 200,
  },
  {
    id: "eventTime",
    sortingField: "eventTime",
    header: "eventTime",
    cell: (item) => item.eventTime,
    minWidth: 180,
  },
];

const CSV_HEADERS = [
  { label: "eventID", key: "eventID" },
  { label: "eventName", key: "eventName" },
  { label: "eventSource", key: "eventSource" },
  { label: "eventTime", key: "eventTime" },
  { label: "username", key: "username" },
  { label: "accountName", key: "accountName" },
  { label: "accountId", key: "accountId" },
];

function EmptyState({ title, subtitle }) {
  return (
    <Box textAlign="center">
      <Box variant="strong">{title}</Box>
      <Box variant="p" padding={{ bottom: "s" }}>{subtitle}</Box>
    </Box>
  );
}

function QueryPreferences({ preferences, setPreferences }) {
  return (
    <CollectionPreferences
      title="Preferences"
      confirmLabel="Confirm"
      cancelLabel="Cancel"
      preferences={preferences}
      onConfirm={({ detail }) => setPreferences(detail)}
      pageSizePreference={{
        title: "Page size",
        options: [
          { value: 10, label: "10 logs" },
          { value: 30, label: "30 logs" },
          { value: 50, label: "50 logs" },
        ],
      }}
      wrapLinesPreference={{
        label: "Wrap lines",
        description: "Wrap long field values onto multiple lines.",
      }}
      visibleContentPreference={{
        title: "Select visible columns",
        options: [{
          label: "Log properties",
          options: COLUMN_DEFINITIONS.map(({ id }) => ({ id, label: id })),
        }],
      }}
    />
  );
}

function Logs({ item }) {
  const [allItems, setAllItems] = useState([]);
  const [queryStatus, setQueryStatus] = useState("QUEUED");
  const [errorCode, setErrorCode] = useState(null);
  const [nextToken, setNextToken] = useState(null);
  const [potentiallyTruncated, setPotentiallyTruncated] = useState(false);
  const [refreshLoading, setRefreshLoading] = useState(false);
  const [pageLoading, setPageLoading] = useState(false);
  const [downloadLoading, setDownloadLoading] = useState(false);
  const [downloadItems, setDownloadItems] = useState([]);
  const [downloadReady, setDownloadReady] = useState(false);
  const csvLink = useRef(null);
  const mounted = useRef(false);
  const pollTimer = useRef(null);
  const pollInFlight = useRef(null);
  const pendingPoll = useRef(false);
  const operationGeneration = useRef(0);
  const pollAttempts = useRef(0);
  const pollDelay = useRef(INITIAL_POLL_DELAY_MS);
  const [preferences, setPreferences] = useState({
    pageSize: 10,
    visibleContent: ["eventID", "eventName", "eventSource", "eventTime"],
  });

  const {
    items,
    filteredItemsCount,
    collectionProps,
    filterProps,
    paginationProps,
  } = useCollection(allItems, {
    filtering: {
      empty: <EmptyState title="No logs" subtitle="No activity was recorded in this query window." />,
      noMatch: (
        <EmptyState
          title="No matches"
          subtitle="The loaded events do not match your search."
        />
      ),
    },
    pagination: { pageSize: preferences.pageSize },
    sorting: {},
    selection: {},
  });

  const { selectedItems } = collectionProps;

  useEffect(() => {
    mounted.current = true;
    const subscription = API.graphql(
      graphqlOperation(onUpdateSessions, { requestId: item.id }),
    ).subscribe({
      next: () => pollResults(operationGeneration.current),
      error: () => schedulePoll(operationGeneration.current),
    });

    beginQuery(false);
    return () => {
      mounted.current = false;
      clearTimeout(pollTimer.current);
      subscription.unsubscribe();
    };
    // The selected request creates a new component instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  useEffect(() => {
    if (downloadReady && csvLink.current) {
      csvLink.current.link.click();
      setDownloadReady(false);
    }
  }, [downloadReady]);

  function resetPolling() {
    clearTimeout(pollTimer.current);
    pendingPoll.current = false;
    pollAttempts.current = 0;
    pollDelay.current = INITIAL_POLL_DELAY_MS;
  }

  function schedulePoll(operation = operationGeneration.current, delayOverride) {
    if (!mounted.current || operation !== operationGeneration.current) return;
    if (pollAttempts.current >= MAX_POLL_ATTEMPTS) {
      setFailure("QUERY_TIMEOUT", operation);
      return;
    }
    clearTimeout(pollTimer.current);
    const delay = delayOverride ?? pollDelay.current;
    pollDelay.current = Math.min(Math.ceil(pollDelay.current * 1.5), MAX_POLL_DELAY_MS);
    pollTimer.current = setTimeout(() => pollResults(operation), delay);
  }

  function setFailure(code, operation = operationGeneration.current) {
    if (!mounted.current || operation !== operationGeneration.current) return;
    clearTimeout(pollTimer.current);
    setQueryStatus("FAILED");
    setErrorCode(code);
    setRefreshLoading(false);
    setPageLoading(false);
  }

  async function beginQuery(refresh) {
    const operation = operationGeneration.current + 1;
    operationGeneration.current = operation;
    resetPolling();
    setErrorCode(null);
    setPotentiallyTruncated(false);
    setNextToken(null);
    if (refresh) {
      setAllItems([]);
      setRefreshLoading(true);
    }

    try {
      const state = refresh
        ? await refreshSessionActivity(item.id)
        : await startSessionActivity(item.id);
      if (!mounted.current || operation !== operationGeneration.current) return;
      setQueryStatus(state.status);
      await pollResults(operation);
    } catch (error) {
      setFailure(error?.errors?.[0]?.message ?? "QUERY_START_FAILED", operation);
    }
  }

  async function pollResults(operation = operationGeneration.current) {
    if (!mounted.current || operation !== operationGeneration.current) return;
    if (pollInFlight.current !== null) {
      pendingPoll.current = true;
      return;
    }
    pollInFlight.current = operation;
    pollAttempts.current += 1;
    try {
      const page = await fetchSessionActivity(item.id, null);
      if (!mounted.current || operation !== operationGeneration.current) return;
      setQueryStatus(page.status);
      setErrorCode(page.errorCode ?? null);
      if (page.errorCode) {
        setFailure(page.errorCode, operation);
      } else if (page.status === "COMPLETE") {
        setAllItems(page.events ?? []);
        setNextToken(page.nextToken ?? null);
        setPotentiallyTruncated(Boolean(page.potentiallyTruncated));
        setRefreshLoading(false);
        resetPolling();
      } else if (WAITING_STATUSES.has(page.status)) {
        schedulePoll(operation);
      } else if (TERMINAL_ERROR_STATUSES.has(page.status)) {
        setFailure(page.errorCode ?? `QUERY_${page.status}`, operation);
      }
    } catch (error) {
      setFailure(error?.errors?.[0]?.message ?? "QUERY_RESULTS_UNAVAILABLE", operation);
    } finally {
      pollInFlight.current = null;
      if (pendingPoll.current && mounted.current) {
        pendingPoll.current = false;
        schedulePoll(operationGeneration.current, 0);
      }
    }
  }

  async function loadNextPage() {
    if (!nextToken || pageLoading) return;
    const operation = operationGeneration.current;
    setPageLoading(true);
    try {
      const page = await fetchSessionActivity(item.id, nextToken);
      if (!mounted.current || operation !== operationGeneration.current) return;
      if (page.status !== "COMPLETE" || page.errorCode) {
        throw new Error(page.errorCode ?? "QUERY_NOT_COMPLETE");
      }
      setAllItems((currentItems) => [...currentItems, ...(page.events ?? [])]);
      setNextToken(page.nextToken ?? null);
      setPotentiallyTruncated((current) => current || Boolean(page.potentiallyTruncated));
    } catch (error) {
      setFailure(error.message ?? "QUERY_RESULTS_UNAVAILABLE");
    } finally {
      if (mounted.current) setPageLoading(false);
    }
  }

  async function handleDownload() {
    setDownloadLoading(true);
    setErrorCode(null);
    try {
      const result = await downloadAllPages(item.id, fetchSessionActivity);
      if (!mounted.current) return;
      const rows = result.events.map((event) => ({
        eventID: sanitizeCsvValue(event.eventID),
        eventName: sanitizeCsvValue(event.eventName),
        eventSource: sanitizeCsvValue(event.eventSource),
        eventTime: sanitizeCsvValue(event.eventTime),
        username: sanitizeCsvValue(item.email),
        accountName: sanitizeCsvValue(item.accountName),
        accountId: sanitizeCsvValue(item.accountId),
      }));
      setDownloadItems(rows);
      setPotentiallyTruncated((current) => current || result.potentiallyTruncated);
      setDownloadReady(true);
    } catch (error) {
      setErrorCode(error.message ?? "DOWNLOAD_FAILED");
    } finally {
      if (mounted.current) setDownloadLoading(false);
    }
  }

  const statusDescription = queryStatus === "COMPLETE"
    ? "Session activity logs"
    : `Session activity query: ${queryStatus.toLowerCase()}`;
  const displayedError = ERROR_MESSAGES[errorCode] ?? (errorCode ? "Session activity is unavailable." : null);
  const filename = potentiallyTruncated
    ? "session_logs_potentially_truncated.csv"
    : "session_logs.csv";

  return (
    <SpaceBetween size="s">
      {displayedError && <Alert type="error">{displayedError}</Alert>}
      {potentiallyTruncated && (
        <Alert type="warning">
          CloudWatch reached its 100,000-event query maximum. Results may be truncated.
        </Alert>
      )}
      <Table
        {...collectionProps}
        resizableColumns
        loading={WAITING_STATUSES.has(queryStatus)}
        loadingText="Fetching session activity"
        header={(
          <Header
            counter={selectedItems.length
              ? `(${selectedItems.length}/${allItems.length})`
              : `(${allItems.length})`}
            description={statusDescription}
            actions={(
              <SpaceBetween size="s" direction="horizontal">
                {nextToken && (
                  <Button onClick={loadNextPage} loading={pageLoading}>
                    Load next 1,000
                  </Button>
                )}
                {item.status === "in progress" && (
                  <Button
                    iconName="refresh"
                    onClick={() => beginQuery(true)}
                    loading={refreshLoading}
                    disabled={downloadLoading || pageLoading}
                    ariaLabel="Refresh session activity"
                  />
                )}
                <Button
                  disabled={queryStatus !== "COMPLETE" || pageLoading || refreshLoading}
                  variant="primary"
                  onClick={handleDownload}
                  loading={downloadLoading}
                  iconName="download"
                  iconAlign="left"
                >
                  Download
                </Button>
                <CSVLink
                  data={downloadItems}
                  headers={CSV_HEADERS}
                  filename={filename}
                  className="hidden"
                  ref={csvLink}
                  target="_blank"
                />
              </SpaceBetween>
            )}
          >
            Session activity logs
          </Header>
        )}
        filter={(
          <TextFilter
            {...filterProps}
            filteringPlaceholder="Search loaded logs"
            countText={filteredItemsCount}
            className="input-filter"
          />
        )}
        columnDefinitions={COLUMN_DEFINITIONS}
        visibleColumns={preferences.visibleContent}
        pagination={<Pagination {...paginationProps} />}
        preferences={(
          <QueryPreferences preferences={preferences} setPreferences={setPreferences} />
        )}
        items={items}
      />
    </SpaceBetween>
  );
}

export default Logs;
