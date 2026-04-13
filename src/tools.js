import * as qbo from './qbo-client.js';

// Helper to define a tool with its schema and handler
function tool(name, description, inputSchema, handler) {
  return { name, description, inputSchema, handler };
}

export const tools = [
  // ── Invoices ──
  tool('get_invoice', 'Get a specific invoice by ID', {
    type: 'object',
    properties: {
      invoice_id: { type: 'string', description: 'The QuickBooks invoice ID' },
    },
    required: ['invoice_id'],
  }, async ({ invoice_id }) => {
    return await qbo.getInvoice(invoice_id);
  }),

  tool('list_invoices', 'List invoices with optional filters for customer, date range, and status', {
    type: 'object',
    properties: {
      customer_id: { type: 'string', description: 'Filter by customer ID' },
      status: { type: 'string', description: 'Filter by status: paid, unpaid/open', enum: ['paid', 'unpaid', 'open'] },
      start_date: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
      end_date: { type: 'string', description: 'End date (YYYY-MM-DD)' },
      max_results: { type: 'number', description: 'Max results to return (default 100)' },
    },
  }, async (args) => {
    return await qbo.listInvoices(args);
  }),

  tool('create_invoice', 'Create a new invoice', {
    type: 'object',
    properties: {
      customer_id: { type: 'string', description: 'Customer ID (CustomerRef value)' },
      line_items: {
        type: 'array',
        description: 'Array of line items. Each item: { description, amount, quantity?, item_id?, unit_price? }',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            amount: { type: 'number', description: 'Total line amount' },
            quantity: { type: 'number' },
            item_id: { type: 'string', description: 'Item/Service ID from QBO' },
            unit_price: { type: 'number' },
          },
          required: ['amount'],
        },
      },
      due_date: { type: 'string', description: 'Due date (YYYY-MM-DD)' },
      txn_date: { type: 'string', description: 'Transaction date (YYYY-MM-DD)' },
      email: { type: 'string', description: 'Email to send invoice to' },
      memo: { type: 'string', description: 'Private memo/note' },
    },
    required: ['customer_id', 'line_items'],
  }, async ({ customer_id, line_items, due_date, txn_date, email, memo }) => {
    const invoice = {
      CustomerRef: { value: customer_id },
      Line: line_items.map((item, i) => ({
        DetailType: 'SalesItemLineDetail',
        Amount: item.amount,
        Description: item.description,
        SalesItemLineDetail: {
          ...(item.item_id ? { ItemRef: { value: item.item_id } } : {}),
          Qty: item.quantity || 1,
          UnitPrice: item.unit_price || item.amount,
        },
      })),
    };
    if (due_date) invoice.DueDate = due_date;
    if (txn_date) invoice.TxnDate = txn_date;
    if (email) invoice.BillEmail = { Address: email };
    if (memo) invoice.PrivateNote = memo;
    return await qbo.createInvoice(invoice);
  }),

  tool('update_invoice', 'Update an existing invoice. Requires Id and SyncToken (get from get_invoice first).', {
    type: 'object',
    properties: {
      invoice: {
        type: 'object',
        description: 'Full or partial invoice object. Must include Id and SyncToken. Fields you include will be updated.',
      },
    },
    required: ['invoice'],
  }, async ({ invoice }) => {
    if (!invoice.Id || !invoice.SyncToken) {
      throw new Error('invoice must include Id and SyncToken. Use get_invoice first to retrieve them.');
    }
    return await qbo.updateInvoice(invoice);
  }),

  tool('send_invoice', 'Send an invoice via email', {
    type: 'object',
    properties: {
      invoice_id: { type: 'string', description: 'Invoice ID to send' },
      email: { type: 'string', description: 'Email address to send to (optional, uses invoice email if omitted)' },
    },
    required: ['invoice_id'],
  }, async ({ invoice_id, email }) => {
    return await qbo.sendInvoice(invoice_id, email || null);
  }),

  tool('void_invoice', 'Void an invoice. Requires Id and SyncToken.', {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Invoice ID' },
      sync_token: { type: 'string', description: 'SyncToken from the invoice' },
    },
    required: ['id', 'sync_token'],
  }, async ({ id, sync_token }) => {
    return await qbo.voidInvoice({ Id: id, SyncToken: sync_token });
  }),

  // ── Customers ──
  tool('get_customer', 'Get a specific customer by ID', {
    type: 'object',
    properties: {
      customer_id: { type: 'string', description: 'The QuickBooks customer ID' },
    },
    required: ['customer_id'],
  }, async ({ customer_id }) => {
    return await qbo.getCustomer(customer_id);
  }),

  tool('list_customers', 'List customers with optional search by name or email', {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Search by display name (partial match)' },
      email: { type: 'string', description: 'Search by exact email address' },
      active: { type: 'boolean', description: 'Filter by active status' },
      max_results: { type: 'number', description: 'Max results (default 100)' },
    },
  }, async (args) => {
    return await qbo.listCustomers(args);
  }),

  tool('create_customer', 'Create a new customer', {
    type: 'object',
    properties: {
      display_name: { type: 'string', description: 'Display name (required, must be unique)' },
      first_name: { type: 'string' },
      last_name: { type: 'string' },
      email: { type: 'string', description: 'Primary email address' },
      phone: { type: 'string', description: 'Primary phone number' },
      company_name: { type: 'string' },
      billing_address: {
        type: 'object',
        description: '{ line1, city, state, postal_code, country }',
        properties: {
          line1: { type: 'string' },
          city: { type: 'string' },
          state: { type: 'string' },
          postal_code: { type: 'string' },
          country: { type: 'string' },
        },
      },
    },
    required: ['display_name'],
  }, async ({ display_name, first_name, last_name, email, phone, company_name, billing_address }) => {
    const customer = { DisplayName: display_name };
    if (first_name) customer.GivenName = first_name;
    if (last_name) customer.FamilyName = last_name;
    if (email) customer.PrimaryEmailAddr = { Address: email };
    if (phone) customer.PrimaryPhone = { FreeFormNumber: phone };
    if (company_name) customer.CompanyName = company_name;
    if (billing_address) {
      customer.BillAddr = {
        Line1: billing_address.line1,
        City: billing_address.city,
        CountrySubDivisionCode: billing_address.state,
        PostalCode: billing_address.postal_code,
        Country: billing_address.country,
      };
    }
    return await qbo.createCustomer(customer);
  }),

  tool('update_customer', 'Update an existing customer. Requires Id and SyncToken.', {
    type: 'object',
    properties: {
      customer: {
        type: 'object',
        description: 'Customer object with Id, SyncToken, and fields to update.',
      },
    },
    required: ['customer'],
  }, async ({ customer }) => {
    if (!customer.Id || !customer.SyncToken) {
      throw new Error('customer must include Id and SyncToken. Use get_customer first.');
    }
    return await qbo.updateCustomer(customer);
  }),

  // ── Payments ──
  tool('get_payment', 'Get a specific payment by ID', {
    type: 'object',
    properties: {
      payment_id: { type: 'string', description: 'The QuickBooks payment ID' },
    },
    required: ['payment_id'],
  }, async ({ payment_id }) => {
    return await qbo.getPayment(payment_id);
  }),

  tool('list_payments', 'List payments with optional filters', {
    type: 'object',
    properties: {
      customer_id: { type: 'string', description: 'Filter by customer ID' },
      start_date: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
      end_date: { type: 'string', description: 'End date (YYYY-MM-DD)' },
      max_results: { type: 'number', description: 'Max results (default 100)' },
    },
  }, async (args) => {
    return await qbo.listPayments(args);
  }),

  tool('create_payment', 'Record a payment against one or more invoices', {
    type: 'object',
    properties: {
      customer_id: { type: 'string', description: 'Customer ID' },
      total_amount: { type: 'number', description: 'Total payment amount' },
      invoice_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of invoice IDs this payment applies to',
      },
      payment_date: { type: 'string', description: 'Payment date (YYYY-MM-DD)' },
      payment_method: { type: 'string', description: 'e.g. Cash, Check, CreditCard' },
      memo: { type: 'string' },
    },
    required: ['customer_id', 'total_amount'],
  }, async ({ customer_id, total_amount, invoice_ids, payment_date, payment_method, memo }) => {
    const payment = {
      CustomerRef: { value: customer_id },
      TotalAmt: total_amount,
    };
    if (invoice_ids && invoice_ids.length > 0) {
      payment.Line = invoice_ids.map(id => ({
        Amount: total_amount / invoice_ids.length,
        LinkedTxn: [{ TxnId: id, TxnType: 'Invoice' }],
      }));
    }
    if (payment_date) payment.TxnDate = payment_date;
    if (payment_method) payment.PaymentMethodRef = { value: payment_method };
    if (memo) payment.PrivateNote = memo;
    return await qbo.createPayment(payment);
  }),

  tool('list_deposits', 'List bank deposits with optional date range', {
    type: 'object',
    properties: {
      start_date: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
      end_date: { type: 'string', description: 'End date (YYYY-MM-DD)' },
      max_results: { type: 'number', description: 'Max results (default 100)' },
    },
  }, async (args) => {
    return await qbo.listDeposits(args);
  }),

  // ── Vendors ──
  tool('get_vendor', 'Get a specific vendor by ID', {
    type: 'object',
    properties: {
      vendor_id: { type: 'string', description: 'The QuickBooks vendor ID' },
    },
    required: ['vendor_id'],
  }, async ({ vendor_id }) => {
    return await qbo.getVendor(vendor_id);
  }),

  tool('list_vendors', 'List vendors with optional search filters', {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Search by display name (partial match)' },
      active: { type: 'boolean', description: 'Filter by active status' },
      max_results: { type: 'number', description: 'Max results (default 100)' },
    },
  }, async (args) => {
    return await qbo.listVendors(args);
  }),

  tool('create_vendor', 'Create a new vendor', {
    type: 'object',
    properties: {
      display_name: { type: 'string', description: 'Display name (required, must be unique)' },
      first_name: { type: 'string' },
      last_name: { type: 'string' },
      email: { type: 'string' },
      phone: { type: 'string' },
      company_name: { type: 'string' },
    },
    required: ['display_name'],
  }, async ({ display_name, first_name, last_name, email, phone, company_name }) => {
    const vendor = { DisplayName: display_name };
    if (first_name) vendor.GivenName = first_name;
    if (last_name) vendor.FamilyName = last_name;
    if (email) vendor.PrimaryEmailAddr = { Address: email };
    if (phone) vendor.PrimaryPhone = { FreeFormNumber: phone };
    if (company_name) vendor.CompanyName = company_name;
    return await qbo.createVendor(vendor);
  }),

  tool('update_vendor', 'Update an existing vendor. Requires Id and SyncToken.', {
    type: 'object',
    properties: {
      vendor: {
        type: 'object',
        description: 'Vendor object with Id, SyncToken, and fields to update.',
      },
    },
    required: ['vendor'],
  }, async ({ vendor }) => {
    if (!vendor.Id || !vendor.SyncToken) {
      throw new Error('vendor must include Id and SyncToken. Use get_vendor first.');
    }
    return await qbo.updateVendor(vendor);
  }),

  // ── Bills ──
  tool('get_bill', 'Get a specific bill by ID', {
    type: 'object',
    properties: {
      bill_id: { type: 'string', description: 'The QuickBooks bill ID' },
    },
    required: ['bill_id'],
  }, async ({ bill_id }) => {
    return await qbo.getBill(bill_id);
  }),

  tool('list_bills', 'List bills with optional filters for vendor, status, and due date', {
    type: 'object',
    properties: {
      vendor_id: { type: 'string', description: 'Filter by vendor ID' },
      status: { type: 'string', description: 'Filter: paid, unpaid/open', enum: ['paid', 'unpaid', 'open'] },
      due_before: { type: 'string', description: 'Due on or before date (YYYY-MM-DD)' },
      due_after: { type: 'string', description: 'Due on or after date (YYYY-MM-DD)' },
      max_results: { type: 'number', description: 'Max results (default 100)' },
    },
  }, async (args) => {
    return await qbo.listBills(args);
  }),

  tool('create_bill', 'Create a new bill (expense from a vendor)', {
    type: 'object',
    properties: {
      vendor_id: { type: 'string', description: 'Vendor ID' },
      line_items: {
        type: 'array',
        description: 'Array of line items: { amount, description?, account_id?, item_id? }',
        items: {
          type: 'object',
          properties: {
            amount: { type: 'number' },
            description: { type: 'string' },
            account_id: { type: 'string', description: 'Expense account ID' },
            item_id: { type: 'string', description: 'Item ID (for item-based lines)' },
          },
          required: ['amount'],
        },
      },
      due_date: { type: 'string', description: 'Due date (YYYY-MM-DD)' },
      txn_date: { type: 'string', description: 'Transaction date (YYYY-MM-DD)' },
      memo: { type: 'string' },
    },
    required: ['vendor_id', 'line_items'],
  }, async ({ vendor_id, line_items, due_date, txn_date, memo }) => {
    const bill = {
      VendorRef: { value: vendor_id },
      Line: line_items.map(item => {
        if (item.item_id) {
          return {
            DetailType: 'ItemBasedExpenseLineDetail',
            Amount: item.amount,
            Description: item.description,
            ItemBasedExpenseLineDetail: {
              ItemRef: { value: item.item_id },
            },
          };
        }
        return {
          DetailType: 'AccountBasedExpenseLineDetail',
          Amount: item.amount,
          Description: item.description,
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: item.account_id || '1' },
          },
        };
      }),
    };
    if (due_date) bill.DueDate = due_date;
    if (txn_date) bill.TxnDate = txn_date;
    if (memo) bill.PrivateNote = memo;
    return await qbo.createBill(bill);
  }),

  tool('update_bill', 'Update an existing bill. Requires Id and SyncToken.', {
    type: 'object',
    properties: {
      bill: {
        type: 'object',
        description: 'Bill object with Id, SyncToken, and fields to update.',
      },
    },
    required: ['bill'],
  }, async ({ bill }) => {
    if (!bill.Id || !bill.SyncToken) {
      throw new Error('bill must include Id and SyncToken. Use get_bill first.');
    }
    return await qbo.updateBill(bill);
  }),

  tool('pay_bill', 'Pay a bill (create a BillPayment)', {
    type: 'object',
    properties: {
      vendor_id: { type: 'string', description: 'Vendor ID' },
      bill_id: { type: 'string', description: 'Bill ID to pay' },
      amount: { type: 'number', description: 'Payment amount' },
      bank_account_id: { type: 'string', description: 'Bank account ID to pay from' },
      payment_type: { type: 'string', description: 'Check or CreditCard', enum: ['Check', 'CreditCard'] },
      payment_date: { type: 'string', description: 'Payment date (YYYY-MM-DD)' },
    },
    required: ['vendor_id', 'bill_id', 'amount', 'bank_account_id'],
  }, async ({ vendor_id, bill_id, amount, bank_account_id, payment_type, payment_date }) => {
    const billPayment = {
      VendorRef: { value: vendor_id },
      TotalAmt: amount,
      PayType: payment_type || 'Check',
      Line: [{
        Amount: amount,
        LinkedTxn: [{ TxnId: bill_id, TxnType: 'Bill' }],
      }],
    };
    if (payment_type === 'CreditCard') {
      billPayment.CreditCardPayment = {
        CCAccountRef: { value: bank_account_id },
      };
    } else {
      billPayment.CheckPayment = {
        BankAccountRef: { value: bank_account_id },
      };
    }
    if (payment_date) billPayment.TxnDate = payment_date;
    return await qbo.createBillPayment(billPayment);
  }),

  // ── Reports ──
  tool('get_profit_and_loss', 'Get Profit and Loss report', {
    type: 'object',
    properties: {
      start_date: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
      end_date: { type: 'string', description: 'End date (YYYY-MM-DD)' },
      accounting_method: { type: 'string', description: 'Accrual or Cash', enum: ['Accrual', 'Cash'] },
    },
  }, async (args) => {
    return await qbo.getProfitAndLoss(args);
  }),

  tool('get_balance_sheet', 'Get Balance Sheet report', {
    type: 'object',
    properties: {
      start_date: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
      end_date: { type: 'string', description: 'End date (YYYY-MM-DD)' },
      accounting_method: { type: 'string', description: 'Accrual or Cash', enum: ['Accrual', 'Cash'] },
    },
  }, async (args) => {
    return await qbo.getBalanceSheet(args);
  }),

  tool('get_accounts_receivable_aging', 'Get Accounts Receivable Aging Summary report', {
    type: 'object',
    properties: {
      report_date: { type: 'string', description: 'Report as-of date (YYYY-MM-DD)' },
    },
  }, async (args) => {
    return await qbo.getARAgingSummary(args);
  }),

  tool('get_accounts_payable_aging', 'Get Accounts Payable Aging Summary report', {
    type: 'object',
    properties: {
      report_date: { type: 'string', description: 'Report as-of date (YYYY-MM-DD)' },
    },
  }, async (args) => {
    return await qbo.getAPAgingSummary(args);
  }),

  tool('get_cash_flow', 'Get Statement of Cash Flows report', {
    type: 'object',
    properties: {
      start_date: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
      end_date: { type: 'string', description: 'End date (YYYY-MM-DD)' },
    },
  }, async (args) => {
    return await qbo.getCashFlow(args);
  }),

  // ── General ──
  tool('get_company_info', 'Get company information from QuickBooks', {
    type: 'object',
    properties: {},
  }, async () => {
    return await qbo.getCompanyInfo();
  }),

  tool('list_accounts', 'List chart of accounts', {
    type: 'object',
    properties: {
      type: { type: 'string', description: 'Filter by account type (e.g. Bank, Expense, Income)' },
      active: { type: 'boolean', description: 'Filter by active status' },
      max_results: { type: 'number', description: 'Max results (default 200)' },
    },
  }, async (args) => {
    return await qbo.listAccounts(args);
  }),

  tool('query_qbo', 'Execute a raw QBO query string for anything not covered by other tools', {
    type: 'object',
    properties: {
      query: { type: 'string', description: "QBO query string, e.g. \"SELECT * FROM Employee WHERE Active = true\"" },
    },
    required: ['query'],
  }, async ({ query }) => {
    return await qbo.queryQBO(query);
  }),
];

// Build lookup map for the server
export const toolMap = new Map(tools.map(t => [t.name, t]));
