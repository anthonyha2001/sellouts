// Cashier shortcut: #cashier(s) opens the standalone cashier page (kept out of index.html so the
// Content-Security-Policy can forbid inline scripts — the main XSS defence). Owner, 2026-10-25.
if (/^#cashiers?$/i.test(location.hash)) location.replace('cashier.html');
