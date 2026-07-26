import {
  AgentCoreApplication,
  AgentCoreMcp,
  AgentCorePaymentManager,
  AgentCorePaymentConnector,
  type AgentCoreProjectSpec,
  type AgentCoreMcpSpec,
  type CustomJWTAuthorizerConfig,
  type HarnessDeploymentConfig,
} from '@aws/agentcore-cdk';
import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/**
 * Harness deployment config: role-scoped fields (for IAM role + container build)
 * plus the full validated spec + its config directory so the L3 construct can
 * synthesize the AWS::BedrockAgentCore::Harness resource.
 */
export type HarnessConfig = HarnessDeploymentConfig;

export interface PaymentConnectorSpec {
  name: string;
  provider: 'CoinbaseCDP' | 'StripePrivy';
  credentialProviderArn: string;
}

export interface PaymentSpec {
  name: string;
  description?: string;
  authorizerType: 'AWS_IAM' | 'CUSTOM_JWT';
  authorizerConfiguration?: { customJWTAuthorizer: CustomJWTAuthorizerConfig };
  autoPayment?: boolean;
  paymentToolAllowlist?: string[];
  networkPreferences?: string[];
  connectors: PaymentConnectorSpec[];
}

export interface AgentCoreStackProps extends StackProps {
  /**
   * The AgentCore project specification containing agents, memories, and credentials.
   */
  spec: AgentCoreProjectSpec;
  /**
   * The MCP specification containing gateways and servers.
   */
  mcpSpec?: AgentCoreMcpSpec;
  /**
   * Credential provider ARNs from deployed state, keyed by credential name.
   */
  credentials?: Record<string, { credentialProviderArn: string; clientSecretArn?: string }>;
  /**
   * Harness role configurations.
   */
  harnesses?: HarnessConfig[];
  /**
   * Parsed connectorParameters for non-S3 KB data sources, keyed by
   * connectorConfigFile path. Forwarded to AgentCoreApplication.
   */
  connectorParametersByFile?: Record<string, Record<string, unknown>>;
  /**
   * Payment specifications with resolved credential provider ARNs.
   */
  paymentSpec?: PaymentSpec[];
}

function toCdkId(name: string): string {
  return name.replace(/_/g, '');
}

/**
 * Decide whether a deployed runtime should receive payment env vars + IAM grants.
 * Payments today only ships a runtime shim for Python HTTP runtimes; injecting
 * AGENTCORE_PAYMENT_* env vars into TypeScript / MCP / A2A / AGUI runtimes
 * would surface env vars they cannot consume and would dilute least-privilege
 * IAM grants for runtimes that never call ProcessPayment.
 */
function isPaymentEligibleAgent(agent: { entrypoint?: string; protocol?: string }): boolean {
  if (agent.protocol && agent.protocol !== 'HTTP') {
    return false;
  }
  const entrypoint = typeof agent.entrypoint === 'string' ? agent.entrypoint : '';
  const entrypointFile = entrypoint.split(':')[0] ?? '';
  return entrypointFile.endsWith('.py');
}

/**
 * IAM role ARNs that the AWS_MCP_Agent runtime's execution role is allowed to
 * assume for the mcp-proxy-for-aws Multi_Profile_Mode single-account role
 * switching setup (multi-account-mcp-access spec, single-account variant).
 *
 * These are pre-existing roles created manually by the operator (not managed
 * by this CDK stack): each trusts the AWS_MCP_Agent runtime execution role as
 * its Principal, and carries either AdministratorAccess or ReadOnlyAccess.
 * The mcp-proxy-for-aws stdio subprocess resolves named AWS CLI profiles
 * ("admin" / "readonly") that assume these roles via role_arn +
 * source_profile, so the Agent can switch between admin and read-only
 * permissions within the single AWS account this Runtime is deployed to.
 *
 * Not secrets — role ARNs are identifiers, not credentials (nothing can be
 * done with an ARN alone without also controlling the trusting principal).
 * Kept as an explicit constant here rather than externalized via env var or
 * aws-targets.json, per the project's "explicit configuration over implicit
 * convention" preference — there is currently only one deployment target.
 */
const MCP_AGENT_ASSUMABLE_ROLE_ARNS = [
  'arn:aws:iam::<YOUR_AWS_ACCOUNT_ID>:role/AgentMCPReadOnlyRole',
  'arn:aws:iam::<YOUR_AWS_ACCOUNT_ID>:role/AgentMCPAdminRole',
];

/**
 * ARNs of the RoleConfig DynamoDB tables (Amplify Gen 2 Data_Model, see
 * role-set-switching spec) that each AWS_MCP_Agent runtime environment's
 * execution role needs read-only access to, in order to load the flat
 * Role_Entry list used for Role_Set selection.
 *
 * Keyed by runtime name (see agentcore.json's `runtimes` array) rather than
 * a single shared constant, because this project intentionally runs two
 * separate Runtime deployments off the same agent code -- `AWS_MCP_Agent`
 * (sandbox / local development, points at the `npx ampx sandbox`-generated
 * table) and `AWS_MCP_Agent_Prod` (points at the Amplify Hosting `main`
 * branch's table) -- so that changes can be tested against the sandbox
 * table without affecting the Runtime the production Amplify Hosting app
 * actually calls. Each runtime's `ROLE_CONFIG_TABLE_NAME` env var (set in
 * agentcore.json) MUST match the table name embedded in its corresponding
 * ARN here.
 *
 * The actual table ARNs are only known after the corresponding Amplify
 * backend has been deployed (Amplify Gen 2 generates the DynamoDB table and
 * its ARN at deploy time; it cannot be predicted in this CDK stack ahead of
 * that deployment). If you redeploy the Amplify backend to a new AppSync
 * API (e.g. a fresh `npx ampx sandbox` or a new Amplify app), update the
 * corresponding entry here and redeploy this CDK stack (`agentcore deploy`).
 */
const ROLE_CONFIG_TABLE_ARN_BY_RUNTIME: Record<string, string> = {
  AWS_MCP_Agent: 'arn:aws:dynamodb:us-west-2:<YOUR_AWS_ACCOUNT_ID>:table/RoleConfig-<SANDBOX_APPSYNC_API_ID>-NONE',
  AWS_MCP_Agent_Prod: 'arn:aws:dynamodb:us-west-2:<YOUR_AWS_ACCOUNT_ID>:table/RoleConfig-<PROD_APPSYNC_API_ID>-NONE',
};

/**
 * CDK Stack that deploys AgentCore infrastructure.
 *
 * This is a thin wrapper that instantiates L3 constructs.
 * All resource logic and outputs are contained within the L3 constructs.
 */
export class AgentCoreStack extends Stack {
  /** The AgentCore application containing all agent environments */
  public readonly application: AgentCoreApplication;

  constructor(scope: Construct, id: string, props: AgentCoreStackProps) {
    super(scope, id, props);

    const { spec, mcpSpec, credentials, harnesses, connectorParametersByFile, paymentSpec } = props;

    // Create AgentCoreApplication with all agents and harness roles
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const appProps: Record<string, unknown> = { spec };
    if (harnesses?.length) {
      appProps.harnesses = harnesses;
    }
    if (connectorParametersByFile && Object.keys(connectorParametersByFile).length > 0) {
      appProps.connectorParametersByFile = connectorParametersByFile;
    }
    if (credentials) {
      appProps.credentials = credentials;
    }
    this.application = new AgentCoreApplication(this, 'Application', appProps as any);

    // Create AgentCoreMcp if there are gateways configured
    if (mcpSpec?.agentCoreGateways && mcpSpec.agentCoreGateways.length > 0) {
      new AgentCoreMcp(this, 'Mcp', {
        projectName: spec.name,
        mcpSpec,
        agentCoreApplication: this.application,
        credentials,
        projectTags: spec.tags,
      });
    }

    // Grant every AWS_MCP_Agent* runtime environment's execution role
    // permission to assume the pre-provisioned admin/read-only roles for
    // single-account role switching via mcp-proxy-for-aws Multi_Profile_Mode,
    // and read-only access to that runtime's corresponding RoleConfig
    // DynamoDB table. Both `AWS_MCP_Agent` (sandbox) and `AWS_MCP_Agent_Prod`
    // (Amplify Hosting `main`) need identical AssumeRole permissions (the
    // target IAM roles are the same regardless of which RoleConfig table
    // lists them), but each needs a *different* DynamoDB table ARN --
    // see ROLE_CONFIG_TABLE_ARN_BY_RUNTIME for why.
    for (const [runtimeName, mcpAgentEnv] of this.application.environments) {
      if (!runtimeName.startsWith('AWS_MCP_Agent')) {
        continue;
      }

      mcpAgentEnv.runtime.addToPolicy(
        new iam.PolicyStatement({
          actions: ['sts:AssumeRole'],
          resources: MCP_AGENT_ASSUMABLE_ROLE_ARNS,
        })
      );

      // Grant read-only access to this runtime's RoleConfig DynamoDB table
      // so it can load the Role_Set Role_Entry list (role-set-switching
      // spec, Requirement 1.2). Only dynamodb:Scan is granted — no
      // PutItem/UpdateItem/DeleteItem, since writes to Role_Config are
      // performed exclusively by ADMINS users through the Amplify Data
      // Model's GraphQL API, not by this runtime.
      const tableArn = ROLE_CONFIG_TABLE_ARN_BY_RUNTIME[runtimeName];
      if (tableArn) {
        mcpAgentEnv.runtime.addToPolicy(
          new iam.PolicyStatement({
            actions: ['dynamodb:Scan'],
            resources: [tableArn],
          })
        );
      }
    }

    // Create payment infrastructure via CFN constructs
    if (paymentSpec && paymentSpec.length > 0) {
      for (const payment of paymentSpec) {
        const mgrId = toCdkId(payment.name);
        const manager = new AgentCorePaymentManager(this, `Payment${mgrId}`, {
          projectName: spec.name,
          name: payment.name,
          authorizerType: payment.authorizerType,
          description: payment.description,
          authorizerConfiguration: payment.authorizerConfiguration,
          tags: spec.tags,
        });

        const prefix = `AGENTCORE_PAYMENT_${payment.name.toUpperCase().replace(/-/g, '_')}`;

        // Wire env vars from construct output tokens into eligible agent environments only.
        // See isPaymentEligibleAgent — non-Python or non-HTTP runtimes have no shim that
        // can consume these env vars, and giving them sts:AssumeRole on the
        // ProcessPaymentRole would broaden the privilege surface unnecessarily.
        for (const env of this.application.environments.values()) {
          if (!isPaymentEligibleAgent(env.agent)) {
            continue;
          }
          env.runtime.addEnvironmentVariable(`${prefix}_MANAGER_ARN`, manager.paymentManagerArn);
          env.runtime.addEnvironmentVariable(`${prefix}_PROCESS_PAYMENT_ROLE_ARN`, manager.processPaymentRoleArn);

          // Grant runtime execution role permission to assume the ProcessPaymentRole.
          // The ProcessPaymentRole's trust policy allows AccountRootPrincipal, but the
          // caller still needs sts:AssumeRole on its own role to perform the assumption.
          env.runtime.role.addToPrincipalPolicy(
            new iam.PolicyStatement({
              actions: ['sts:AssumeRole'],
              resources: [manager.processPaymentRoleArn],
            })
          );

          // Grant payment data-plane actions directly to the runtime role.
          //
          // NOTE: This deviates from the canonical role model in the AgentCore Payments
          // beta guide, which assigns Get/List/Create instrument+session actions to a
          // separate ManagementRole and limits the agent's role to ProcessPayment only.
          // The current SDK plugin (AgentCorePaymentsPlugin.generate_payment_header)
          // calls GetPaymentInstrument internally during the 402 auto-pay path, so the
          // runtime role needs read access. CreatePaymentSession is included so
          // `agentcore invoke --auto-session` works without a separate ManagementRole
          // call. Tighten this if the SDK is updated to accept pre-fetched instrument
          // details and split create-session into a backend-only flow.
          env.runtime.role.addToPrincipalPolicy(
            new iam.PolicyStatement({
              actions: [
                'bedrock-agentcore:GetPaymentInstrument',
                'bedrock-agentcore:ListPaymentInstruments',
                'bedrock-agentcore:GetPaymentInstrumentBalance',
                'bedrock-agentcore:GetPaymentSession',
                'bedrock-agentcore:ListPaymentSessions',
                'bedrock-agentcore:CreatePaymentSession',
                'bedrock-agentcore:ProcessPayment',
              ],
              resources: [manager.paymentManagerArn, `${manager.paymentManagerArn}/*`],
            })
          );

          if (payment.autoPayment !== undefined) {
            env.runtime.addEnvironmentVariable(`${prefix}_AUTO_PAYMENT`, String(payment.autoPayment));
          }
          if (payment.paymentToolAllowlist) {
            env.runtime.addEnvironmentVariable(`${prefix}_TOOL_ALLOWLIST`, payment.paymentToolAllowlist.join(','));
          }
          if (payment.networkPreferences) {
            env.runtime.addEnvironmentVariable(`${prefix}_NETWORK_PREFERENCES`, payment.networkPreferences.join(','));
          }
          if (payment.authorizerType === 'CUSTOM_JWT') {
            env.runtime.addEnvironmentVariable(`${prefix}_AUTH_MODE`, 'bearer');
          }
        }

        // Create connectors for this manager
        for (const connector of payment.connectors) {
          const connId = toCdkId(connector.name);
          const conn = new AgentCorePaymentConnector(this, `Payment${mgrId}${connId}`, {
            projectName: spec.name,
            paymentManager: manager,
            connectorName: connector.name,
            connectorType: connector.provider,
            credentialProviderArn: connector.credentialProviderArn,
          });

          // Wire first connector's ID as env var (eligible agents only)
          if (connector === payment.connectors[0]) {
            for (const env of this.application.environments.values()) {
              if (!isPaymentEligibleAgent(env.agent)) continue;
              env.runtime.addEnvironmentVariable(`${prefix}_CONNECTOR_ID`, conn.paymentConnectorId);
            }
          }

          new CfnOutput(this, `Payment${mgrId}${connId}ConnectorId`, {
            value: conn.paymentConnectorId,
          });
        }

        // CFN Outputs for post-deploy state parsing
        new CfnOutput(this, `Payment${mgrId}ManagerArn`, {
          value: manager.paymentManagerArn,
        });
        new CfnOutput(this, `Payment${mgrId}ManagerId`, {
          value: manager.paymentManagerId,
        });
        new CfnOutput(this, `Payment${mgrId}ProcessPaymentRoleArn`, {
          value: manager.processPaymentRoleArn,
        });
        new CfnOutput(this, `Payment${mgrId}ResourceRetrievalRoleArn`, {
          value: manager.resourceRetrievalRoleArn,
        });
      }
    }

    // Stack-level output
    new CfnOutput(this, 'StackNameOutput', {
      description: 'Name of the CloudFormation Stack',
      value: this.stackName,
    });
  }
}
