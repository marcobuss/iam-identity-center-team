// @ts-check
import { initSchema } from '@aws-amplify/datastore';
import { schema } from './schema';

const AuditQueryStatus = {
  "QUEUED": "QUEUED",
  "STARTING": "STARTING",
  "RUNNING": "RUNNING",
  "COMPLETE": "COMPLETE",
  "FAILED": "FAILED",
  "CANCELLED": "CANCELLED",
  "TIMEOUT": "TIMEOUT",
  "UNKNOWN": "UNKNOWN"
};

const { requests, sessions, Approvers, Settings, Eligibility, OUAccountsCache, data, Accounts, OUAccounts, OUAccountsBatch, InvalidateCacheResult, RequestValidationResult, Entitlement, IdCGroups, Users, AuditQueryState, AuditLogPage, Logs, OU, Groups, Members, Permissions, MgmtPs, Policy, OUs, Permission } = initSchema(schema);

export {
  requests,
  sessions,
  Approvers,
  Settings,
  Eligibility,
  OUAccountsCache,
  AuditQueryStatus,
  data,
  Accounts,
  OUAccounts,
  OUAccountsBatch,
  InvalidateCacheResult,
  RequestValidationResult,
  Entitlement,
  IdCGroups,
  Users,
  AuditQueryState,
  AuditLogPage,
  Logs,
  OU,
  Groups,
  Members,
  Permissions,
  MgmtPs,
  Policy,
  OUs,
  Permission
};