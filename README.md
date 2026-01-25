# QuickBooks MCP Server

A Model Context Protocol (MCP) server that provides Claude with access to QuickBooks Online data. Enables querying customers, invoices, accounts, transactions, and more through natural language.

## How This Differs from Intuit's Official Server

Intuit provides an [official MCP server](https://github.com/intuit/quickbooks-online-mcp-server) for learning and experimentation. This community server is designed for **production use** with additional features:

| Feature | Intuit Official | This Server |
|---------|-----------------|-------------|
| Environment | Sandbox only | Production + Sandbox |
| Credential Storage | Local `.env` file | Local file or AWS Secrets Manager |
| Financial Reports | No | P&L, Balance Sheet, Trial Balance |
| Query Style | Entity-specific tools | Generic SQL-like queries |
| Distribution | Clone from GitHub | NPM package (`npx quickbooks-mcp`) |
| Multi-user Support | No | Yes (via AWS mode) |

**Use Intuit's server** if you're learning the QuickBooks API in a sandbox environment.

**Use this server** if you need production access, financial reports, or shared credential management.

## Prerequisites

- **QuickBooks Developer Account**: Register at [developer.intuit.com](https://developer.intuit.com)
- **Node.js 18+**

## Installation Options

Choose the setup that fits your use case:

| Setup | Best For |
|-------|----------|
| [NPM Install](#option-1-npm-install) | Quick setup, using your own QuickBooks app |
| [Local Checkout](#option-2-local-checkout) | Development, customization |
| [AWS Mode](#option-3-aws-mode) | Shared/production environments |

---

## Option 1: NPM Install

The simplest way to get started. Credentials are stored locally on your machine.

### 1. Create a QuickBooks App

1. Go to [developer.intuit.com](https://developer.intuit.com) and sign in
2. Create a new app (or select an existing one)
3. Go to "Keys & credentials"
4. Note your **Client ID** and **Client Secret**
5. Under "Redirect URIs", add: `https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl`

### 2. Add to Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "quickbooks": {
      "command": "npx",
      "args": ["-y", "quickbooks-mcp"]
    }
  }
}
```

### 3. Configure Credentials

Create `~/.quickbooks-mcp/credentials.json`:

```json
{
  "client_id": "your_client_id",
  "client_secret": "your_client_secret"
}
```

### 4. Authenticate

Once Claude Code is running, use the `qbo_authenticate` tool:

1. Call `qbo_authenticate` with no arguments to get an authorization URL
2. Open the URL in your browser and authorize the app
3. Copy the `code` and `realmId` from the redirect URL
4. Call `qbo_authenticate` again with the authorization code and realm ID

Your OAuth tokens will be saved and automatically refreshed.

---

## Option 2: Local Checkout

For development or customization.

### 1. Create a QuickBooks App

Follow the same steps as Option 1 above.

### 2. Clone and Build

```bash
git clone https://github.com/laf-rge/quickbooks-mcp.git
cd quickbooks-mcp
npm install
npm run build
```

### 3. Add to Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "quickbooks": {
      "command": "node",
      "args": ["/path/to/quickbooks-mcp/dist/index.js"]
    }
  }
}
```

### 4. Configure Credentials

Create `~/.quickbooks-mcp/credentials.json` with your client credentials (same as Option 1), then run `qbo_authenticate` to complete the OAuth flow.

---

## Option 3: AWS Mode

For shared or production environments. Stores credentials in AWS Secrets Manager.

### 1. Create AWS Resources

**Create the secret in Secrets Manager:**

```bash
aws secretsmanager create-secret \
  --name prod/qbo \
  --secret-string '{
    "client_id": "your_client_id",
    "client_secret": "your_client_secret",
    "access_token": "your_access_token",
    "refresh_token": "your_refresh_token",
    "redirect_url": "https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl"
  }'
```

**Store Company ID in SSM Parameter Store:**

```bash
aws ssm put-parameter \
  --name /prod/qbo/company_id \
  --value "your_company_id" \
  --type SecureString
```

### 2. Configure the Server

Create a `.env` file in the quickbooks-mcp directory:

```bash
QBO_CREDENTIAL_MODE=aws
AWS_REGION=us-east-2
QBO_SECRET_NAME=prod/qbo
QBO_COMPANY_ID_PARAM=/prod/qbo/company_id
```

> **Note**: Due to a [known Claude Code bug](https://github.com/anthropics/claude-code/issues/1254), environment variables from `.mcp.json` are not reliably passed to MCP servers. The `.env` file workaround is required.

### 3. Add to Claude Code

```json
{
  "mcpServers": {
    "quickbooks": {
      "command": "node",
      "args": ["/path/to/quickbooks-mcp/dist/index.js"]
    }
  }
}
```

### 4. IAM Permissions

The server needs these AWS permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue",
        "secretsmanager:PutSecretValue"
      ],
      "Resource": "arn:aws:secretsmanager:*:*:secret:prod/qbo*"
    },
    {
      "Effect": "Allow",
      "Action": ["ssm:GetParameter"],
      "Resource": "arn:aws:ssm:*:*:parameter/prod/qbo/*"
    }
  ]
}
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `QBO_CREDENTIAL_MODE` | `local` | Credential storage: `local` or `aws` |
| `QBO_CLIENT_ID` | - | QuickBooks app Client ID (local mode) |
| `QBO_CLIENT_SECRET` | - | QuickBooks app Client Secret (local mode) |
| `QBO_CREDENTIAL_FILE` | `~/.quickbooks-mcp/credentials.json` | Custom credential file path |
| `QBO_SANDBOX` | `false` | Use QuickBooks sandbox environment |
| `AWS_REGION` | `us-east-2` | AWS region (aws mode) |
| `QBO_SECRET_NAME` | `prod/qbo` | Secrets Manager secret name (aws mode) |
| `QBO_COMPANY_ID_PARAM` | `/prod/qbo/company_id` | SSM parameter path (aws mode) |

---

## Available Tools

| Tool | Description |
|------|-------------|
| `qbo_authenticate` | Set up OAuth credentials (local mode only) |
| `get_company_info` | Get connected company information |
| `query` | Run SQL-like queries against QuickBooks |
| `list_accounts` | List chart of accounts |
| `get_profit_loss` | Get Profit & Loss report |
| `get_balance_sheet` | Get Balance Sheet report |
| `get_trial_balance` | Get Trial Balance report |
| `query_account_transactions` | Query transactions for an account |
| `create_journal_entry` | Create a journal entry |
| `get_journal_entry` | Fetch a journal entry by ID |
| `edit_journal_entry` | Modify an existing journal entry |
| `get_bill` | Fetch a bill by ID |
| `edit_bill` | Modify an existing bill |
| `get_expense` | Fetch an expense by ID |
| `edit_expense` | Modify an existing expense |
| `get_sales_receipt` | Fetch a sales receipt by ID |
| `edit_sales_receipt` | Modify an existing sales receipt |
| `get_deposit` | Fetch a deposit by ID |
| `edit_deposit` | Modify an existing deposit |

---

## Token Refresh

The server automatically refreshes OAuth tokens on each request and persists them back to your credential store (local file or AWS Secrets Manager).

---

## Development

```bash
npm run dev      # Run in development mode
npm run build    # Build
npm run typecheck # Type check
```

---

## Troubleshooting

### "QuickBooks credentials not configured"

Run the `qbo_authenticate` tool to set up OAuth credentials (local mode only).

### "Authorization code expired"

Authorization codes are only valid for a few minutes. Start the OAuth flow again.

### Token refresh fails

- Check that your refresh token hasn't expired (~100 days)
- Verify your client credentials are correct
- Try re-authenticating with `qbo_authenticate`

### AWS credential errors

- Ensure `.env` file has `QBO_CREDENTIAL_MODE=aws`
- Check your AWS credentials and permissions
- Verify the secret and parameter names match your configuration
