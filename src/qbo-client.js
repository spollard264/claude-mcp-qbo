import QuickBooks from 'node-quickbooks';
import axios from 'axios';
import { ensureValidToken } from './auth.js';

const QBO_BASE_URL = 'https://quickbooks.api.intuit.com/v3/company';

function getClient() {
  return ensureValidToken().then(({ accessToken, realmId }) => {
    return new QuickBooks(
      process.env.QB_CLIENT_ID,
      process.env.QB_CLIENT_SECRET,
      accessToken,
      false, // no token secret (OAuth2)
      realmId,
      false, // useSandbox = false (production only)
      false, // debug
      null,  // minor version
      '2.0', // OAuth version
      null   // refresh token (handled by our auth module)
    );
  });
}

// Extract intuit_tid from axios response or node-quickbooks response
function extractTid(res) {
  if (!res) return undefined;
  // axios response: res.headers is a plain object
  // node-quickbooks passes the axios response as the 3rd callback arg
  const headers = res.headers || res.header;
  if (!headers) return undefined;
  return headers['intuit_tid'] || headers['intuit-tid'] || undefined;
}

// Build an error with intuit_tid attached
function buildError(err, res) {
  const tid = extractTid(res);
  const message = err?.Fault?.Error?.[0]?.Message
    || err?.Fault?.Error?.[0]?.Detail
    || err?.message
    || JSON.stringify(err);
  const tidSuffix = tid ? ` [intuit_tid: ${tid}]` : '';
  console.error(`QBO API Error: ${message}${tidSuffix}`);
  const error = new Error(`${message}${tidSuffix}`);
  error.intuit_tid = tid;
  return error;
}

// Promisify a node-quickbooks callback method, capturing intuit_tid
function promisify(qbo, method, ...args) {
  return new Promise((resolve, reject) => {
    qbo[method](...args, (err, result, res) => {
      if (err) {
        reject(buildError(err, res));
      } else {
        const tid = extractTid(res);
        if (tid && result && typeof result === 'object') {
          result._intuit_tid = tid;
        }
        resolve(result);
      }
    });
  });
}

// Direct HTTP query against QBO API (node-quickbooks has no .query() method)
async function query(queryString) {
  const { accessToken, realmId } = await ensureValidToken();
  const url = `${QBO_BASE_URL}/${realmId}/query`;
  try {
    const res = await axios.get(url, {
      params: { query: queryString },
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/text',
      },
    });
    const tid = extractTid(res);
    const data = res.data;
    if (tid && data && typeof data === 'object') {
      data._intuit_tid = tid;
    }
    return data;
  } catch (err) {
    const res = err.response;
    const tid = extractTid(res);
    const body = res?.data;
    const message = body?.Fault?.Error?.[0]?.Message
      || body?.Fault?.Error?.[0]?.Detail
      || err.message
      || JSON.stringify(err);
    const tidSuffix = tid ? ` [intuit_tid: ${tid}]` : '';
    console.error(`QBO Query Error: ${message}${tidSuffix}`);
    const error = new Error(`${message}${tidSuffix}`);
    error.intuit_tid = tid;
    throw error;
  }
}

// Report helper — node-quickbooks report callbacks receive (err, body, res)
async function getReport(reportType, params = {}) {
  const qbo = await getClient();
  return new Promise((resolve, reject) => {
    const method = `report${reportType}`;
    if (typeof qbo[method] !== 'function') {
      reject(new Error(`Unknown report type: ${reportType}`));
      return;
    }
    qbo[method](params, (err, result, res) => {
      if (err) {
        reject(buildError(err, res));
      } else {
        const tid = extractTid(res);
        if (tid && result && typeof result === 'object') {
          result._intuit_tid = tid;
        }
        resolve(result);
      }
    });
  });
}

// ── Invoices ──

export async function getInvoice(id) {
  const qbo = await getClient();
  return promisify(qbo, 'getInvoice', id);
}

export async function listInvoices(filters = {}) {
  let q = "SELECT * FROM Invoice";
  const conditions = [];

  if (filters.customer_id) {
    conditions.push(`CustomerRef = '${filters.customer_id}'`);
  }
  if (filters.status) {
    if (filters.status.toLowerCase() === 'paid') {
      conditions.push("Balance = '0'");
    } else if (filters.status.toLowerCase() === 'unpaid' || filters.status.toLowerCase() === 'open') {
      conditions.push("Balance > '0'");
    }
  }
  if (filters.start_date) {
    conditions.push(`TxnDate >= '${filters.start_date}'`);
  }
  if (filters.end_date) {
    conditions.push(`TxnDate <= '${filters.end_date}'`);
  }

  if (conditions.length > 0) {
    q += " WHERE " + conditions.join(" AND ");
  }
  q += ` MAXRESULTS ${filters.max_results || 100}`;

  return query(q);
}

export async function createInvoice(invoiceData) {
  const qbo = await getClient();
  return promisify(qbo, 'createInvoice', invoiceData);
}

export async function updateInvoice(invoiceData) {
  const qbo = await getClient();
  return promisify(qbo, 'updateInvoice', invoiceData);
}

export async function sendInvoice(invoiceId, email) {
  const qbo = await getClient();
  return new Promise((resolve, reject) => {
    qbo.sendInvoicePdf(invoiceId, email, (err, result, res) => {
      if (err) {
        reject(buildError(err, res));
      } else {
        const tid = extractTid(res);
        if (tid && result && typeof result === 'object') {
          result._intuit_tid = tid;
        }
        resolve(result);
      }
    });
  });
}

export async function voidInvoice(invoiceData) {
  const qbo = await getClient();
  return promisify(qbo, 'voidInvoice', invoiceData);
}

// ── Customers ──

export async function getCustomer(id) {
  const qbo = await getClient();
  return promisify(qbo, 'getCustomer', id);
}

export async function listCustomers(filters = {}) {
  let q = "SELECT * FROM Customer";
  const conditions = [];

  if (filters.name) {
    conditions.push(`DisplayName LIKE '%${filters.name}%'`);
  }
  if (filters.email) {
    conditions.push(`PrimaryEmailAddr = '${filters.email}'`);
  }
  if (filters.active !== undefined) {
    conditions.push(`Active = ${filters.active}`);
  }

  if (conditions.length > 0) {
    q += " WHERE " + conditions.join(" AND ");
  }
  q += ` MAXRESULTS ${filters.max_results || 100}`;

  return query(q);
}

export async function createCustomer(customerData) {
  const qbo = await getClient();
  return promisify(qbo, 'createCustomer', customerData);
}

export async function updateCustomer(customerData) {
  const qbo = await getClient();
  return promisify(qbo, 'updateCustomer', customerData);
}

// ── Payments ──

export async function getPayment(id) {
  const qbo = await getClient();
  return promisify(qbo, 'getPayment', id);
}

export async function listPayments(filters = {}) {
  let q = "SELECT * FROM Payment";
  const conditions = [];

  if (filters.customer_id) {
    conditions.push(`CustomerRef = '${filters.customer_id}'`);
  }
  if (filters.start_date) {
    conditions.push(`TxnDate >= '${filters.start_date}'`);
  }
  if (filters.end_date) {
    conditions.push(`TxnDate <= '${filters.end_date}'`);
  }

  if (conditions.length > 0) {
    q += " WHERE " + conditions.join(" AND ");
  }
  q += ` MAXRESULTS ${filters.max_results || 100}`;

  return query(q);
}

export async function createPayment(paymentData) {
  const qbo = await getClient();
  return promisify(qbo, 'createPayment', paymentData);
}

export async function listDeposits(filters = {}) {
  let q = "SELECT * FROM Deposit";
  const conditions = [];

  if (filters.start_date) {
    conditions.push(`TxnDate >= '${filters.start_date}'`);
  }
  if (filters.end_date) {
    conditions.push(`TxnDate <= '${filters.end_date}'`);
  }

  if (conditions.length > 0) {
    q += " WHERE " + conditions.join(" AND ");
  }
  q += ` MAXRESULTS ${filters.max_results || 100}`;

  return query(q);
}

// ── Vendors ──

export async function getVendor(id) {
  const qbo = await getClient();
  return promisify(qbo, 'getVendor', id);
}

export async function listVendors(filters = {}) {
  let q = "SELECT * FROM Vendor";
  const conditions = [];

  if (filters.name) {
    conditions.push(`DisplayName LIKE '%${filters.name}%'`);
  }
  if (filters.active !== undefined) {
    conditions.push(`Active = ${filters.active}`);
  }

  if (conditions.length > 0) {
    q += " WHERE " + conditions.join(" AND ");
  }
  q += ` MAXRESULTS ${filters.max_results || 100}`;

  return query(q);
}

export async function createVendor(vendorData) {
  const qbo = await getClient();
  return promisify(qbo, 'createVendor', vendorData);
}

export async function updateVendor(vendorData) {
  const qbo = await getClient();
  return promisify(qbo, 'updateVendor', vendorData);
}

// ── Bills ──

export async function getBill(id) {
  const qbo = await getClient();
  return promisify(qbo, 'getBill', id);
}

export async function listBills(filters = {}) {
  let q = "SELECT * FROM Bill";
  const conditions = [];

  if (filters.vendor_id) {
    conditions.push(`VendorRef = '${filters.vendor_id}'`);
  }
  if (filters.status) {
    if (filters.status.toLowerCase() === 'paid') {
      conditions.push("Balance = '0'");
    } else if (filters.status.toLowerCase() === 'unpaid' || filters.status.toLowerCase() === 'open') {
      conditions.push("Balance > '0'");
    }
  }
  if (filters.due_before) {
    conditions.push(`DueDate <= '${filters.due_before}'`);
  }
  if (filters.due_after) {
    conditions.push(`DueDate >= '${filters.due_after}'`);
  }

  if (conditions.length > 0) {
    q += " WHERE " + conditions.join(" AND ");
  }
  q += ` MAXRESULTS ${filters.max_results || 100}`;

  return query(q);
}

export async function createBill(billData) {
  const qbo = await getClient();
  return promisify(qbo, 'createBill', billData);
}

export async function updateBill(billData) {
  const qbo = await getClient();
  return promisify(qbo, 'updateBill', billData);
}

export async function createBillPayment(paymentData) {
  const qbo = await getClient();
  return promisify(qbo, 'createBillPayment', paymentData);
}

// ── Reports ──

export async function getProfitAndLoss(params = {}) {
  return getReport('ProfitAndLoss', {
    start_date: params.start_date,
    end_date: params.end_date,
    accounting_method: params.accounting_method || 'Accrual',
  });
}

export async function getBalanceSheet(params = {}) {
  return getReport('BalanceSheet', {
    start_date: params.start_date,
    end_date: params.end_date,
    accounting_method: params.accounting_method || 'Accrual',
  });
}

export async function getARAgingSummary(params = {}) {
  return getReport('AgedReceivables', {
    report_date: params.report_date,
  });
}

export async function getAPAgingSummary(params = {}) {
  return getReport('AgedPayables', {
    report_date: params.report_date,
  });
}

export async function getCashFlow(params = {}) {
  return getReport('CashFlow', {
    start_date: params.start_date,
    end_date: params.end_date,
  });
}

// ── General ──

export async function getCompanyInfo() {
  const qbo = await getClient();
  const { realmId } = await ensureValidToken();
  return promisify(qbo, 'getCompanyInfo', realmId);
}

export async function listAccounts(filters = {}) {
  let q = "SELECT * FROM Account";
  const conditions = [];

  if (filters.type) {
    conditions.push(`AccountType = '${filters.type}'`);
  }
  if (filters.active !== undefined) {
    conditions.push(`Active = ${filters.active}`);
  }

  if (conditions.length > 0) {
    q += " WHERE " + conditions.join(" AND ");
  }
  q += ` MAXRESULTS ${filters.max_results || 200}`;

  return query(q);
}

export async function queryQBO(queryString) {
  return query(queryString);
}
