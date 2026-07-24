import { Router } from "express";
import { db, createDoubleEntryJournal } from "../lib/sqlite";
import { getAuthUser } from "./auth";

const router = Router();

function formatOrder(o: any, items: any[]) {
  return {
    id: o.id,
    invoiceNumber: o.invoice_number,
    subtotal: o.subtotal,
    discount: o.discount,
    tax: o.tax,
    total: o.total,
    paymentMethod: o.payment_method,
    cashAmount: o.cash_amount,
    cardAmount: o.card_amount,
    customerId: o.customer_id,
    customerName: o.customer_name,
    userId: o.user_id,
    userName: o.user_name,
    note: o.note,
    orderType: o.order_type ?? "dine-in",
    tableNumber: o.table_number ?? null,
    createdAt: o.created_at,
    items: items.map(i => ({
      productId: i.product_id,
      productName: i.product_name,
      quantity: i.quantity,
      unitPrice: i.unit_price,
      total: i.total,
      categoryId: i.category_id ?? null,
      categoryName: i.category_name ?? null,
    })),
  };
}

router.get("/orders", (req, res) => {
  const { startDate, endDate, userId, orderType } = req.query;
  let sql = `
    SELECT o.*, u.name as user_name, c.name as customer_name
    FROM orders o
    LEFT JOIN users u ON u.id = o.user_id
    LEFT JOIN customers c ON c.id = o.customer_id
    WHERE 1=1
  `;
  const params: any[] = [];
  if (startDate) { sql += " AND DATE(o.created_at) >= ?"; params.push(startDate); }
  if (endDate) { sql += " AND DATE(o.created_at) <= ?"; params.push(endDate); }
  if (userId) { sql += " AND o.user_id=?"; params.push(userId); }
  if (orderType) { sql += " AND o.order_type=?"; params.push(orderType); }
  sql += " ORDER BY o.created_at DESC LIMIT 200";
  const orders = db.prepare(sql).all(...params) as any[];
  const result = orders.map(o => {
    const items = db.prepare("SELECT * FROM order_items WHERE order_id=?").all(o.id) as any[];
    return formatOrder(o, items);
  });
  res.json(result);
});

router.post("/orders", (req, res) => {
  const authUser = getAuthUser(req);
  if (!authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  const { items, paymentMethod, subtotal, discount, tax, total, cashAmount, cardAmount, customerId, userId, note, orderType, tableNumber } = req.body;
  if (!items?.length) { res.status(400).json({ error: "لا توجد منتجات" }); return; }

  const count = db.prepare("SELECT COUNT(*) as c FROM orders").get() as { c: number };
  const invoiceNumber = String(count.c + 1);
  const effectiveUserId = userId ?? authUser.id;

  const r = db.prepare(`
    INSERT INTO orders (invoice_number, subtotal, discount, tax, total, payment_method, cash_amount, card_amount, customer_id, user_id, note, order_type, table_number, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    invoiceNumber,
    subtotal ?? 0,
    discount ?? 0,
    tax ?? 0,
    total,
    paymentMethod ?? "cash",
    cashAmount ?? null,
    cardAmount ?? null,
    customerId ?? null,
    effectiveUserId,
    note ?? null,
    orderType ?? "dine-in",
    tableNumber ?? null,
    new Date().toISOString()
  );
  const orderId = r.lastInsertRowid;

  const insertItem = db.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, total, category_id, category_name)
    VALUES (?,?,?,?,?,?,?,?)
  `);

  let orderCogs = 0;

  for (const item of items) {
    const prod = db.prepare("SELECT p.*, c.name as cat_name FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.id=?").get(item.productId) as any;
    const name = prod?.name ?? "منتج محذوف";
    insertItem.run(orderId, item.productId, name, item.quantity, item.unitPrice, item.quantity * item.unitPrice, prod?.category_id ?? null, prod?.cat_name ?? null);

    if (prod) {
      // BOM recipe subtraction
      const recipes = db.prepare("SELECT * FROM product_recipes WHERE product_id=?").all(prod.id) as any[];
      if (recipes.length > 0) {
        let recipeCostSum = 0;
        for (const rec of recipes) {
          const ingProduct = db.prepare("SELECT * FROM products WHERE name=? COLLATE NOCASE LIMIT 1").get(rec.ingredient_name) as any;
          const totalQtyDeducted = (rec.quantity || 1) * item.quantity;
          if (ingProduct) {
            const prevStock = ingProduct.stock ?? 0;
            const newStock = Math.max(0, prevStock - totalQtyDeducted);
            db.prepare("UPDATE products SET stock=? WHERE id=?").run(newStock, ingProduct.id);

            // Log stock movement for raw ingredient
            db.prepare(`
              INSERT INTO stock_movements (product_id, type, quantity, previous_stock, new_stock, reason, reference_id, user_name)
              VALUES (?, 'out', ?, ?, ?, ?, ?, ?)
            `).run(ingProduct.id, totalQtyDeducted, prevStock, newStock, `استهلاك وصفة مبيعات لـ ${prod.name}`, orderId, authUser.name);

            recipeCostSum += (ingProduct.cost || 0) * (rec.quantity || 1);
          }
        }
        orderCogs += recipeCostSum * item.quantity;
      } else {
        // No recipe, deduct direct product stock
        const prevStock = prod.stock ?? 0;
        const newStock = Math.max(0, prevStock - item.quantity);
        db.prepare("UPDATE products SET stock=? WHERE id=?").run(newStock, prod.id);

        // Log stock movement
        db.prepare(`
          INSERT INTO stock_movements (product_id, type, quantity, previous_stock, new_stock, reason, reference_id, user_name)
          VALUES (?, 'out', ?, ?, ?, ?, ?, ?)
        `).run(prod.id, item.quantity, prevStock, newStock, "مبيعات مباشرة", orderId, authUser.name);

        orderCogs += (prod.cost || 0) * item.quantity;
      }
    }
  }

  // Create Balanced Double-Entry Journal for Order Sale
  try {
    const safeAccount = "11100"; // standard cashier box/safe
    const revenueAccount = "41000"; // Sales revenue

    const lines = [
      { account_code: safeAccount, debit: total, credit: 0, description: `مبيعات الفاتورة رقم ${invoiceNumber}` },
      { account_code: revenueAccount, debit: 0, credit: total, description: `إيراد مبيعات الفاتورة رقم ${invoiceNumber}` }
    ];

    if (orderCogs > 0) {
      // Debit COGS, Credit Inventory
      lines.push({ account_code: "51000", debit: orderCogs, credit: 0, description: `تكلفة البضاعة المباعة للفاتورة رقم ${invoiceNumber}` });
      lines.push({ account_code: "11300", debit: 0, credit: orderCogs, description: `تخفيض المخزون للمبيعات رقم ${invoiceNumber}` });
    }

    createDoubleEntryJournal(
      new Date().toISOString().slice(0, 10),
      `فاتورة مبيعات رقم ${invoiceNumber}`,
      "sale",
      orderId as number,
      lines
    );
  } catch (journalErr: any) {
    console.error("Failed to generate double entry for sale:", journalErr.message);
  }

  const order = db.prepare(`
    SELECT o.*, u.name as user_name, c.name as customer_name
    FROM orders o LEFT JOIN users u ON u.id=o.user_id LEFT JOIN customers c ON c.id=o.customer_id
    WHERE o.id=?
  `).get(orderId) as any;
  const orderItems = db.prepare("SELECT * FROM order_items WHERE order_id=?").all(orderId) as any[];
  res.status(201).json(formatOrder(order, orderItems));
});

/* ── البحث عن طلب بواسطة رقم الفاتورة أو ID للـ المرتجعات ── */
router.get("/orders/lookup", (req, res) => {
  const authUser = getAuthUser(req);
  if (!authUser) { res.status(401).json({ error: "غير مصرح" }); return; }

  const { q } = req.query as any;
  if (!q || !String(q).trim()) {
    res.status(400).json({ error: "مطلوب رقم الفاتورة للبحث" });
    return;
  }

  const qStr = String(q).trim();
  const cleanQ = qStr.replace(/^(inv-?|INV-?|#)/i, "").replace(/^0+/, "") || qStr;
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
         OR COALESCE(NULLIF(LTRIM(REPLACE(REPLACE(REPLACE(LOWER(o.invoice_number), 'inv-', ''), 'inv', ''), '#', ''), '0'), ''), '0') = ?
         OR (o.invoice_number LIKE ? AND ? <> '')
      ORDER BY o.created_at DESC
      LIMIT 20
    `).all(
      qStr,
      cleanQ,
      qStr,
      cleanQ,
      likePattern,
      cleanQ
    ) as any[];

    if (!orderRows || orderRows.length === 0) {
      res.status(404).json({ error: `لم يتم العثور على الفاتورة رقم "${qStr}"` });
      return;
    }

    const results = orderRows.map(orderRow => {
      const items = db.prepare("SELECT * FROM order_items WHERE order_id=?").all(orderRow.id) as any[];

      const existingReturns = db.prepare(`
        SELECT id, return_number, total_refund, created_at, status, reason
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
      const partiallyReturned = existingReturns.length > 0 && !fullyReturned;

      return {
        id: orderRow.id,
        invoiceNumber: orderRow.invoice_number,
        total: orderRow.total,
        subtotal: orderRow.subtotal,
        discount: orderRow.discount,
        tax: orderRow.tax,
        paymentMethod: orderRow.payment_method,
        orderType: orderRow.order_type ?? "dine-in",
        tableNumber: orderRow.table_number,
        note: orderRow.note,
        createdAt: orderRow.created_at,
        cashierName: orderRow.user_name ?? "الكاشير",
        userId: orderRow.user_id,
        customerName: orderRow.customer_name ?? null,
        alreadyReturned: existingReturns.length > 0,
        partiallyReturned,
        fullyReturned,
        previousReturns: existingReturns,
        items: itemsWithQty,
      };
    });

    res.json(results.length === 1 ? results[0] : results);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/orders/:id", (req, res) => {
  const order = db.prepare(`
    SELECT o.*, u.name as user_name, c.name as customer_name
    FROM orders o LEFT JOIN users u ON u.id=o.user_id LEFT JOIN customers c ON c.id=o.customer_id
    WHERE o.id=?
  `).get(req.params.id) as any;
  if (!order) { res.status(404).json({ error: "غير موجود" }); return; }
  const items = db.prepare("SELECT * FROM order_items WHERE order_id=?").all(order.id) as any[];
  res.json(formatOrder(order, items));
});

router.delete("/orders/:id", (req, res) => {
  const user = getAuthUser(req);
  if (!user || (user.role !== "admin" && user.role !== "developer")) { res.status(403).json({ error: "غير مصرح" }); return; }
  db.prepare("DELETE FROM orders WHERE id=?").run(req.params.id);
  res.status(204).send();
});

export default router;
