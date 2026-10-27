// © 2021 Amazon Web Services, Inc. or its affiliates. All Rights Reserved.
// This AWS Content is provided subject to the terms of the AWS Customer Agreement available at
// http://aws.amazon.com/agreement or other written agreement between Customer and either
// Amazon Web Services, Inc. or Amazon Web Services EMEA SARL or both.

const fs = require("fs");
const path = require("path");

const {
  AMPLIFY_CUSTOM_DOMAIN,
  AUDIT_LOG_GROUP_ARN,
  AUDIT_REGION,
  AWS_APP_ID,
  AWS_BRANCH,
  SSO_LOGIN,
  TAGS,
  TEAM_ACCOUNT,
  TEAM_ADMIN_GROUP,
  TEAM_AUDITOR_GROUP,
} = process.env;

/** Write formatted JSON to a repository-relative path. */
function writeJson(relativePath, value) {
  fs.writeFileSync(path.resolve(relativePath), JSON.stringify(value, null, 4));
}

/** Update Cognito callback and logout URLs for the namespaced Amplify branch. */
function updateAuthParameters() {
  const backendConfig = require(path.resolve("./amplify/backend/backend-config.json"));
  const authResourceName = Object.keys(backendConfig.auth)[0];
  const relativePath = `./amplify/backend/auth/${authResourceName}/cli-inputs.json`;
  const authParameters = require(path.resolve(relativePath));
  const oauthMetadata = JSON.parse(authParameters.cognitoConfig.oAuthMetadata);
  const amplifyDomain = AMPLIFY_CUSTOM_DOMAIN
    ? `https://${AMPLIFY_CUSTOM_DOMAIN}/`
    : `https://${AWS_BRANCH}.${AWS_APP_ID}.amplifyapp.com/`;

  oauthMetadata.CallbackURLs = [amplifyDomain];
  oauthMetadata.LogoutURLs = [amplifyDomain];
  authParameters.cognitoConfig.oAuthMetadata = JSON.stringify(oauthMetadata);
  authParameters.cognitoConfig.hostedUIDomainName = AWS_APP_ID;
  writeJson(relativePath, authParameters);
}

/** Update browser-facing deployment values. */
function updateReactParameters() {
  const relativePath = "./src/parameters.json";
  const reactParameters = require(path.resolve(relativePath));
  reactParameters.Login = SSO_LOGIN;
  reactParameters.DeploymentType = TEAM_ACCOUNT === undefined ? "management" : "delegated";
  reactParameters.teamAdminGroup = TEAM_ADMIN_GROUP;
  reactParameters.teamAuditorGroup = TEAM_AUDITOR_GROUP;
  writeJson(relativePath, reactParameters);
}

/** Update pre-token-generation group names. */
function updateGroupParameters() {
  const relativePath = "./amplify/backend/function/team06dbb7fcPreTokenGeneration/parameters.json";
  const groupParameters = require(path.resolve(relativePath));
  groupParameters.teamAdminGroup = TEAM_ADMIN_GROUP;
  groupParameters.teamAuditorGroup = TEAM_AUDITOR_GROUP;
  writeJson(relativePath, groupParameters);
}

/** Update the IAM Identity Center portal URL used in notifications. */
function updateRouterParameters() {
  const relativePath = "./amplify/backend/function/teamRouter/parameters.json";
  const routerParameters = require(path.resolve(relativePath));
  routerParameters.SSOLoginUrl = SSO_LOGIN;
  writeJson(relativePath, routerParameters);
}

/** Update common Amplify resource tags. */
function updateTagParameters() {
  const tags = TAGS
    ? TAGS.split(" ").map((tag) => {
      const [Key, Value] = tag.split("=");
      return { Key, Value };
    })
    : [];
  writeJson("./amplify/backend/tags.json", tags);
}

/** Inject deployment-time CloudWatch audit configuration into both query Lambdas. */
function updateAuditParameters() {
  if (!AUDIT_LOG_GROUP_ARN || !AUDIT_REGION) {
    throw new Error("AUDIT_LOG_GROUP_ARN and AUDIT_REGION are required");
  }

  writeJson("./amplify/backend/function/teamgetLogs/parameters.json", {
    AuditLogGroupArn: AUDIT_LOG_GROUP_ARN,
    AuditRegion: AUDIT_REGION,
  });
  writeJson("./amplify/backend/function/teamqueryLogs/parameters.json", {
    AuditRegion: AUDIT_REGION,
  });
}

updateAuthParameters();
updateReactParameters();
updateGroupParameters();
updateRouterParameters();
updateTagParameters();
updateAuditParameters();
