// REST API endpoints for Google Sheets integration
//
// Security: Validates x-api-key header against REST_API_KEY env var.
// QBO credentials never leave this service — Apps Script only sends
// deposit data and receives confirmation.

import { getClient, clearCredentialsCache, isAuthError } from "./client/index.js";
import { getAccountCache } from "./client/cache.js";
import { handleCreateDeposit } from "./tools/handlers/deposit.js";

const REST_API_KEY = process.env.REST_API_KEY || "";

/** Validate the API key from request headers */
export function validateRestApiKey(apiKey: string | undefined | null): boolean {
  if (!REST_API_KEY) return false; // Deny all if no key configured
  return apiKey === REST_API_KEY;
}

/** GET /api/accounts — returns QBO accounts grouped by type */
export async function restListAccounts(): Promise<{
  statusCode: number;
  body: string;
}> {
  const fetchAccounts = async () => {
    const client = await getClient();
    const cache = await getAccountCache(client);
    const accounts = cache.items
      .filter((a) => a.Active !== false)
      .map((a) => ({
        id: a.Id,
        name: a.Name,
        fullName: a.FullyQualifiedName || a.Name,
        type: a.AccountType,
        subType: a.AccountSubType || "",
        acctNum: a.AcctNum || "",
      }));

    // Group by type for the UI
    const bank = accounts.filter((a) => a.type === "Bank");
    const income = accounts.filter((a) => a.type === "Income");
    const expense = accounts.filter((a) => a.type === "Expense");
    const cogs = accounts.filter((a) => a.type === "Cost of Goods Sold");
    const other = accounts.filter(
      (a) =>
        a.type !== "Bank" &&
        a.type !== "Income" &&
        a.type !== "Expense" &&
        a.type !== "Cost of Goods Sold"
    );

    return { bank, income, expense, cogs, other };
  };

  try {
    const grouped = await fetchAccounts();
    return { statusCode: 200, body: JSON.stringify(grouped) };
  } catch (error) {
    if (isAuthError(error)) {
      clearCredentialsCache();
      try {
        const grouped = await fetchAccounts();
        return { statusCode: 200, body: JSON.stringify(grouped) };
      } catch {
        return {
          statusCode: 401,
          body: JSON.stringify({ error: "QuickBooks authentication failed" }),
        };
      }
    }
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}

/** POST /api/deposit — creates a bank deposit in QBO */
export async function restCreateDeposit(body: {
  deposit_to_account: string;
  txn_date: string;
  lines: Array<{
    amount: number;
    account_name?: string;
    account_id?: string;
    description?: string;
  }>;
  memo?: string;
  department_name?: string;
}): Promise<{ statusCode: number; body: string }> {
  // Validate required fields
  if (!body.deposit_to_account) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "deposit_to_account is required" }),
    };
  }
  if (!body.txn_date) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "txn_date is required" }),
    };
  }
  if (!body.lines || body.lines.length === 0) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "At least one line is required" }),
    };
  }

  const createDeposit = async () => {
    const client = await getClient();
    return handleCreateDeposit(client, {
      ...body,
      draft: false,
    });
  };

  try {
    const result = await createDeposit();
    const text = result.content[0]?.text || "";
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: text }),
    };
  } catch (error) {
    if (isAuthError(error)) {
      clearCredentialsCache();
      try {
        const result = await createDeposit();
        const text = result.content[0]?.text || "";
        return {
          statusCode: 200,
          body: JSON.stringify({ success: true, message: text }),
        };
      } catch {
        return {
          statusCode: 401,
          body: JSON.stringify({ error: "QuickBooks authentication failed" }),
        };
      }
    }
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}
