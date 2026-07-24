import { Router } from "express";
import { db } from "../lib/sqlite";

const router = Router();

router.get("/dashboard/summary", (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + "-01";

  const todayStats = db.prepare(`
    SELECT COALESCE(SUM(total),0) as sales, COUNT(*) as orders
    FROM orders WHERE DATE(created_at)=?
  `).get(today) as any;

  const todayProfit = db.prepare(`
    SELECT COALESCE(SUM((oi.unit_price - COALESCE(p.cost,0)) * oi.quantity), 0) as profit
    FROM order_items oi
    JOIN orders o ON o.id=oi.order_id
    LEFT JOIN products p ON p.id=oi.product_id
    WHERE DATE(o.created_at)=?
  `).get(today) as any;

  const monthStats = db.prepare(`
    SELECT COALESCE(SUM(total),0) as sales, COUNT(*) as orders
    FROM orders WHERE DATE(created_at)>=?
  `).get(monthStart) as any;

  const totalProducts = (db.prepare("SELECT COUNT(*) as c FROM products WHERE active=1").get() as any).c;
  const totalCustomers = (db.prepare("SELECT COUNT(*) as c FROM customers").get() as any).c;

  res.json({
    todaySales: todayStats.sales,
    todayOrders: todayStats.orders,
    todayProfit: todayProfit.profit,
    monthSales: monthStats.sales,
    monthOrders: monthStats.orders,
    totalProducts,
    totalCustomers,
  });
});

router.get("/dashboard/top-products", (_req, res) => {
  const monthStart = new Date().toISOString().slice(0, 7) + "-01";
  const rows = db.prepare(`
    SELECT oi.product_id as productId, oi.product_name as productName,
           SUM(oi.quantity) as totalQty, SUM(oi.total) as totalRevenue
    FROM order_items oi
    JOIN orders o ON o.id=oi.order_id
    WHERE DATE(o.created_at)>=?
    GROUP BY oi.product_id, oi.product_name
    ORDER BY totalQty DESC LIMIT 10
  `).all(monthStart);
  res.json(rows);
});

router.get("/dashboard/sales-by-hour", (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT CAST(strftime('%H', created_at) AS INTEGER) as hour,
           COALESCE(SUM(total),0) as total, COUNT(*) as orders
    FROM orders
    WHERE DATE(created_at)=?
    GROUP BY hour ORDER BY hour
  `).all(today);

  const result = Array.from({ length: 24 }, (_, h) => {
    const found = (rows as any[]).find(r => r.hour === h);
    return { hour: h, total: found?.total ?? 0, orders: found?.orders ?? 0 };
  });
  res.json(result);
});

export default router;
