import { Router } from "express";
import { db, logAudit, createDoubleEntryJournal } from "../lib/sqlite";
import { getAuthUser } from "./auth";

const router = Router();

function requireAuth(req: any, res: any): any {
  const user = getAuthUser(req);
  if (!user) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return user;
}

function requireAdmin(req: any, res: any): boolean {
  const user = getAuthUser(req);
  if (!user || (user.role !== "admin" && user.role !== "developer")) {
    res.status(403).json({ error: "غير مصرح للمشرفين فقط" });
    return false;
  }
  return true;
}

// Get all returns
router.get("/returns", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;

  const { startDate, endDate, search } = req.query as any;
  let sql = `
    SELECT r.*, u.name as cashier_name, c.name as customer_name, app.name as approver_name
    FROM returns r
    LEFT JOIN users u ON u.id=r.user_id
    LEFT JOIN customers c ON c.id=r.customer_id
    LEFT JOIN users app ON app.id=r.approved_by
    WHERE 1=1
  `;
  const params: any[] = [];
  if (startDate) { sql += " AND DATE(r.created_at)>=?"; params.push(startDate); }
  if (endDate) { sql += " AND DATE(r.created_at)<=?"; params.push(endDate); }
  if (search) { sql += " AND (r.return_number LIKE ? OR r.invoice_number LIKE ?)"; params.push(`%${search}%`, `%${search}%`); }
  sql += " ORDER BY r.created_at DESC";
  
  try {
    const rows = db.prepare(sql).all(...params) as any[];
    const result = rows.map(r => {
      const items = db.prepare("SELECT * FROM return_items WHERE return_id=?").all(r.id);
      return { ...r, items };
    });
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Get a single return
router.get("/returns/:id", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;

  try {
    const row = db.prepare(`
      SELECT r.*, u.name as cashier_name, c.name as customer_name, app.name as approver_name
      FROM returns r
      LEFT JOIN users u ON u.id=r.user_id
      LEFT JOIN customers c ON c.id=r.customer_id
      LEFT JOIN users app ON app.id=r.approved_by
      WHERE r.id=?
    `).get(req.params.id) as any;
    if (!row) { res.status(404).json({ error: "المرتجع غير موجود" }); return; }
    row.items = db.prepare("SELECT * FROM return_items WHERE return_id=?").all(row.id);
    res.json(row);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Create a return (with automatic manager approval checks)
router.post("/returns", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;

  const { invoice_number, order_id, reason, payment_method, customer_id, notes, items, requires_approval } = req.body;
  if (!invoice_number || !items || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: "رقم الفاتورة والمنتجات المرتجعة مطلوبة" });
    return;
  }

  try {
    const total_refund = items.reduce((sum: number, item: any) => sum + (item.unit_price * item.quantity), 0);
    
    // Check if manager approval is required (Cashiers require approval for returns above 5,000, or if requested)
    const isAdmin = user.role === "admin" || user.role === "developer";
    const status = (requires_approval || (!isAdmin && total_refund > 5000)) ? "pending_approval" : "approved";
    
    const countRow = db.prepare("SELECT COUNT(*) as c FROM returns").get() as { c: number };
    const returnNum = `RET-${String(countRow.c + 1).padStart(4, "0")}-${Date.now().toString().slice(-6)}`;
    
    const approved_by = status === "approved" ? user.id : null;
    const approved_at = status === "approved" ? new Date().toISOString() : null;

    const r = db.prepare(`
      INSERT INTO returns (return_number, invoice_number, order_id, reason, total_refund, payment_method, customer_id, user_id, notes, status, approved_by, approved_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      returnNum,
      invoice_number,
      order_id ?? null,
      reason ?? null,
      total_refund,
      payment_method ?? "cash",
      customer_id ?? null,
      user.id,
      notes ?? null,
      status,
      approved_by,
      approved_at
    );

    const returnId = r.lastInsertRowid;
    const insertItem = db.prepare(`
      INSERT INTO return_items (return_id, product_id, product_name, quantity, unit_price, total)
      VALUES (?,?,?,?,?,?)
    `);

    let totalCostOfReturnedItems = 0;

    for (const item of items) {
      insertItem.run(returnId, item.product_id ?? null, item.product_name, item.quantity, item.unit_price, item.unit_price * item.quantity);
      
      // Stock update and COGS compilation ONLY if approved right away
      if (status === "approved" && item.product_id) {
        db.prepare("UPDATE products SET stock = COALESCE(stock, 0) + ? WHERE id=?").run(item.quantity, item.product_id);
        
        // Accumulate item cost for COGS adjustment
        const prod = db.prepare("SELECT cost FROM products WHERE id=?").get(item.product_id) as any;
        if (prod && prod.cost) {
          totalCostOfReturnedItems += Number(prod.cost) * Number(item.quantity);
        }
      }
    }

    // Generate accounting double entry if approved
    if (status === "approved") {
      try {
        const tax_refund = Math.round(total_refund * 0.15 / 1.15); // 15% VAT reverse
        const subtotal_refund = total_refund - tax_refund;

        const creditAccountCode = payment_method === "credit" ? "11200" : "11100"; // credit to customer account or safe cash

        // 1. Sales & VAT Reverse
        createDoubleEntryJournal(
          new Date().toISOString().slice(0, 10),
          `مرتجع مبيعات رقم ${returnNum} لفاتورة ${invoice_number}`,
          "return",
          returnId,
          [
            { account_code: "41000", debit: subtotal_refund, credit: 0, description: `إلغاء جزء من إيرادات المبيعات لفاتورة ${invoice_number}` },
            { account_code: "21000", debit: tax_refund, credit: 0, description: `عكس ضريبة القيمة المضافة المحتسبة` },
            { account_code: creditAccountCode, debit: 0, credit: total_refund, description: `إرجاع القيمة للعميل عبر ${payment_method}` }
          ]
        );

        // 2. COGS & Stock Adjustment (Debit Stock Asset, Credit COGS Expense)
        if (totalCostOfReturnedItems > 0) {
          createDoubleEntryJournal(
            new Date().toISOString().slice(0, 10),
            `تسوية تكلفة البضاعة المباعة والمخزون لمرتجع ${returnNum}`,
            "return",
            returnId,
            [
              { account_code: "11300", debit: totalCostOfReturnedItems, credit: 0, description: `إعادة المواد للمخزون والسلع` },
              { account_code: "51000", debit: 0, credit: totalCostOfReturnedItems, description: `تخفيض تكلفة المبيعات للفترة` }
            ]
          );
        }

        // Also if customer account is credited, update customer balance in erp/customers if applicable
        if (payment_method === "credit" && customer_id) {
          db.prepare("UPDATE suppliers SET balance = balance - ? WHERE id=?").run(total_refund, customer_id); // or customer balance if we tracking it
        }

      } catch (jeErr: any) {
        console.error("Accounting journal error during return creation:", jeErr.message);
      }
    }

    logAudit(user.id, user.name, "تسجيل مرتجع", `تسجيل مرتجع رقم ${returnNum} لفاتورة ${invoice_number} بقيمة ${total_refund} [حالة: ${status}]`);

    const created = db.prepare(`
      SELECT r.*, u.name as cashier_name FROM returns r
      LEFT JOIN users u ON u.id=r.user_id WHERE r.id=?
    `).get(returnId) as any;
    created.items = db.prepare("SELECT * FROM return_items WHERE return_id=?").all(returnId);
    res.status(201).json(created);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Approve a pending return
router.post("/returns/:id/approve", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const user = getAuthUser(req);

  try {
    const returnRow = db.prepare("SELECT * FROM returns WHERE id=?").get(req.params.id) as any;
    if (!returnRow) { res.status(404).json({ error: "المرتجع غير موجود" }); return; }
    if (returnRow.status === "approved") { res.status(400).json({ error: "المرتجع معتمد ومكتمل مسبقاً" }); return; }

    const items = db.prepare("SELECT * FROM return_items WHERE return_id=?").all(returnRow.id) as any[];
    let totalCostOfReturnedItems = 0;

    // 1. Restock items & compute cost
    for (const item of items) {
      if (item.product_id) {
        db.prepare("UPDATE products SET stock = COALESCE(stock, 0) + ? WHERE id=?").run(item.quantity, item.product_id);
        const prod = db.prepare("SELECT cost FROM products WHERE id=?").get(item.product_id) as any;
        if (prod && prod.cost) {
          totalCostOfReturnedItems += Number(prod.cost) * Number(item.quantity);
        }
      }
    }

    // 2. Mark as approved
    db.prepare("UPDATE returns SET status='approved', approved_by=?, approved_at=datetime('now') WHERE id=?").run(user.id, returnRow.id);

    // 3. Balanced Ledger Entries
    try {
      const total_refund = returnRow.total_refund;
      const tax_refund = Math.round(total_refund * 0.15 / 1.15);
      const subtotal_refund = total_refund - tax_refund;

      const creditAccountCode = returnRow.payment_method === "credit" ? "11200" : "11100";

      // Sales & Tax reverse
      createDoubleEntryJournal(
        new Date().toISOString().slice(0, 10),
        `مرتجع مبيعات رقم ${returnRow.return_number} لفاتورة ${returnRow.invoice_number}`,
        "return",
        returnRow.id,
        [
          { account_code: "41000", debit: subtotal_refund, credit: 0, description: `إلغاء جزء من إيرادات المبيعات لفاتورة ${returnRow.invoice_number}` },
          { account_code: "21000", debit: tax_refund, credit: 0, description: `عكس ضريبة القيمة المضافة المحتسبة` },
          { account_code: creditAccountCode, debit: 0, credit: total_refund, description: `إرجاع القيمة للعميل عبر ${returnRow.payment_method}` }
        ]
      );

      // COGS Adjustment
      if (totalCostOfReturnedItems > 0) {
        createDoubleEntryJournal(
          new Date().toISOString().slice(0, 10),
          `تسوية تكلفة البضاعة المباعة والمخزون لمرتجع ${returnRow.return_number}`,
          "return",
          returnRow.id,
          [
            { account_code: "11300", debit: totalCostOfReturnedItems, credit: 0, description: `إعادة المواد للمخزون والسلع` },
            { account_code: "51000", debit: 0, credit: totalCostOfReturnedItems, description: `تخفيض تكلفة المبيعات للفترة` }
          ]
        );
      }
    } catch (jeErr: any) {
      console.error("Accounting journal error during return approval:", jeErr.message);
    }

    logAudit(user.id, user.name, "اعتماد مرتجع", `تم اعتماد المرتجع رقم ${returnRow.return_number} بقيمة ${returnRow.total_refund} وإعادة البضائع للمخازن`);
    res.json({ success: true, status: "approved" });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Delete return
router.delete("/returns/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const user = getAuthUser(req);

  try {
    const row = db.prepare("SELECT * FROM returns WHERE id=?").get(req.params.id) as any;
    if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
    
    const returnItems = db.prepare("SELECT * FROM return_items WHERE return_id=?").all(row.id) as any[];
    
    // Revert stock updates only if previously approved
    if (row.status === "approved") {
      for (const item of returnItems) {
        if (item.product_id) {
          db.prepare("UPDATE products SET stock = MAX(0, COALESCE(stock, 0) - ?) WHERE id=?").run(item.quantity, item.product_id);
        }
      }
    }

    db.prepare("DELETE FROM returns WHERE id=?").run(req.params.id);
    logAudit(user.id, user.name, "حذف مرتجع", `حذف مرتجع رقم ${row.return_number}`);
    res.status(204).send();
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/returns-summary", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + "-01";
  
  try {
    const todayStats = db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(total_refund),0) as total FROM returns WHERE DATE(created_at)=?").get(today) as any;
    const monthStats = db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(total_refund),0) as total FROM returns WHERE DATE(created_at)>=?").get(monthStart) as any;
    const totalCount = (db.prepare("SELECT COUNT(*) as c FROM returns").get() as any).c;
    res.json({
      todayCount: todayStats.count,
      todayTotal: todayStats.total,
      monthCount: monthStats.count,
      monthTotal: monthStats.total,
      totalCount,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/* ── البحث عن طلب بواسطة رقم الفاتورة أو ID ── */
router.get("/orders/lookup", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const { q } = req.query as any;
  if (!q) { res.status(400).json({ error: "مطلوب معيار البحث" }); return; }

  const qStr = String(q).trim();
  const cleanQ = qStr.replace(/^(inv-?|INV-?)/i, "").replace(/^0+/, "") || "0";
  const likePattern = `%${cleanQ}%`;

  try {
    const orderRows = db.prepare(`
      SELECT o.*, u.name as user_name, c.name as customer_name
      FROM orders o
      LEFT JOIN users u ON u.id=o.user_id
      LEFT JOIN customers c ON c.id=o.customer_id
      WHERE o.invoice_number = ?
         OR o.invoice_number = ?
         OR CAST(o.id AS TEXT) = ?
         OR COALESCE(NULLIF(LTRIM(REPLACE(REPLACE(LOWER(o.invoice_number), 'inv-', ''), 'inv', ''), '0'), ''), '0') = ?
         OR (o.invoice_number LIKE ? AND ? <> '')
      ORDER BY o.created_at DESC
      LIMIT 50
    `).all(
      qStr,
      cleanQ,
      qStr,
      cleanQ,
      likePattern,
      cleanQ
    ) as any[];

    const results = orderRows.map(orderRow => {
      const items = db.prepare("SELECT * FROM order_items WHERE order_id=?").all(orderRow.id) as any[];

      const existingReturns = db.prepare(`
        SELECT id, return_number, total_refund, created_at, status 
        FROM returns 
        WHERE order_id=? OR invoice_number=?
      `).all(orderRow.id, orderRow.invoice_number) as any[];

      const returnedQtyRows = db.prepare(`
        SELECT product_id, SUM(quantity) as returned_qty
        FROM return_items ri
        JOIN returns r ON r.id = ri.return_id
        WHERE r.order_id = ? OR r.invoice_number = ?
        GROUP BY product_id
      `).all(orderRow.id, orderRow.invoice_number) as any[];

      const returnedQtyMap: Record<number, number> = {};
      for (const row of returnedQtyRows) {
        if (row.product_id) {
          returnedQtyMap[row.product_id] = Number(row.returned_qty || 0);
        }
      }

      const itemsWithQty = items.map(i => {
        const returnedQuantity = returnedQtyMap[i.product_id] || 0;
        const remainingQuantity = Math.max(0, i.quantity - returnedQuantity);
        return {
          id: i.id,
          productId: i.product_id,
          productName: i.product_name,
          quantity: i.quantity,
          returnedQuantity,
          remainingQuantity,
          unitPrice: i.unit_price,
          total: i.total,
          categoryId: i.category_id,
          categoryName: i.category_name,
        };
      });

      const fullyReturned = itemsWithQty.length > 0 && itemsWithQty.every(item => item.remainingQuantity <= 0);

      return {
        id: orderRow.id,
        invoiceNumber: orderRow.invoice_number,
        total: orderRow.total,
        subtotal: orderRow.subtotal,
        discount: orderRow.discount,
        tax: orderRow.tax,
        paymentMethod: orderRow.payment_method,
        orderType: orderRow.order_type,
        tableNumber: orderRow.table_number,
        note: orderRow.note,
        createdAt: orderRow.created_at,
        cashierName: orderRow.user_name,
        userId: orderRow.user_id,
        customerName: orderRow.customer_name,
        alreadyReturned: existingReturns.length > 0,
        existingReturns,
        fullyReturned,
        items: itemsWithQty,
      };
    });

    res.json(results);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/* ── ملخص صناديق الكاشيرين ── */
router.get("/cashier-boxes", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { date } = req.query as any;
  const filterDate = date ?? new Date().toISOString().slice(0, 10);

  try {
    let cashiers = db.prepare(`
      SELECT u.id, u.name, u.role,
        COALESCE(SUM(o.total),0) as orders_total,
        COUNT(o.id) as orders_count
      FROM users u
      LEFT JOIN orders o ON o.user_id=u.id AND DATE(o.created_at)=?
      WHERE u.active=1
      GROUP BY u.id, u.name, u.role
      ORDER BY u.name
    `).all(filterDate) as any[];

    const user = getAuthUser(req);
    if (user && user.role !== "developer") {
      cashiers = cashiers.filter(c => c.role !== "developer");
    }

    const returns_ = db.prepare(`
      SELECT o.user_id,
        COALESCE(SUM(r.total_refund),0) as returns_total,
        COUNT(r.id) as returns_count
      FROM returns r
      LEFT JOIN orders o ON o.id=r.order_id
      WHERE DATE(r.created_at)=?
      GROUP BY o.user_id
    `).all(filterDate) as any[];

    const returnsMap = new Map(returns_.map(r => [r.user_id, r]));

    const mainTotal = cashiers.reduce((s, c) => s + c.orders_total, 0);
    const mainReturns = returns_.reduce((s, r) => s + r.returns_total, 0);

    res.json({
      date: filterDate,
      mainBox: { total: mainTotal, returnsTotal: mainReturns, net: mainTotal - mainReturns },
      cashiers: cashiers.map(c => {
        const ret = returnsMap.get(c.id);
        return {
          userId: c.id,
          name: c.name,
          ordersTotal: c.orders_total,
          ordersCount: c.orders_count,
          returnsTotal: ret?.returns_total ?? 0,
          returnsCount: ret?.returns_count ?? 0,
          net: c.orders_total - (ret?.returns_total ?? 0),
        };
      }),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Get returns analytics by category (linking categories with returns)
router.get("/returns/categories-analytics", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;

  try {
    const rows = db.prepare(`
      SELECT 
        c.id, 
        c.name, 
        c.color,
        COALESCE(c.cost, 0) as cost, 
        COALESCE(c.revenue, 0) as revenue,
        COALESCE(SUM(ri.total), 0) as total_returned_amount,
        COALESCE(SUM(ri.quantity), 0) as total_returned_qty
      FROM categories c
      LEFT JOIN products p ON p.category_id = c.id
      LEFT JOIN return_items ri ON ri.product_id = p.id
      LEFT JOIN returns r ON r.id = ri.return_id AND r.status = 'approved'
      GROUP BY c.id
      ORDER BY c.name
    `).all();
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
