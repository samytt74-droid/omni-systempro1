import { Router } from "express";
import { db } from "../lib/sqlite";

const router = Router();

router.get("/reports/sales", (req, res) => {
  const { startDate, endDate, groupBy = "day" } = req.query;
  let format = "%Y-%m-%d";
  if (groupBy === "month") format = "%Y-%m";
  if (groupBy === "year") format = "%Y";

  let sql = `
    SELECT strftime(?, created_at) as period,
           COALESCE(SUM(total), 0) as total,
           COALESCE(SUM(subtotal), 0) as subtotal,
           COALESCE(SUM(discount), 0) as discount,
           COALESCE(SUM(tax), 0) as tax,
           COUNT(*) as orders
    FROM orders WHERE 1=1
  `;
  const params: any[] = [format];
  if (startDate) { sql += " AND DATE(created_at)>=?"; params.push(startDate); }
  if (endDate) { sql += " AND DATE(created_at)<=?"; params.push(endDate); }
  sql += " GROUP BY period ORDER BY period";

  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

router.get("/reports/by-cashier", (req, res) => {
  const { startDate, endDate } = req.query;
  let sql = `
    SELECT u.id as userId, u.name as userName,
           COUNT(o.id) as orders,
           COALESCE(SUM(o.total), 0) as total,
           COALESCE(SUM(o.subtotal), 0) as subtotal,
           COALESCE(SUM(o.discount), 0) as discount,
           COALESCE(SUM(o.tax), 0) as tax
    FROM orders o
    JOIN users u ON u.id = o.user_id
    WHERE 1=1
  `;
  const params: any[] = [];
  if (startDate) { sql += " AND DATE(o.created_at)>=?"; params.push(startDate); }
  if (endDate) { sql += " AND DATE(o.created_at)<=?"; params.push(endDate); }
  sql += " GROUP BY u.id, u.name ORDER BY total DESC";

  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

router.get("/reports/by-product", (req, res) => {
  const { startDate, endDate, limit = "20" } = req.query;
  let sql = `
    SELECT oi.product_id as productId, oi.product_name as productName,
           oi.category_name as categoryName,
           SUM(oi.quantity) as totalQty,
           COALESCE(SUM(oi.total), 0) as totalRevenue,
           COALESCE(SUM((oi.unit_price - COALESCE(p.cost, 0)) * oi.quantity), 0) as totalProfit,
           COUNT(DISTINCT oi.order_id) as orderCount
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE 1=1
  `;
  const params: any[] = [];
  if (startDate) { sql += " AND DATE(o.created_at)>=?"; params.push(startDate); }
  if (endDate) { sql += " AND DATE(o.created_at)<=?"; params.push(endDate); }
  sql += " GROUP BY oi.product_id, oi.product_name, oi.category_name ORDER BY totalQty DESC LIMIT ?";
  params.push(Number(limit) || 20);

  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

router.get("/reports/by-category", (req, res) => {
  const { startDate, endDate } = req.query;
  let sql = `
    SELECT oi.category_id as categoryId,
           COALESCE(oi.category_name, 'غير مصنّف') as categoryName,
           SUM(oi.quantity) as totalQty,
           COALESCE(SUM(oi.total), 0) as totalRevenue,
           COUNT(DISTINCT oi.order_id) as orderCount
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE 1=1
  `;
  const params: any[] = [];
  if (startDate) { sql += " AND DATE(o.created_at)>=?"; params.push(startDate); }
  if (endDate) { sql += " AND DATE(o.created_at)<=?"; params.push(endDate); }
  sql += " GROUP BY oi.category_id, oi.category_name ORDER BY totalRevenue DESC";

  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

router.get("/reports/by-payment", (req, res) => {
  const { startDate, endDate } = req.query;
  let sql = `
    SELECT payment_method as paymentMethod,
           COUNT(*) as orders,
           COALESCE(SUM(total), 0) as total
    FROM orders WHERE 1=1
  `;
  const params: any[] = [];
  if (startDate) { sql += " AND DATE(created_at)>=?"; params.push(startDate); }
  if (endDate) { sql += " AND DATE(created_at)<=?"; params.push(endDate); }
  sql += " GROUP BY payment_method ORDER BY total DESC";

  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

export default router;
