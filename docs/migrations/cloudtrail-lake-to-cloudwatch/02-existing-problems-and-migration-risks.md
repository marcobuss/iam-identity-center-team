# Existing Audit Problems and Migration-Specific Risks

## Summary

All findings documented under **Existing audit-subsystem findings** are already present in the current repository. They are not introduced by Amazon CloudWatch. A migration that only replaces the AWS SDK clients would preserve most of them and could amplify some of them.

This document is based on static source analysis of the current `main` branch. It does not demonstrate that a particular deployment has been exploited. Some findings are definite code defects; others require concurrency, delayed events, particular identity naming, or deployed AppSync behavior to manifest.

## Classification

| Finding | Present now? | Classification | Migration effect |
|---|---:|---|---|
| Browser controls audit query criteria | Yes | Security defect | Persists unless the API is redesigned |
| Direct SQL interpolation | Yes | Injection risk | Time injection decreases with CloudWatch, but filter injection persists |
| Query results lack request-level authorization | Yes | Security defect | Persists if CloudWatch query IDs are treated as bearer tokens |
| Subscription uses the wrong argument | Yes | Correctness and security defect; runtime impact needs integration confirmation | Should be removed or corrected |
| DynamoDB stream drops batched records | Yes | Correctness defect | Persists if the stream architecture is retained |
| Unbounded query-status polling | Yes | Operability defect | Must be rewritten because CloudWatch has different status APIs |
| Errors are swallowed | Yes | Correctness and operability defect | Persists unless typed errors and statuses are introduced |
| Audit data is copied to Lambda logs | Yes | Security and operability defect | Persists unless logging is changed |
| Seven-day source retention | Yes for a TEAM-created EDS | Design and operability limitation | Must become explicit CloudWatch retention |
| Completed results become stale | Yes | Correctness limitation | Persists with any cached asynchronous query |
| Fixed one-hour extension | Yes | Audit correctness defect | Should use the stored permission-set session duration |
| User and role substring matching | Yes | Attribution correctness limitation | Persists because CloudWatch has the same raw identity fields |
| Management events only | Yes | Coverage limitation, potentially intentional | Must be deliberately preserved or expanded |
| Only four fields are shown | Yes | Product limitation, potentially intentional | Can remain for compatibility |
| Organization audit infrastructure tied to Amplify lifecycle | Yes | Operability and governance risk | Avoid repeating this with CloudWatch resources |
| CloudWatch schema, status, history, and centralization risks | No | Migration-specific | Introduced only during migration |

## 1. Browser-controlled organization-wide queries

This is the most important current security issue.

### Current behavior

`src/components/Sessions/Logs.js:168-178` constructs a `sessions` record containing:

- Request ID.
- Start and end times.
- Username.
- Target account ID.
- Permission-set name.
- Approver IDs.

The browser calls the generated `createSessions` mutation. A DynamoDB stream then passes these values directly to `teamgetLogs`.

`amplify/backend/function/teamgetLogs/src/index.js:136-145` trusts all those values and inserts them into the organization-wide Lake query:

```javascript
const startTime = event["startTime"]["S"];
const endTime = event["endTime"]["S"];
const username = event["username"]["S"].replace("idc_", "");
const accountId = event["accountId"]["S"];
const role = event["role"]["S"];

QueryStatement: `... '${startTime}' ... '${endTime}'
  ... '%:${username}%'
  ... '%${role}%'
  ... '${accountId}'`
```

There is no server-side lookup proving that:

- The session record corresponds to a real TEAM request.
- The caller owns or may approve that request.
- The account, user, role, and times equal the request's canonical values.
- The request reached an approved or active state.

### Potential current attack path

An authenticated TEAM user can bypass the React UI and invoke `createSessions` directly. Because the model has an implicit owner authorization rule, the caller can own the new session-query record while supplying a different `username`, `accountId`, `role`, and time range.

The Lambda then executes that query using its organization-wide CloudTrail Lake permissions. SQL wildcard or quote characters in those fields might also broaden or alter the query.

The resulting disclosure is limited to the four selected fields, but it can still reveal which organization API operations were performed, by which services, and when.

### Migration relationship

CloudWatch `StartQuery` receives start and end times as separate API parameters, eliminating interpolation for timestamps. It does not solve the other filters automatically. If account, username, or role remain client-controlled and are inserted into Logs Insights QL, the underlying authorization problem remains.

The replacement must accept only `requestId`, load the request server-side, authorize the caller, and derive every filter from that record.

## 2. Query IDs are not authorization

### Current behavior

The GraphQL operation is:

```graphql
getLogs(queryId: String): [Logs]
  @function(name: "teamqueryLogs-${env}")
  @auth(rules: [{ allow: private }])
```

This authorizes every authenticated TEAM user to call the resolver. `teamqueryLogs` receives only a query ID and immediately calls CloudTrail:

```javascript
const queryId = event["arguments"]["queryId"];
return get_query(queryId);
```

It never checks the corresponding request, requester, approver list, or Auditor group.

### Impact

A query ID acts as an unintended bearer token: possession is sufficient to retrieve its result. Query IDs are difficult to guess, but secrecy of an opaque identifier is not authorization.

Query IDs can potentially be obtained through:

- The incorrectly scoped subscription.
- Read access to a session-query record.
- Application or browser logs.
- Operational troubleshooting logs.
- Accidental sharing.

### Migration relationship

CloudWatch query IDs are also opaque identifiers. Replacing the service does not fix this.

The application must store a server-owned mapping:

```text
query ID -> request ID -> authorized requester, approvers, and auditors
```

Every status and result request must verify that mapping. The browser should not be allowed to submit an arbitrary CloudWatch query ID and retrieve it without context.

## 3. The AppSync subscription appears unscoped

### Confirmed source mismatch

The generated operation in `src/graphql/subscriptions.js` expects:

```graphql
subscription OnUpdateSessions($id: String) {
  onUpdateSessions(id: $id) {
    ...
  }
}
```

However, `src/components/Sessions/Logs.js:227-236` supplies:

```javascript
graphqlOperation(onUpdateSessions, {
  filter: {
    id: { eq: props.item.id },
  },
})
```

No `$id` value is passed.

### Likely runtime behavior

GraphQL clients generally ignore variables that are not declared by the operation. Therefore `filter` is ignored and `$id` remains absent. AppSync normally treats an omitted subscription argument as unfiltered, meaning the client may receive all `updateSessions` events permitted by the subscription's broad `private` authorization.

When any update arrives, the component executes:

```javascript
getLogs(value.data.onUpdateSessions.queryId);
```

It then adds metadata from the request currently displayed. Consequently, an unrelated query could be displayed under the wrong username and account and could expose another request's activity.

The argument mismatch is definite. The exact broadcast behavior should be confirmed with an AppSync integration test because it depends on the deployed schema and generated resolvers.

### Migration relationship

This is not caused by CloudWatch. The recommended start-and-status polling API eliminates this subscription. If subscriptions are retained, the client must pass `{ id: props.item.id }`, and authorization must still be enforced server-side.

## 4. DynamoDB stream batches lose work

### Current behavior

The event-source mapping in `amplify/backend/function/teamgetLogs/teamgetLogs-cloudformation-template.json` permits:

```json
"BatchSize": 100
```

The handler processes only one record:

```javascript
let data = event["Records"].pop();
```

### Impact

If Lambda receives ten INSERT records in one invocation:

1. The last record starts a query.
2. The other nine records are ignored.
3. The function returns success.
4. DynamoDB Streams advances the checkpoint for the complete batch.
5. The ignored session queries are not retried.

This can be invisible in low-volume testing because invocations often contain one record. It becomes more likely when several users inspect logs concurrently.

### Migration relationship

It persists if the DynamoDB stream architecture is retained. Either process every record with partial-batch failure reporting or, preferably, remove this indirect path and start the query through an authenticated AppSync Lambda resolver.

## 5. Query polling is unbounded and does not handle failures

### Current behavior

`teamgetLogs` repeatedly executes:

```javascript
let status = await get_query_status(queryId);
while (status) {
  status = await get_query_status(queryId);
  if (status === "FINISHED") {
    // Update the session query record.
    return response;
  }
}
```

There is:

- No delay or backoff.
- No maximum attempt count.
- No cancellation handling.
- No failed-query handling.
- No timeout-state handling.
- No Lambda remaining-time check.

### Impact

A terminal status other than `FINISHED` remains a non-empty string, so the loop continues until the Lambda times out. Rapid polling can also throttle the CloudTrail API and increases Lambda duration and cost.

After timeout, the session record does not receive a usable query ID, and the UI can remain in a loading state without an actionable explanation.

### Migration relationship

This code cannot be copied directly because CloudWatch does not use Lake's `DescribeQuery` operation. CloudWatch exposes query status through `GetQueryResults`, with statuses such as `Scheduled`, `Running`, `Complete`, `Failed`, `Cancelled`, and `Timeout`.

The recommended design starts the query, returns immediately, and lets the authenticated UI poll with bounded backoff.

## 6. Error handling converts failures into missing data

Both audit Lambdas catch errors and generally return `undefined`:

```javascript
catch (err) {
  console.log("Error", err);
}
```

Examples include:

- Failure to start a query.
- Invalid SQL.
- Access denied.
- Throttling.
- Event data store not found.
- Failed result retrieval.

The frontend often interprets this as no data rather than a failed query. This distinction is material for an auditor: “no API calls were made” and “the audit backend failed” must never look identical.

There is also a possible secondary exception in `teamgetLogs`:

```javascript
status: response.status
```

If `fetch()` failed before assigning `response`, the error handler dereferences `undefined`.

### Migration relationship

This exists today. CloudWatch adds more status states and pagination, so an untyped response would make the ambiguity worse. The API should explicitly return:

- Query status.
- A safe error code.
- Whether results are partial.
- Result count.
- Continuation token.

## 7. Audit content is duplicated into operational Lambda logs

### Current behavior

`teamgetLogs` logs the complete DynamoDB `NewImage`:

```javascript
console.log("Event", data);
```

This includes identifiers, target account, role, username, and query window.

`teamqueryLogs` logs the complete result array:

```javascript
console.log(output);
```

### Impact

Audit metadata is copied into the Lambda's operational CloudWatch log group, potentially with:

- A different retention period.
- A larger operational audience.
- Different export or subscription rules.
- Less explicit audit-data governance.

It also increases log-ingestion costs.

### Migration relationship

This is already present. Moving the primary audit store to CloudWatch makes the duplication more confusing but does not create it. Replace these logs with structured, non-sensitive fields such as query status, elapsed time, and result count. Do not log query text, event rows, usernames, or account IDs.

## 8. Historical activity is not reliably historical

### Current behavior

For a TEAM-created event data store:

```json
"RetentionPeriod": 7
```

However, the query is not created at session completion. It is created only when someone opens the activity panel.

For an ended request:

- The first query result is cached through its query ID.
- The `sessions` item receives a five-day TTL.
- The ended-session UI has no refresh button.
- The query does not rerun while that cache entry exists.

### Consequences

- If the activity panel is first opened more than seven days after the event, the internally managed event data store may no longer contain it.
- If the panel is opened immediately after the session, delayed CloudTrail events might not yet be present.
- Those missing events remain absent from the cached query result.
- The UI can continue showing the incomplete result for up to five days.
- The documentation's promise of historical session activity is stronger than the default retention actually supports.

Deployments using an external EDS ARN may have longer retention, so the seven-day finding is conditional on TEAM creating the event data store.

### Migration relationship

This exists today. CloudWatch provides an opportunity to define retention from an explicit audit requirement and to store query metadata such as `completedAt` and `refreshedAt`. Completed requests should support a controlled refresh until the expected CloudTrail delivery window has elapsed.

## 9. The audit window is wrong when session duration is not one hour

### Current behavior

For ended sessions, the browser uses:

```javascript
const endTime =
  new Date(Date.parse(props.item.endTime) + 60 * 60 * 1000).toISOString();
```

TEAM already retrieves the permission set's real duration and stores it in `requests.session_duration`:

```python
session_duration = permission_set.get("SessionDuration")
```

The audit UI does not use it.

### Impact

- A permission set with a session duration longer than one hour can produce valid activity that TEAM omits.
- A duration shorter than one hour causes TEAM to query a wider period than necessary.
- The wider period can attribute unrelated later activity by the same user, account, and role to the old request.

### Migration relationship

This is already present. CloudWatch `StartQuery` makes the time window an explicit API input, but the application must still calculate the correct end. It should use:

```text
assignment removal time + requests.session_duration
```

with a documented fallback for older requests missing that field.

## 10. Identity and permission-set matching is approximate

### Current matching

```sql
lower(useridentity.principalId) LIKE '%:<username>%'
AND sessionIssuer.arn LIKE '%<role>%'
```

Problems include:

- The username input itself is not lowercased even though the CloudTrail field is.
- `.replace("idc_", "")` removes the first occurrence anywhere, not necessarily a known prefix.
- Username substring matching can match a longer session name.
- `Admin` can match `AdminReadOnly`.
- Identity-provider and session-name behavior can vary.
- Simultaneous sessions using the same identity and permission set cannot be distinguished.

### Migration relationship

This is a limitation of the existing correlation logic, not CloudTrail Lake specifically. CloudWatch receives the same CloudTrail identity fields.

The replacement should parse the role session into an exact session-name field and match the complete Identity Center role-name structure:

```text
AWSReservedSSO_<validated-permission-set-name>_<generated-suffix>
```

Even after that, TEAM cannot prove which assignment enabled an event when identical sessions overlap. That residual limitation should be documented.

## 11. Event coverage is narrower than the product wording suggests

The internally created event data store explicitly selects management events. It does not enable CloudTrail data events.

TEAM therefore generally captures operations such as:

- IAM changes.
- EC2 control-plane operations.
- CloudFormation stack actions.
- S3 bucket configuration changes.

It generally does not capture data-plane operations such as:

- S3 object reads and writes.
- DynamoDB item API calls.
- Lambda function invocations.
- Many high-volume resource-level operations.

### Migration relationship

This is an existing limitation and may be intentional because data events can be expensive. The CloudWatch telemetry rule should initially preserve management-event behavior. Expanding to data events is a separate audit-scope and cost decision, not an incidental migration change.

## 12. Results are loaded without application-level pagination

`teamqueryLogs` aggregates every Lake page into one in-memory array. AppSync then returns the complete array, and React performs pagination locally.

A high-activity session can therefore encounter:

- Lambda memory pressure.
- Lambda response-size limits.
- AppSync response-size limits.
- Browser memory and rendering cost.
- Large CSV generation in the browser.

### Migration relationship

This issue exists today. CloudWatch makes it more visible because `GetQueryResults` returns at most 10,000 rows per page and uses `nextToken`. The new GraphQL API should expose server-side pagination instead of aggregating up to 100,000 events into one response.

## 13. Audit collection is coupled to the application lifecycle

The CloudTrail Lake event data store is created inside the Amplify backend and has:

```json
"TerminationProtectionEnabled": false
```

Deleting or replacing the Amplify environment can remove the audit collection resource. Organization-level audit infrastructure generally has a broader lifecycle and ownership model than one application environment.

### Migration relationship

This is an existing operational risk. It would become a newly repeated risk if the CloudWatch organization telemetry and centralization rules were placed in the same disposable Amplify stack.

The organization-level resources should live in a separate stack. TEAM should consume a private central log-group ARN.

## Risks specific to the CloudWatch migration

The following risks are not present in the current implementation because the migration has not occurred yet.

### Coverage gaps during activation

Telemetry discovery can take time, and centralization copies only events arriving after its rule exists. An incorrect deployment sequence can leave an audit gap.

Create centralization before live ingestion where possible, wait for telemetry-rule compliance, and run Lake and CloudWatch concurrently during validation.

### Missing Regions

CloudTrail Lake currently uses multi-Region ingestion. CloudWatch ingestion and centralization must cover every relevant Region. The telemetry rule can target all supported Regions, but the centralization rule requires a source-Region list that must remain current.

### Raw versus OCSF schema mismatch

TEAM currently queries raw CloudTrail field names. Enabling OCSF normalization without rewriting the query and GraphQL mappings would return no results or incorrectly mapped results.

Keep the raw schema for the initial migration and evaluate OCSF separately.

### Status incompatibility

Lake's `FINISHED` status becomes CloudWatch's `Complete`. CloudWatch exposes status through `GetQueryResults`; there is no direct CloudWatch equivalent of Lake's `DescribeQuery` call.

### Result-shape incompatibility

CloudWatch returns each result as an array of `{ field, value }` objects. The current Lake mapper expects different row objects. A direct client replacement will not produce the GraphQL `Logs` shape.

### Historical Infrequent Access selection

Imported Lake history uses an Infrequent Access log group. A Logs Insights `SOURCE` expression that implicitly selects only Standard groups can omit historical data. Query the imported group explicitly or include the appropriate class.

### Duplicate events

A historical-import range that overlaps live CloudWatch ingestion can return the same CloudTrail event twice. Preserve a cutover timestamp and deduplicate by `eventID`.

### Centralization and KMS failures

Incorrect destination encryption, key policy, source-group strategy, or service-linked-role permissions can stop centralization while source-account ingestion continues. Monitor rule health and perform end-to-end event checks, not only source-group checks.

### Retention mismatch

Source managed groups, central destination groups, and imported historical groups can have different retention and storage classes. Define and verify each separately.

### Query limits and cost changes

CloudWatch has explicit concurrency, timeout, pagination, and bytes-scanned considerations. A query design that dynamically selects too many groups or repeatedly scans a long organization-wide window can become expensive or fail service limits.

## Required remediation during migration

The migration should:

1. Replace browser-supplied query criteria with server-derived request data.
2. Bind every query ID to an authorized TEAM request.
3. Verify requester, authorized approver, or Auditor access for every operation.
4. Replace the broad subscription with authenticated status polling.
5. Introduce explicit running, complete, failed, cancelled, and timed-out states.
6. Add server-side result pagination.
7. Use the real permission-set session duration.
8. Match the complete Identity Center role structure.
9. Stop logging query criteria and audit-event contents.
10. Set retention from an explicit audit requirement.
11. Separate organization audit infrastructure from the Amplify application lifecycle.
12. Preserve management-event scope and raw CloudTrail schema initially.

## Conclusion

The migration does not create the major security defects. It provides the appropriate point to remove them. A service-only substitution would migrate the datastore while leaving the most important security, correctness, and operability problems in the deployed solution.