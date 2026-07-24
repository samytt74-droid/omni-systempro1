import { Router } from "express";
import { db } from "../lib/sqlite";
import { getAuthUser } from "./auth";

const router = Router();

function formatLog(r: any) {
  return {
    id: r.id,
    orderId: r.order_id,
    invoiceNumber: r.invoice_number,
    receiptType: r.receipt_type,
    departmentName: r.department_name ?? null,
    printerName: r.printer_name ?? null,
    printedAt: r.printed_at,
    userId: r.user_id,
    userName: r.user_name ?? null,
    copies: r.copies,
    status: r.status,
    reprintReason: r.reprint_reason ?? null,
    reprintCount: r.reprint_count,
  };
}

router.get("/print-log", (req, res) => {
  const { orderId, startDate, endDate } = req.query;
  let sql = `
    SELECT p.*, u.name as user_name
    FROM print_log p
    LEFT JOIN users u ON u.id = p.user_id
    WHERE 1=1
  `;
  const params: any[] = [];
  if (orderId) { sql += " AND p.order_id=?"; params.push(orderId); }
  if (startDate) { sql += " AND DATE(p.printed_at) >= ?"; params.push(startDate); }
  if (endDate) { sql += " AND DATE(p.printed_at) <= ?"; params.push(endDate); }
  sql += " ORDER BY p.printed_at DESC LIMIT 500";
  const rows = db.prepare(sql).all(...params) as any[];
  res.json(rows.map(formatLog));
});

router.post("/print-log", (req, res) => {
  const authUser = getAuthUser(req);
  if (!authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  const { orderId, invoiceNumber, receiptType, departmentName, printerName, copies, status, reprintReason, reprintCount } = req.body;
  if (!orderId || !invoiceNumber || !receiptType) { res.status(400).json({ error: "بيانات ناقصة" }); return; }

  const r = db.prepare(`
    INSERT INTO print_log (order_id, invoice_number, receipt_type, department_name, printer_name, user_id, copies, status, reprint_reason, reprint_count)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    orderId,
    invoiceNumber,
    receiptType,
    departmentName ?? null,
    printerName ?? null,
    authUser.id,
    copies ?? 1,
    status ?? "success",
    reprintReason ?? null,
    reprintCount ?? 0,
  );

  const row = db.prepare(`
    SELECT p.*, u.name as user_name FROM print_log p
    LEFT JOIN users u ON u.id = p.user_id WHERE p.id=?
  `).get(r.lastInsertRowid) as any;
  res.status(201).json(formatLog(row));
});

// Get reprint count for a specific order
router.get("/print-log/reprint-count/:orderId", (req, res) => {
  const row = db.prepare(
    "SELECT COALESCE(MAX(reprint_count), 0) as count FROM print_log WHERE order_id=? AND receipt_type='master'"
  ).get(req.params.orderId) as any;
  res.json({ reprintCount: row?.count ?? 0 });
});

export default router;
