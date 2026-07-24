import { Router } from "express";
import { db } from "../lib/sqlite";
import { getAuthUser } from "./auth";

const router = Router();

// Get inventory summary, valuation, and low stock items
router.get("/inventory/summary", (_req, res) => {
  const products = db.prepare(`
    SELECT p.id, p.number, p.name, p.price, p.cost, p.stock, c.name as categoryName
    FROM products p LEFT JOIN categories c ON c.id = p.category_id
    ORDER BY p.number
  `).all() as any[];

  const totalItems = products.length;
  let totalStockCount = 0;
  let totalStockCost = 0;
  let totalStockValue = 0;
  const lowStockItems: any[] = [];

  for (const p of products) {
    const stock = p.stock ?? 0;
    const cost = p.cost ?? 0;
    const price = p.price ?? 0;
    totalStockCount += stock;
    totalStockCost += stock * cost;
    totalStockValue += stock * price;

    if (stock <= 10) {
      lowStockItems.push(p);
    }
  }

  res.json({
    totalItems,
    totalStockCount,
    totalStockCost,
    totalStockValue,
    lowStockCount: lowStockItems.length,
    lowStockItems,
    products,
  });
});

// Get stock movements history
router.get("/inventory/movements", (req, res) => {
  const { productId } = req.query;
  let sql = `
    SELECT m.*, p.name as productName, p.number as productNumber
    FROM stock_movements m
    JOIN products p ON p.id = m.product_id
    WHERE 1=1
  `;
  const params: any[] = [];
  if (productId) {
    sql += " AND m.product_id = ?";
    params.push(productId);
  }
  sql += " ORDER BY m.id DESC LIMIT 100";
  const movements = db.prepare(sql).all(...params);
  res.json(movements);
});

// Adjust stock or record movement (In / Out / Adjustment)
router.post("/inventory/movement", (req, res) => {
  const user = getAuthUser(req);
  if (!user) {
    res.status(401).json({ error: "غير مصرح" });
    return;
  }

  const { productId, type, quantity, reason, referenceId } = req.body;
  if (!productId || !type || quantity === undefined) {
    res.status(400).json({ error: "بيانات ناقصة" });
    return;
  }

  const product = db.prepare("SELECT * FROM products WHERE id=?").get(productId) as any;
  if (!product) {
    res.status(404).json({ error: "المنتج غير موجود" });
    return;
  }

  const prevStock = product.stock ?? 0;
  let newStock = prevStock;
  const qty = Number(quantity);

  if (type === "in") {
    newStock = prevStock + qty;
  } else if (type === "out") {
    newStock = Math.max(0, prevStock - qty);
  } else if (type === "adjustment") {
    newStock = qty; // direct count adjustment
  }

  const diff = newStock - prevStock;

  db.transaction(() => {
    db.prepare("UPDATE products SET stock = ? WHERE id = ?").run(newStock, productId);
    db.prepare(`
      INSERT INTO stock_movements (product_id, type, quantity, previous_stock, new_stock, reason, reference_id, user_id, user_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(productId, type, Math.abs(diff), prevStock, newStock, reason || "تسوية مخزنية يدويّة", referenceId || null, user.id, user.name);
  })();

  res.json({ success: true, previousStock: prevStock, newStock });
});

export default router;
