// Handlers for invoice tools (create, get, edit)

import QuickBooks from "node-quickbooks";
import {
  promisify,
  getAccountCache,
  getDepartmentCache,
  resolveItem,
  resolveCustomer,
} from "../../client/index.js";
import { validateAmount, toDollars, formatDollars, sumCents, outputReport } from "../../utils/index.js";

interface InvoiceLineChange {
  line_id?: string;
  item_name?: string;
  item_id?: string;
  amount?: number;
  qty?: number;
  unit_price?: number;
  description?: string;
  delete?: boolean;
}

interface CreateInvoiceLine {
  item_name?: string;
  item_id?: string;
  amount?: number;
  qty?: number;
  unit_price?: number;
  description?: string;
}

export async function handleCreateInvoice(
  client: QuickBooks,
  args: {
    txn_date: string;
    customer_name?: string;
    customer_id?: string;
    due_date?: string;
    department_name?: string;
    department_id?: string;
    memo?: string;
    doc_number?: string;
    lines: CreateInvoiceLine[];
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const {
    txn_date, customer_name, customer_id,
    due_date, department_name, department_id,
    memo, doc_number, lines, draft = true,
  } = args;

  if (!lines || lines.length === 0) {
    throw new Error("At least one line is required");
  }

  // Resolve customer (required for invoices)
  if (!customer_id && !customer_name) {
    throw new Error("Either customer_name or customer_id is required for invoices");
  }
  let customerRef: { value: string; name: string };
  if (customer_id) {
    customerRef = await resolveCustomer(client, customer_id);
  } else {
    customerRef = await resolveCustomer(client, customer_name!);
  }

  // Resolve department (header-level, optional)
  let departmentRef: { value: string; name: string } | undefined;
  const deptInput = department_id || department_name;
  if (deptInput) {
    const deptCache = await getDepartmentCache(client);
    const byId = deptCache.byId.get(deptInput);
    if (byId) {
      departmentRef = { value: byId.Id, name: byId.FullyQualifiedName || byId.Name };
    } else {
      const byName = deptCache.byName.get(deptInput.toLowerCase());
      if (byName) {
        departmentRef = { value: byName.Id, name: byName.FullyQualifiedName || byName.Name };
      } else {
        const byPartial = deptCache.items.find(d =>
          d.FullyQualifiedName?.toLowerCase().includes(deptInput.toLowerCase())
        );
        if (byPartial) {
          departmentRef = { value: byPartial.Id, name: byPartial.FullyQualifiedName || byPartial.Name };
        } else {
          throw new Error(`Department not found: "${deptInput}"`);
        }
      }
    }
  }

  // Resolve lines
  const resolvedLines = await Promise.all(lines.map(async (line) => {
    const itemInput = line.item_name || line.item_id;
    if (!itemInput) {
      throw new Error("Each line must have either item_name or item_id");
    }
    if (line.amount === undefined && (line.qty === undefined || line.unit_price === undefined)) {
      throw new Error(`Line for "${itemInput}" requires amount, or both qty and unit_price`);
    }

    const itemRef = await resolveItem(client, itemInput);

    const qty = line.qty ?? 1;
    let amountCents: number;
    let unitPriceDollars: number;

    if (line.amount !== undefined) {
      amountCents = validateAmount(line.amount, `Line for ${itemRef.name}`);
      unitPriceDollars = toDollars(amountCents) / qty;
    } else {
      const upCents = validateAmount(line.unit_price!, `Line unit_price for ${itemRef.name}`);
      unitPriceDollars = toDollars(upCents);
      amountCents = upCents * qty;
    }

    return {
      itemRef,
      qty,
      unitPriceDollars,
      amountCents,
      amountDollars: toDollars(amountCents),
      description: line.description,
    };
  }));

  // Calculate total
  const totalCents = sumCents(resolvedLines.map(l => l.amountCents));

  // Build QuickBooks Invoice object
  const invObject: Record<string, unknown> = {
    TxnDate: txn_date,
    CustomerRef: customerRef,
    ...(due_date && { DueDate: due_date }),
    ...(departmentRef && { DepartmentRef: departmentRef }),
    ...(memo && { PrivateNote: memo }),
    ...(doc_number && { DocNumber: doc_number }),
    Line: resolvedLines.map((line) => ({
      Amount: line.amountDollars,
      DetailType: "SalesItemLineDetail",
      ...(line.description && { Description: line.description }),
      SalesItemLineDetail: {
        ItemRef: line.itemRef,
        Qty: line.qty,
        UnitPrice: line.unitPriceDollars,
      },
    })),
  };

  if (draft) {
    const preview = [
      "DRAFT - Invoice Preview",
      "",
      `Customer: ${customerRef.name}`,
      `Date: ${txn_date}`,
      `Due Date: ${due_date || "(none)"}`,
      `Ref no.: ${doc_number || "(auto-assign)"}`,
      `Department: ${departmentRef?.name || "(none)"}`,
      `Memo: ${memo || "(none)"}`,
      `Total: $${formatDollars(totalCents)}`,
      "",
      "Lines:",
      ...resolvedLines.map(l =>
        `  ${l.itemRef.name}: Qty ${l.qty} × $${l.unitPriceDollars.toFixed(2)} = $${l.amountDollars.toFixed(2)}${l.description ? ` "${l.description}"` : ""}`
      ),
      "",
      "Set draft=false to create this invoice.",
    ].join("\n");

    return {
      content: [{ type: "text", text: preview }],
    };
  }

  // Create the invoice
  const result = await promisify<unknown>((cb) =>
    client.createInvoice(invObject, cb)
  ) as { Id: string; DocNumber?: string };

  const qboUrl = `https://app.qbo.intuit.com/app/invoice?txnId=${result.Id}`;

  const response = [
    "Invoice Created!",
    "",
    `Customer: ${customerRef.name}`,
    `Ref no.: ${result.DocNumber || "(auto-assigned)"}`,
    `Date: ${txn_date}`,
    `Due Date: ${due_date || "(none)"}`,
    `Total: $${formatDollars(totalCents)}`,
    "",
    `View in QuickBooks: ${qboUrl}`,
  ].join("\n");

  return {
    content: [{ type: "text", text: response }],
  };
}

export async function handleGetInvoice(
  client: QuickBooks,
  args: { id: string }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { id } = args;

  const invoice = await promisify<unknown>((cb) =>
    client.getInvoice(id, cb)
  ) as {
    Id: string;
    SyncToken: string;
    TxnDate: string;
    DueDate?: string;
    DocNumber?: string;
    PrivateNote?: string;
    TotalAmt?: number;
    Balance?: number;
    CustomerRef?: { value: string; name?: string };
    DepartmentRef?: { value: string; name?: string };
    Line?: Array<{
      Id: string;
      Amount: number;
      Description?: string;
      DetailType: string;
      SalesItemLineDetail?: {
        ItemRef: { value: string; name?: string };
        Qty?: number;
        UnitPrice?: number;
        ItemAccountRef?: { value: string; name?: string };
        ClassRef?: { value: string; name?: string };
        TaxCodeRef?: { value: string; name?: string };
      };
    }>;
  };
  const qboUrl = `https://app.qbo.intuit.com/app/invoice?txnId=${invoice.Id}`;

  // Format summary
  const lines: string[] = [
    'Invoice',
    '=======',
    `ID: ${invoice.Id}`,
    `SyncToken: ${invoice.SyncToken}`,
    `Customer: ${invoice.CustomerRef?.name || invoice.CustomerRef?.value || '(none)'}`,
    `Date: ${invoice.TxnDate}`,
    `Due Date: ${invoice.DueDate || '(none)'}`,
    `Ref no.: ${invoice.DocNumber || '(none)'}`,
    `Department: ${invoice.DepartmentRef?.name || invoice.DepartmentRef?.value || '(none)'}`,
    `Memo: ${invoice.PrivateNote || '(none)'}`,
    `Total: $${(invoice.TotalAmt || 0).toFixed(2)}`,
    `Balance: $${(invoice.Balance || 0).toFixed(2)}`,
    '',
    'Lines:',
  ];

  for (const line of invoice.Line || []) {
    if (line.SalesItemLineDetail) {
      const detail = line.SalesItemLineDetail;
      const itemName = detail.ItemRef?.name || detail.ItemRef?.value || '(no item)';
      const qty = detail.Qty ?? 1;
      const unitPrice = detail.UnitPrice ?? line.Amount;
      const acctStr = detail.ItemAccountRef?.name ? ` → ${detail.ItemAccountRef.name}` : '';
      const descStr = line.Description ? ` "${line.Description}"` : '';
      lines.push(`  Line ${line.Id}: ${itemName} (Qty: ${qty} × $${unitPrice.toFixed(2)}) = $${line.Amount.toFixed(2)}${acctStr}${descStr}`);
    } else if (line.DetailType === 'SubTotalLineDetail') {
      lines.push(`  SubTotal: $${line.Amount.toFixed(2)}`);
    }
  }

  lines.push('');
  lines.push(`View in QuickBooks: ${qboUrl}`);

  return outputReport(`invoice-${invoice.Id}`, invoice, lines.join('\n'));
}

export async function handleEditInvoice(
  client: QuickBooks,
  args: {
    id: string;
    txn_date?: string;
    due_date?: string;
    memo?: string;
    customer_name?: string;
    department_name?: string;
    lines?: InvoiceLineChange[];
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { id, txn_date, due_date, memo, customer_name, department_name, lines: lineChanges, draft = true } = args;

  // Fetch current Invoice
  const current = await promisify<unknown>((cb) =>
    client.getInvoice(id, cb)
  ) as {
    Id: string;
    SyncToken: string;
    TxnDate: string;
    DueDate?: string;
    PrivateNote?: string;
    CustomerRef?: { value: string; name?: string };
    DepartmentRef?: { value: string; name?: string };
    Line: Array<{
      Id: string;
      Amount: number;
      Description?: string;
      DetailType: string;
      SalesItemLineDetail?: {
        ItemRef: { value: string; name?: string };
        Qty?: number;
        UnitPrice?: number;
        ItemAccountRef?: { value: string; name?: string };
        ClassRef?: { value: string; name?: string };
        TaxCodeRef?: { value: string; name?: string };
      };
    }>;
  };

  // Determine if we're modifying lines - requires full update (not sparse)
  const needsFullUpdate = lineChanges && lineChanges.length > 0;

  // Build updated Invoice
  const updated: Record<string, unknown> = {
    Id: current.Id,
    SyncToken: current.SyncToken,
  };

  if (!needsFullUpdate) {
    updated.sparse = true;
  } else {
    updated.sparse = false;
    updated.TxnDate = current.TxnDate;
    updated.DueDate = current.DueDate;
    updated.PrivateNote = current.PrivateNote;
    if (current.CustomerRef) {
      updated.CustomerRef = current.CustomerRef;
    }
    if (current.DepartmentRef) {
      updated.DepartmentRef = current.DepartmentRef;
    }
    // Copy lines and strip read-only fields
    updated.Line = current.Line.map(line => {
      const { LineNum, ...rest } = line as Record<string, unknown>;
      return rest;
    });
  }

  if (txn_date !== undefined) updated.TxnDate = txn_date;
  if (due_date !== undefined) updated.DueDate = due_date;
  if (memo !== undefined) updated.PrivateNote = memo;

  // Resolve customer if provided
  if (customer_name !== undefined) {
    const customerRef = await resolveCustomer(client, customer_name);
    updated.CustomerRef = customerRef;
  }

  // Resolve header-level department if provided
  if (department_name !== undefined) {
    const deptCache = await getDepartmentCache(client);
    let match = deptCache.byName.get(department_name.toLowerCase());
    if (!match) match = deptCache.items.find(d =>
      d.FullyQualifiedName?.toLowerCase().includes(department_name.toLowerCase())
    );
    if (!match) throw new Error(`Department not found: "${department_name}"`);
    updated.DepartmentRef = { value: match.Id, name: match.FullyQualifiedName || match.Name };
  }

  // Process line changes if provided
  let finalLines = [...((updated.Line as typeof current.Line) || current.Line)];

  if (lineChanges && lineChanges.length > 0) {
    for (const change of lineChanges) {
      if (change.line_id) {
        const lineIndex = finalLines.findIndex(l => l.Id === change.line_id);
        if (lineIndex === -1) {
          throw new Error(`Line ID ${change.line_id} not found in invoice`);
        }

        if (change.delete) {
          finalLines.splice(lineIndex, 1);
        } else {
          const line = { ...finalLines[lineIndex] };
          const detail = { ...(line.SalesItemLineDetail || {}) } as {
            ItemRef?: { value: string; name?: string };
            Qty?: number;
            UnitPrice?: number;
            ItemAccountRef?: { value: string; name?: string };
            TaxCodeRef?: { value: string; name?: string };
          };

          if (change.amount !== undefined) {
            const amountCents = validateAmount(change.amount, `Line ${change.line_id}`);
            line.Amount = toDollars(amountCents);
            if (detail.Qty === 1 || detail.Qty === undefined) {
              detail.UnitPrice = toDollars(amountCents);
            }
          }
          if (change.description !== undefined) line.Description = change.description;

          line.SalesItemLineDetail = detail as typeof line.SalesItemLineDetail;
          line.DetailType = 'SalesItemLineDetail';
          finalLines[lineIndex] = line;
        }
      } else {
        // New line — requires item reference
        const itemInput = change.item_name || change.item_id;
        if (!itemInput) {
          throw new Error('New lines require item_name or item_id');
        }
        if (change.amount === undefined && (change.qty === undefined || change.unit_price === undefined)) {
          throw new Error('New lines require amount, or both qty and unit_price');
        }

        const itemRef = await resolveItem(client, itemInput);

        const qty = change.qty ?? 1;
        let amountCents: number;
        let unitPriceDollars: number;

        if (change.amount !== undefined) {
          amountCents = validateAmount(change.amount, `New line for ${itemRef.name}`);
          unitPriceDollars = toDollars(amountCents) / qty;
        } else {
          const upCents = validateAmount(change.unit_price!, `New line unit_price for ${itemRef.name}`);
          unitPriceDollars = toDollars(upCents);
          amountCents = upCents * qty;
        }

        const newLine = {
          DetailType: 'SalesItemLineDetail',
          Amount: toDollars(amountCents),
          ...(change.description && { Description: change.description }),
          SalesItemLineDetail: {
            ItemRef: itemRef,
            Qty: qty,
            UnitPrice: unitPriceDollars,
          },
        } as typeof finalLines[0];
        finalLines.push(newLine);
      }
    }

    updated.Line = finalLines;
  }

  const qboUrl = `https://app.qbo.intuit.com/app/invoice?txnId=${id}`;

  if (draft) {
    const previewLines: string[] = [
      'DRAFT - Invoice Edit Preview',
      '',
      `ID: ${id}`,
      `SyncToken: ${current.SyncToken}`,
      '',
      'Changes:',
    ];

    if (txn_date !== undefined) previewLines.push(`  Date: ${current.TxnDate} → ${txn_date}`);
    if (due_date !== undefined) previewLines.push(`  Due Date: ${current.DueDate || '(none)'} → ${due_date}`);
    if (memo !== undefined) previewLines.push(`  Memo: ${current.PrivateNote || '(none)'} → ${memo}`);
    if (customer_name !== undefined) {
      const newCust = (updated.CustomerRef as { name?: string })?.name || customer_name;
      previewLines.push(`  Customer: ${current.CustomerRef?.name || '(none)'} → ${newCust}`);
    }
    if (department_name !== undefined) {
      const newDept = (updated.DepartmentRef as { name?: string })?.name || department_name;
      previewLines.push(`  Department: ${current.DepartmentRef?.name || '(none)'} → ${newDept}`);
    }

    if (updated.Line) {
      previewLines.push('');
      previewLines.push('Updated Lines:');
      for (const line of updated.Line as typeof finalLines) {
        const detail = line.SalesItemLineDetail;
        if (detail) {
          const itemName = detail.ItemRef?.name || detail.ItemRef?.value || '(item)';
          const descStr = line.Description ? ` "${line.Description}"` : '';
          previewLines.push(`  ${itemName}: $${line.Amount.toFixed(2)}${descStr}`);
        }
      }
    }

    previewLines.push('');
    previewLines.push('Set draft=false to apply these changes.');

    return {
      content: [{ type: "text", text: previewLines.join('\n') }],
    };
  }

  const result = await promisify<unknown>((cb) =>
    client.updateInvoice(updated, cb)
  ) as { Id: string; SyncToken: string };

  return {
    content: [{ type: "text", text: `Invoice ${id} updated successfully.\nNew SyncToken: ${result.SyncToken}\nView in QuickBooks: ${qboUrl}` }],
  };
}
