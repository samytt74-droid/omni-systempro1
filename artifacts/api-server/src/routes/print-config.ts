import { Router } from "express";
import { db } from "../lib/sqlite";
import { getAuthUser } from "./auth";

const router = Router();

// ---- Receipt Copy Configs ----

router.get("/print-config/receipt-copies", (_req, res) => {
  const rows = db.prepare("SELECT * FROM receipt_copy_configs ORDER BY copy_number").all() as any[];
  res.json(rows.map(r => ({
    id: r.id,
    copyNumber: r.copy_number,
    label: r.label,
    enabled: Boolean(r.enabled),
  })));
});

router.post("/print-config/receipt-copies", (req, res) => {
  const user = getAuthUser(req);
  if (!user || (user.role !== "admin" && user.role !== "developer")) { res.status(403).json({ error: "غير مصرح" }); return; }
  const { copyNumber, label, enabled } = req.body;
  if (!copyNumber || !label) { res.status(400).json({ error: "بيانات ناقصة" }); return; }
  const r = db.prepare(
    "INSERT INTO receipt_copy_configs (copy_number, label, enabled) VALUES (?,?,?)"
  ).run(copyNumber, label, enabled !== false ? 1 : 0);
  const row = db.prepare("SELECT * FROM receipt_copy_configs WHERE id=?").get(r.lastInsertRowid) as any;
  res.status(201).json({ id: row.id, copyNumber: row.copy_number, label: row.label, enabled: Boolean(row.enabled) });
});

router.put("/print-config/receipt-copies/:id", (req, res) => {
  const user = getAuthUser(req);
  if (!user || (user.role !== "admin" && user.role !== "developer")) { res.status(403).json({ error: "غير مصرح" }); return; }
  const { copyNumber, label, enabled } = req.body;
  db.prepare(
    "UPDATE receipt_copy_configs SET copy_number=?, label=?, enabled=? WHERE id=?"
  ).run(copyNumber, label, enabled !== false ? 1 : 0, req.params.id);
  const row = db.prepare("SELECT * FROM receipt_copy_configs WHERE id=?").get(req.params.id) as any;
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json({ id: row.id, copyNumber: row.copy_number, label: row.label, enabled: Boolean(row.enabled) });
});

router.delete("/print-config/receipt-copies/:id", (req, res) => {
  const user = getAuthUser(req);
  if (!user || (user.role !== "admin" && user.role !== "developer")) { res.status(403).json({ error: "غير مصرح" }); return; }
  db.prepare("DELETE FROM receipt_copy_configs WHERE id=?").run(req.params.id);
  res.status(204).send();
});

// ---- Department Print Configs ----

function formatDeptConfig(r: any) {
  return {
    id: r.id,
    categoryId: r.category_id,
    categoryName: r.category_name ?? null,
    printerName: r.printer_name ?? null,
    copies: r.copies,
    enabled: Boolean(r.enabled),
    printOrder: r.print_order,
  };
}

router.get("/print-config/departments", (_req, res) => {
  const rows = db.prepare(`
    SELECT d.*, c.name as category_name
    FROM department_print_configs d
    LEFT JOIN categories c ON c.id = d.category_id
    ORDER BY d.print_order
  `).all() as any[];
  res.json(rows.map(formatDeptConfig));
});

router.post("/print-config/departments", (req, res) => {
  const user = getAuthUser(req);
  if (!user || (user.role !== "admin" && user.role !== "developer")) { res.status(403).json({ error: "غير مصرح" }); return; }
  const { categoryId, printerName, copies, enabled, printOrder } = req.body;
  const r = db.prepare(
    "INSERT INTO department_print_configs (category_id, printer_name, copies, enabled, print_order) VALUES (?,?,?,?,?)"
  ).run(categoryId ?? null, printerName ?? null, copies ?? 1, enabled !== false ? 1 : 0, printOrder ?? 0);
  const row = db.prepare(`
    SELECT d.*, c.name as category_name FROM department_print_configs d
    LEFT JOIN categories c ON c.id = d.category_id WHERE d.id=?
  `).get(r.lastInsertRowid) as any;
  res.status(201).json(formatDeptConfig(row));
});

router.put("/print-config/departments/:id", (req, res) => {
  const user = getAuthUser(req);
  if (!user || (user.role !== "admin" && user.role !== "developer")) { res.status(403).json({ error: "غير مصرح" }); return; }
  const { categoryId, printerName, copies, enabled, printOrder } = req.body;
  db.prepare(
    "UPDATE department_print_configs SET category_id=?, printer_name=?, copies=?, enabled=?, print_order=? WHERE id=?"
  ).run(categoryId ?? null, printerName ?? null, copies ?? 1, enabled !== false ? 1 : 0, printOrder ?? 0, req.params.id);
  const row = db.prepare(`
    SELECT d.*, c.name as category_name FROM department_print_configs d
    LEFT JOIN categories c ON c.id = d.category_id WHERE d.id=?
  `).get(req.params.id) as any;
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json(formatDeptConfig(row));
});

router.delete("/print-config/departments/:id", (req, res) => {
  const user = getAuthUser(req);
  if (!user || (user.role !== "admin" && user.role !== "developer")) { res.status(403).json({ error: "غير مصرح" }); return; }
  db.prepare("DELETE FROM department_print_configs WHERE id=?").run(req.params.id);
  res.status(204).send();
});

export default router;
