import { Router } from "express";
import { db, logAudit } from "../lib/sqlite";
import { getAuthUser } from "./auth";

const router = Router();

function requireAdmin(req: any, res: any): boolean {
  const user = getAuthUser(req);
  if (!user || (user.role !== "admin" && user.role !== "developer")) {
    res.status(403).json({ error: "غير مصرح" });
    return false;
  }
  return true;
}

router.get("/system/backup", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const user = getAuthUser(req);
  const products = db.prepare("SELECT * FROM products").all();
  const categories = db.prepare("SELECT * FROM categories").all();
  const orders = db.prepare("SELECT * FROM orders").all();
  const orderItems = db.prepare("SELECT * FROM order_items").all();
  const customers = db.prepare("SELECT * FROM customers").all();
  const expenses = db.prepare("SELECT * FROM expenses").all();
  const suppliers = db.prepare("SELECT * FROM suppliers").all();

  const backupData = {
    version: "2.5.0",
    timestamp: new Date().toISOString(),
    products,
    categories,
    orders,
    orderItems,
    customers,
    expenses,
    suppliers
  };

  logAudit(user.id, user.name, "نسخ احتياطي", "تصدير نسخة احتياطية من النظام");
  res.setHeader("Content-Disposition", `attachment; filename=omni-backup-${new Date().toISOString().slice(0, 10)}.json`);
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(backupData, null, 2));
});

// ────────────────────────────────────────────────────────
// CURRENCIES MANAGEMENT ENDPOINTS
// ────────────────────────────────────────────────────────
router.get("/currencies", (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM currencies ORDER BY id").all();
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/currencies", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const user = getAuthUser(req);
  const { name, symbol, fraction, type, exchange_rate, active } = req.body;
  if (!name || !symbol || !type) {
    res.status(400).json({ error: "بيانات ناقصة" });
    return;
  }
  try {
    const stmt = db.prepare(`
      INSERT INTO currencies (name, symbol, fraction, type, exchange_rate, active)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(name, symbol, fraction || null, type, exchange_rate || 1.0, active !== false ? 1 : 0);
    const row = db.prepare("SELECT * FROM currencies WHERE id = ?").get(result.lastInsertRowid);
    
    logAudit(user.id, user.name, "إضافة عملة", `تم إضافة عملة جديدة: ${name} (${symbol})`);
    res.status(201).json(row);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/currencies/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const user = getAuthUser(req);
  const { name, symbol, fraction, type, exchange_rate, active } = req.body;
  try {
    const existing = db.prepare("SELECT * FROM currencies WHERE id = ?").get(req.params.id) as any;
    if (!existing) {
      res.status(404).json({ error: "العملة غير موجودة" });
      return;
    }
    db.prepare(`
      UPDATE currencies
      SET name = ?, symbol = ?, fraction = ?, type = ?, exchange_rate = ?, active = ?
      WHERE id = ?
    `).run(
      name ?? existing.name,
      symbol ?? existing.symbol,
      fraction !== undefined ? fraction : existing.fraction,
      type ?? existing.type,
      exchange_rate ?? existing.exchange_rate,
      active !== undefined ? (active ? 1 : 0) : existing.active,
      req.params.id
    );
    const updated = db.prepare("SELECT * FROM currencies WHERE id = ?").get(req.params.id);
    logAudit(user.id, user.name, "تعديل عملة", `تم تعديل عملة: ${name || existing.name}`);
    res.json(updated);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/currencies/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const user = getAuthUser(req);
  try {
    const existing = db.prepare("SELECT * FROM currencies WHERE id = ?").get(req.params.id) as any;
    if (!existing) {
      res.status(404).json({ error: "العملة غير موجودة" });
      return;
    }
    db.prepare("DELETE FROM currencies WHERE id = ?").run(req.params.id);
    logAudit(user.id, user.name, "حذف عملة", `تم حذف عملة: ${existing.name}`);
    res.status(204).send();
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ────────────────────────────────────────────────────────
// USER SESSIONS TRACKING ENDPOINTS
// ────────────────────────────────────────────────────────
router.get("/system/sessions", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const rows = db.prepare("SELECT * FROM erp_sessions ORDER BY login_time DESC").all();
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/system/sessions/terminate/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const user = getAuthUser(req);
  try {
    const existing = db.prepare("SELECT * FROM erp_sessions WHERE id = ?").get(req.params.id) as any;
    if (!existing) {
      res.status(404).json({ error: "الجلسة غير موجودة" });
      return;
    }
    db.prepare(`
      UPDATE erp_sessions
      SET status = 'خروج قسري', logout_time = datetime('now', 'localtime')
      WHERE id = ?
    `).run(req.params.id);
    logAudit(user.id, user.name, "إنهاء جلسة", `تم إنهاء جلسة المستخدم قسراً: ${existing.username}`);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ────────────────────────────────────────────────────────
// ROLE PERMISSIONS MANAGEMENT ENDPOINTS
// ────────────────────────────────────────────────────────
router.get("/role-permissions", (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM role_permissions").all();
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/role-permissions/:role", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const user = getAuthUser(req);
  const { role } = req.params;
  const {
    can_void_bills,
    can_view_cost,
    can_change_currencies,
    can_approve_returns,
    can_open_close_safe,
    can_transfer_funds,
    can_edit_products,
    can_delete_orders
  } = req.body;

  try {
    db.prepare(`
      UPDATE role_permissions
      SET can_void_bills = ?,
          can_view_cost = ?,
          can_change_currencies = ?,
          can_approve_returns = ?,
          can_open_close_safe = ?,
          can_transfer_funds = ?,
          can_edit_products = ?,
          can_delete_orders = ?
      WHERE role = ?
    `).run(
      can_void_bills !== undefined ? (can_void_bills ? 1 : 0) : 0,
      can_view_cost !== undefined ? (can_view_cost ? 1 : 0) : 0,
      can_change_currencies !== undefined ? (can_change_currencies ? 1 : 0) : 0,
      can_approve_returns !== undefined ? (can_approve_returns ? 1 : 0) : 0,
      can_open_close_safe !== undefined ? (can_open_close_safe ? 1 : 0) : 0,
      can_transfer_funds !== undefined ? (can_transfer_funds ? 1 : 0) : 0,
      can_edit_products !== undefined ? (can_edit_products ? 1 : 0) : 0,
      can_delete_orders !== undefined ? (can_delete_orders ? 1 : 0) : 0,
      role
    );

    const updated = db.prepare("SELECT * FROM role_permissions WHERE role = ?").get(role);
    logAudit(user.id, user.name, "تعديل صلاحيات", `تم تعديل صلاحيات الدور: ${role}`);
    res.json(updated);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
