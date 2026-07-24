import { Router } from "express";
import { db, logAudit } from "../lib/sqlite";
import { getAuthUser } from "./auth";

const router = Router();

function requireAuth(req: any, res: any): any {
  const user = getAuthUser(req);
  if (!user) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return user;
}

router.get("/shifts/active", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const shift = db.prepare("SELECT * FROM cash_shifts WHERE user_id=? AND status='open' ORDER BY id DESC LIMIT 1").get(user.id);
  res.json(shift ?? null);
});

router.post("/shifts/open", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const { starting_cash } = req.body;
  const activeShift = db.prepare("SELECT id FROM cash_shifts WHERE user_id=? AND status='open'").get(user.id);
  if (activeShift) {
    res.status(400).json({ error: "لديك وردية مفتوحة بالفعل" });
    return;
  }
  const r = db.prepare("INSERT INTO cash_shifts (user_id, user_name, starting_cash, status) VALUES (?,?,?, 'open')")
    .run(user.id, user.name, starting_cash ?? 0);
  logAudit(user.id, user.name, "فتح وردية", `بدء وردية بمبلغ أساسي ${starting_cash ?? 0}`);
  res.status(201).json({ id: r.lastInsertRowid, starting_cash: starting_cash ?? 0, status: "open" });
});

router.post("/shifts/close", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const { shift_id, actual_cash, withdrawals, deposits } = req.body;
  const shift = db.prepare("SELECT * FROM cash_shifts WHERE id=? AND user_id=? AND status='open'").get(shift_id, user.id) as any;
  if (!shift) {
    res.status(404).json({ error: "الوردية غير موجودة أو مغلقة مسبقاً" });
    return;
  }

  // Calculate sales during shift time
  const sales = db.prepare(`
    SELECT 
      COALESCE(SUM(CASE WHEN payment_method='cash' THEN total ELSE 0 END), 0) as cash_sales,
      COALESCE(SUM(CASE WHEN payment_method!='cash' THEN total ELSE 0 END), 0) as card_sales
    FROM orders 
    WHERE user_id=? AND created_at >= ?
  `).get(user.id, shift.start_time) as any;

  const cashSales = sales.cash_sales;
  const cardSales = sales.card_sales;
  const withAmt = withdrawals ?? 0;
  const depAmt = deposits ?? 0;

  const expectedCash = shift.starting_cash + cashSales + depAmt - withAmt;
  const actCash = actual_cash ?? expectedCash;
  const difference = actCash - expectedCash;

  db.prepare(`
    UPDATE cash_shifts 
    SET end_time = datetime('now'), cash_sales = ?, card_sales = ?, withdrawals = ?, deposits = ?, actual_cash = ?, difference = ?, status = 'closed'
    WHERE id = ?
  `).run(cashSales, cardSales, withAmt, depAmt, actCash, difference, shift.id);

  logAudit(user.id, user.name, "إغلاق وردية", `إغلاق الوردية رقم ${shift.id} - العجز/الزيادة: ${difference}`);
  res.json({ success: true, expectedCash, actualCash: actCash, difference, cashSales, cardSales });
});

export default router;
