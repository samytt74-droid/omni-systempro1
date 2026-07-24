import { Router } from "express";
import { db, logAudit, createDoubleEntryJournal } from "../lib/sqlite";
import { getAuthUser } from "./auth";

const router = Router();

function requireAuth(req: any, res: any): any {
  const user = getAuthUser(req);
  if (!user) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return user;
}

router.get("/expenses", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const expenses = db.prepare(`
    SELECT e.*, u.name as user_name, s.name as safe_name
    FROM expenses e
    LEFT JOIN users u ON u.id = e.user_id
    LEFT JOIN safes s ON s.id = e.safe_id
    ORDER BY e.expense_date DESC, e.id DESC
  `).all();
  res.json(expenses);
});

router.post("/expenses", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const { category, amount, expense_date, notes, safe_id } = req.body;
  if (!category || !amount) { res.status(400).json({ category, amount, error: "التصنيف والمبلغ مطلوبان" }); return; }
  
  let finalSafeId = safe_id;
  if (!finalSafeId) {
    const defaultSafe = db.prepare("SELECT id FROM safes WHERE name = 'الصندوق الرئيسي' LIMIT 1").get() as any;
    if (defaultSafe) finalSafeId = defaultSafe.id;
  }

  const cleanDate = expense_date ?? new Date().toISOString().slice(0, 10);

  const r = db.prepare("INSERT INTO expenses (category, amount, expense_date, notes, user_id, safe_id) VALUES (?,?,?,?,?,?)")
    .run(category, amount, cleanDate, notes ?? null, user.id, finalSafeId ?? null);
  const expenseId = r.lastInsertRowid;
  
  if (finalSafeId) {
    db.prepare("UPDATE safes SET balance = balance - ? WHERE id = ?").run(amount, finalSafeId);
  }

  // Create balanced double-entry journal entry for Expense
  try {
    const expenseAccountCode = (category === "مرتبات" || category === "رواتب") ? "63000" : "61000";
    const safeAccountCode = "11100"; // Cash on Hand

    createDoubleEntryJournal(
      cleanDate,
      `تسجيل مصروف - تصنيف: ${category} - البيان: ${notes ?? 'مصاريف تشغيلية'}`,
      "expense",
      expenseId as number,
      [
        { account_code: expenseAccountCode, debit: amount, credit: 0, description: `إثبات مصروف تشغيلي - ${category}` },
        { account_code: safeAccountCode, debit: 0, credit: amount, description: `دفع نقدي لقيمة المصروف` }
      ]
    );
  } catch (journalErr: any) {
    console.error("Failed to generate double entry for expense:", journalErr.message);
  }

  logAudit(user.id, user.name, "إضافة مصروف", `مصروف ${category} بمبلغ ${amount} من الصندوق رقم ${finalSafeId}`);
  res.status(201).json({ id: expenseId, category, amount, expense_date: cleanDate, notes, user_id: user.id, safe_id: finalSafeId });
});

router.delete("/expenses/:id", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  
  const expense = db.prepare("SELECT amount, safe_id FROM expenses WHERE id = ?").get(req.params.id) as any;
  if (expense) {
    if (expense.safe_id) {
      db.prepare("UPDATE safes SET balance = balance + ? WHERE id = ?").run(expense.amount, expense.safe_id);
    }
  }

  db.prepare("DELETE FROM expenses WHERE id=?").run(req.params.id);
  logAudit(user.id, user.name, "حذف مصروف", `رقم المصروف: ${req.params.id}`);
  res.status(204).send();
});

export default router;
