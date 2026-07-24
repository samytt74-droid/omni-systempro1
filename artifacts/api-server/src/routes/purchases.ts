import { Router } from "express";
import { db, logAudit, createDoubleEntryJournal } from "../lib/sqlite";
import { getAuthUser } from "./auth";

const router = Router();

function requireAuth(req: any, res: any): any {
  const user = getAuthUser(req);
  if (!user) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return user;
}

router.get("/purchases", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const purchases = db.prepare(`
    SELECT po.*, s.name as supplier_name
    FROM purchase_orders po
    LEFT JOIN suppliers s ON s.id = po.supplier_id
    ORDER BY po.created_at DESC
  `).all();
  const result = purchases.map((p: any) => ({
    ...p,
    items: db.prepare("SELECT * FROM purchase_order_items WHERE purchase_order_id=?").all(p.id)
  }));
  res.json(result);
});

router.post("/purchases", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const { supplier_id, items, notes } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: "عناصر أمر الشراء مطلوبة" });
    return;
  }
  const total = items.reduce((sum: number, it: any) => sum + (it.unit_price * it.quantity), 0);
  const countRow = db.prepare("SELECT COUNT(*) as c FROM purchase_orders").get() as { c: number };
  const poNum = `PO-${String(countRow.c + 1).padStart(4, "0")}`;

  const r = db.prepare("INSERT INTO purchase_orders (po_number, supplier_id, status, total, notes) VALUES (?,?,?,?,?)")
    .run(poNum, supplier_id ?? null, "received", total, notes ?? null);
  const poId = r.lastInsertRowid;

  const insertItem = db.prepare("INSERT INTO purchase_order_items (purchase_order_id, product_id, product_name, quantity, unit_price, total) VALUES (?,?,?,?,?,?)");
  for (const it of items) {
    insertItem.run(poId, it.product_id ?? null, it.product_name, it.quantity, it.unit_price, it.unit_price * it.quantity);
    if (it.product_id) {
      db.prepare("UPDATE products SET stock = COALESCE(stock, 0) + ?, cost = ? WHERE id=?").run(it.quantity, it.unit_price, it.product_id);
    }
  }

  if (supplier_id) {
    db.prepare("UPDATE suppliers SET balance = balance + ? WHERE id=?").run(total, supplier_id);
  }

  // Create balanced double-entry journal for purchase
  try {
    const isSupplier = !!supplier_id;
    let creditAccount = "11100"; // Default Cash box
    let descriptionDetail = `شراء نقدي`;
    
    if (isSupplier) {
      creditAccount = "21100"; // Accounts Payable (الموردين)
      const supplier = db.prepare("SELECT name FROM suppliers WHERE id=?").get(supplier_id) as any;
      descriptionDetail = `شراء آجل من المورد ${supplier?.name ?? 'غير معروف'}`;
    }

    createDoubleEntryJournal(
      new Date().toISOString().slice(0, 10),
      `فاتورة شراء رقم ${poNum} - ${descriptionDetail}`,
      "purchase",
      poId as number,
      [
        { account_code: "11300", debit: total, credit: 0, description: `إضافة منتجات ومواد خام إلى المخزون` },
        { account_code: creditAccount, debit: 0, credit: total, description: `استحقاق قيمة الشراء رقم ${poNum}` }
      ]
    );
  } catch (journalErr: any) {
    console.error("Failed to generate double entry for purchase:", journalErr.message);
  }

  logAudit(user.id, user.name, "أمر شراء", `إنشاء أمر شراء رقم ${poNum} بمبلغ ${total}`);
  res.status(201).json({ id: poId, po_number: poNum, total, status: "received" });
});

export default router;
