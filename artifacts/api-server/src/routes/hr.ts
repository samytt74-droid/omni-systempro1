import { Router } from "express";
import { db } from "../lib/sqlite";
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

/* ── Departments ── */
router.get("/hr/departments", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const rows = db.prepare("SELECT * FROM hr_departments ORDER BY name").all();
  res.json(rows);
});

router.post("/hr/departments", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { name, budget } = req.body;
  if (!name) { res.status(400).json({ error: "اسم القسم مطلوب" }); return; }
  const r = db.prepare("INSERT INTO hr_departments (name, budget) VALUES (?,?)").run(name, budget ?? 0);
  res.status(201).json(db.prepare("SELECT * FROM hr_departments WHERE id=?").get(r.lastInsertRowid));
});

router.put("/hr/departments/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { name, budget } = req.body;
  db.prepare("UPDATE hr_departments SET name=?, budget=? WHERE id=?").run(name, budget ?? 0, req.params.id);
  res.json(db.prepare("SELECT * FROM hr_departments WHERE id=?").get(req.params.id));
});

router.delete("/hr/departments/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  db.prepare("DELETE FROM hr_departments WHERE id=?").run(req.params.id);
  res.status(204).send();
});

/* ── Employees ── */
router.get("/hr/employees", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const rows = db.prepare(`
    SELECT e.*, d.name as department_name
    FROM hr_employees e
    LEFT JOIN hr_departments d ON d.id = e.department_id
    ORDER BY e.name
  `).all() as any[];
  res.json(rows.map(r => ({ ...r, active: Boolean(r.active) })));
});

router.get("/hr/employees/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const row = db.prepare(`
    SELECT e.*, d.name as department_name
    FROM hr_employees e LEFT JOIN hr_departments d ON d.id=e.department_id
    WHERE e.id=?
  `).get(req.params.id) as any;
  if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
  res.json({ ...row, active: Boolean(row.active) });
});

router.post("/hr/employees", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { employee_number, name, phone, position, department_id, basic_salary, hire_date, active } = req.body;
  if (!name || !employee_number) { res.status(400).json({ error: "الاسم ورقم الموظف مطلوبان" }); return; }
  const r = db.prepare(`
    INSERT INTO hr_employees (employee_number, name, phone, position, department_id, basic_salary, hire_date, active)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(employee_number, name, phone ?? null, position ?? null, department_id ?? null, basic_salary ?? 0, hire_date ?? null, active !== false ? 1 : 0);
  const emp = db.prepare(`
    SELECT e.*, d.name as department_name FROM hr_employees e
    LEFT JOIN hr_departments d ON d.id=e.department_id WHERE e.id=?
  `).get(r.lastInsertRowid) as any;
  res.status(201).json({ ...emp, active: Boolean(emp.active) });
});

router.put("/hr/employees/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { employee_number, name, phone, position, department_id, basic_salary, hire_date, active } = req.body;
  db.prepare(`
    UPDATE hr_employees SET employee_number=?, name=?, phone=?, position=?, department_id=?, basic_salary=?, hire_date=?, active=?
    WHERE id=?
  `).run(employee_number, name, phone ?? null, position ?? null, department_id ?? null, basic_salary ?? 0, hire_date ?? null, active !== false ? 1 : 0, req.params.id);
  const emp = db.prepare(`
    SELECT e.*, d.name as department_name FROM hr_employees e
    LEFT JOIN hr_departments d ON d.id=e.department_id WHERE e.id=?
  `).get(req.params.id) as any;
  res.json({ ...emp, active: Boolean(emp.active) });
});

router.delete("/hr/employees/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  db.prepare("DELETE FROM hr_employees WHERE id=?").run(req.params.id);
  res.status(204).send();
});

/* ── Salaries ── */
router.get("/hr/salaries", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { employee_id, month } = req.query as any;
  let sql = `
    SELECT s.*, e.name as employee_name, e.employee_number
    FROM hr_salaries s JOIN hr_employees e ON e.id=s.employee_id
    WHERE 1=1
  `;
  const params: any[] = [];
  if (employee_id) { sql += " AND s.employee_id=?"; params.push(employee_id); }
  if (month) { sql += " AND s.month=?"; params.push(month); }
  sql += " ORDER BY s.month DESC, e.name";
  res.json(db.prepare(sql).all(...params));
});

router.post("/hr/salaries", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { employee_id, month, basic_salary, bonuses, deductions, notes } = req.body;
  if (!employee_id || !month) { res.status(400).json({ error: "الموظف والشهر مطلوبان" }); return; }
  const existing = db.prepare("SELECT id FROM hr_salaries WHERE employee_id=? AND month=?").get(employee_id, month);
  if (existing) { res.status(400).json({ error: "تم إضافة راتب هذا الشهر مسبقاً" }); return; }
  const net = (basic_salary ?? 0) + (bonuses ?? 0) - (deductions ?? 0);
  const r = db.prepare(`
    INSERT INTO hr_salaries (employee_id, month, basic_salary, bonuses, deductions, net_salary, status, notes)
    VALUES (?,?,?,?,?,?,'pending',?)
  `).run(employee_id, month, basic_salary ?? 0, bonuses ?? 0, deductions ?? 0, net, notes ?? null);
  res.status(201).json(db.prepare(`
    SELECT s.*, e.name as employee_name, e.employee_number FROM hr_salaries s
    JOIN hr_employees e ON e.id=s.employee_id WHERE s.id=?
  `).get(r.lastInsertRowid));
});

router.put("/hr/salaries/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { basic_salary, bonuses, deductions, status, payment_date, notes } = req.body;
  const net = (basic_salary ?? 0) + (bonuses ?? 0) - (deductions ?? 0);
  db.prepare(`
    UPDATE hr_salaries SET basic_salary=?, bonuses=?, deductions=?, net_salary=?, status=?, payment_date=?, notes=?
    WHERE id=?
  `).run(basic_salary ?? 0, bonuses ?? 0, deductions ?? 0, net, status ?? "pending", payment_date ?? null, notes ?? null, req.params.id);
  res.json(db.prepare(`
    SELECT s.*, e.name as employee_name, e.employee_number FROM hr_salaries s
    JOIN hr_employees e ON e.id=s.employee_id WHERE s.id=?
  `).get(req.params.id));
});

router.delete("/hr/salaries/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  db.prepare("DELETE FROM hr_salaries WHERE id=?").run(req.params.id);
  res.status(204).send();
});

/* ── Attendance ── */
router.get("/hr/attendance", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { employee_id, date, month } = req.query as any;
  let sql = `
    SELECT a.*, e.name as employee_name, e.employee_number
    FROM hr_attendance a JOIN hr_employees e ON e.id=a.employee_id
    WHERE 1=1
  `;
  const params: any[] = [];
  if (employee_id) { sql += " AND a.employee_id=?"; params.push(employee_id); }
  if (date) { sql += " AND a.date=?"; params.push(date); }
  if (month) { sql += " AND strftime('%Y-%m', a.date)=?"; params.push(month); }
  sql += " ORDER BY a.date DESC, e.name";
  res.json(db.prepare(sql).all(...params));
});

router.post("/hr/attendance", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { employee_id, date, check_in, check_out, status, notes } = req.body;
  if (!employee_id || !date) { res.status(400).json({ error: "الموظف والتاريخ مطلوبان" }); return; }
  const existing = db.prepare("SELECT id FROM hr_attendance WHERE employee_id=? AND date=?").get(employee_id, date);
  if (existing) {
    db.prepare("UPDATE hr_attendance SET check_in=?, check_out=?, status=?, notes=? WHERE employee_id=? AND date=?")
      .run(check_in ?? null, check_out ?? null, status ?? "present", notes ?? null, employee_id, date);
    res.json(db.prepare("SELECT a.*, e.name as employee_name FROM hr_attendance a JOIN hr_employees e ON e.id=a.employee_id WHERE a.employee_id=? AND a.date=?").get(employee_id, date));
    return;
  }
  const r = db.prepare(`
    INSERT INTO hr_attendance (employee_id, date, check_in, check_out, status, notes)
    VALUES (?,?,?,?,?,?)
  `).run(employee_id, date, check_in ?? null, check_out ?? null, status ?? "present", notes ?? null);
  res.status(201).json(db.prepare(`
    SELECT a.*, e.name as employee_name FROM hr_attendance a
    JOIN hr_employees e ON e.id=a.employee_id WHERE a.id=?
  `).get(r.lastInsertRowid));
});

router.put("/hr/attendance/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { check_in, check_out, status, notes } = req.body;
  db.prepare("UPDATE hr_attendance SET check_in=?, check_out=?, status=?, notes=? WHERE id=?")
    .run(check_in ?? null, check_out ?? null, status ?? "present", notes ?? null, req.params.id);
  res.json(db.prepare("SELECT a.*, e.name as employee_name FROM hr_attendance a JOIN hr_employees e ON e.id=a.employee_id WHERE a.id=?").get(req.params.id));
});

router.delete("/hr/attendance/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  db.prepare("DELETE FROM hr_attendance WHERE id=?").run(req.params.id);
  res.status(204).send();
});

/* ── Meal Deductions ── */
router.get("/hr/meal-deductions", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { employee_id, month } = req.query as any;
  let sql = `SELECT md.*, e.name as employee_name, e.employee_number FROM meal_deductions md
    JOIN hr_employees e ON e.id=md.employee_id WHERE 1=1`;
  const params: any[] = [];
  if (employee_id) { sql += " AND md.employee_id=?"; params.push(employee_id); }
  if (month) { sql += " AND strftime('%Y-%m', md.created_at)=?"; params.push(month); }
  sql += " ORDER BY md.created_at DESC";
  res.json(db.prepare(sql).all(...params));
});

router.post("/hr/meal-deductions", (req, res) => {
  const user = getAuthUser(req);
  if (!user) { res.status(401).json({ error: "غير مصرح" }); return; }
  const { employee_id, employee_name, employee_number, order_id, invoice_number, amount, notes } = req.body;
  if (!employee_id || !amount) { res.status(400).json({ error: "الموظف والمبلغ مطلوبان" }); return; }
  const r = db.prepare(`
    INSERT INTO meal_deductions (employee_id, employee_name, employee_number, order_id, invoice_number, amount, cashier_id, cashier_name, notes)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(employee_id, employee_name ?? "", employee_number ?? "", order_id ?? null, invoice_number ?? null, amount, user.id, user.name, notes ?? null);
  res.status(201).json(db.prepare("SELECT * FROM meal_deductions WHERE id=?").get(r.lastInsertRowid));
});

/* ── Employee lookup by number (for POS meal deduction) ── */
router.get("/hr/employees/by-number/:num", (req, res) => {
  const user = getAuthUser(req);
  if (!user) { res.status(401).json({ error: "غير مصرح" }); return; }
  const emp = db.prepare(`
    SELECT e.*, d.name as department_name,
      (SELECT COALESCE(SUM(md.amount),0) FROM meal_deductions md WHERE md.employee_id=e.id AND strftime('%Y-%m', md.created_at)=strftime('%Y-%m','now')) as meal_deductions_this_month
    FROM hr_employees e LEFT JOIN hr_departments d ON d.id=e.department_id
    WHERE e.employee_number=? AND e.active=1
  `).get(req.params.num) as any;
  if (!emp) { res.status(404).json({ error: "الموظف غير موجود أو غير نشط" }); return; }
  res.json({ ...emp, active: Boolean(emp.active) });
});

/* ── Salary Statement Data (for A4 print) ── */
router.get("/hr/salary-statement/:employee_id/:month", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { employee_id, month } = req.params;
  const emp = db.prepare(`
    SELECT e.*, d.name as department_name FROM hr_employees e
    LEFT JOIN hr_departments d ON d.id=e.department_id WHERE e.id=?
  `).get(employee_id) as any;
  if (!emp) { res.status(404).json({ error: "الموظف غير موجود" }); return; }

  const salary = db.prepare("SELECT * FROM hr_salaries WHERE employee_id=? AND month=?").get(employee_id, month) as any;
  const mealDeductions = db.prepare(`
    SELECT * FROM meal_deductions WHERE employee_id=? AND strftime('%Y-%m', created_at)=?
    ORDER BY created_at ASC
  `).all(employee_id, month) as any[];
  const mealTotal = mealDeductions.reduce((s: number, m: any) => s + m.amount, 0);
  const attendance = db.prepare(`
    SELECT status, COUNT(*) as count FROM hr_attendance
    WHERE employee_id=? AND strftime('%Y-%m', date)=?
    GROUP BY status
  `).all(employee_id, month) as any[];

  const businessSettings = db.prepare("SELECT key, value FROM settings").all() as any[];
  const settings: Record<string,string> = {};
  businessSettings.forEach((s: any) => { settings[s.key] = s.value; });

  res.json({
    employee: { ...emp, active: Boolean(emp.active) },
    salary: salary ?? null,
    mealDeductions,
    mealTotal,
    attendance,
    settings,
  });
});

/* ── Loans/Advances ── */
router.get("/hr/loans", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const rows = db.prepare(`
    SELECT l.*, e.name as employee_name, e.employee_number
    FROM hr_loans l JOIN hr_employees e ON e.id = l.employee_id
    ORDER BY l.request_date DESC
  `).all();
  res.json(rows);
});

router.post("/hr/loans", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { employee_id, amount, type, request_date, status, repayment_terms, notes } = req.body;
  if (!employee_id || !amount || !request_date) {
    res.status(400).json({ error: "الموظف، المبلغ والتاريخ حقول مطلوبة" });
    return;
  }
  const r = db.prepare(`
    INSERT INTO hr_loans (employee_id, amount, type, request_date, status, repayment_terms, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(employee_id, amount, type ?? 'loan', request_date, status ?? 'approved', repayment_terms ?? null, notes ?? null);
  res.status(201).json(db.prepare(`
    SELECT l.*, e.name as employee_name, e.employee_number FROM hr_loans l
    JOIN hr_employees e ON e.id = l.employee_id WHERE l.id=?
  `).get(r.lastInsertRowid));
});

router.put("/hr/loans/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { employee_id, amount, type, request_date, status, repayment_terms, notes } = req.body;
  db.prepare(`
    UPDATE hr_loans SET employee_id=?, amount=?, type=?, request_date=?, status=?, repayment_terms=?, notes=?
    WHERE id=?
  `).run(employee_id, amount, type, request_date, status, repayment_terms ?? null, notes ?? null, req.params.id);
  res.json(db.prepare(`
    SELECT l.*, e.name as employee_name, e.employee_number FROM hr_loans l
    JOIN hr_employees e ON e.id = l.employee_id WHERE l.id=?
  `).get(req.params.id));
});

router.delete("/hr/loans/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  db.prepare("DELETE FROM hr_loans WHERE id=?").run(req.params.id);
  res.status(204).send();
});

/* ── Tools ── */
router.get("/hr/tools", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(db.prepare("SELECT * FROM hr_tools ORDER BY name").all());
});

router.post("/hr/tools", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { name, serial_number, quantity, available_qty, notes } = req.body;
  if (!name) { res.status(400).json({ error: "اسم الأداة مطلوب" }); return; }
  const r = db.prepare(`
    INSERT INTO hr_tools (name, serial_number, quantity, available_qty, notes)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, serial_number ?? null, quantity ?? 1, available_qty ?? quantity ?? 1, notes ?? null);
  res.status(201).json(db.prepare("SELECT * FROM hr_tools WHERE id=?").get(r.lastInsertRowid));
});

router.put("/hr/tools/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { name, serial_number, quantity, available_qty, notes } = req.body;
  db.prepare(`
    UPDATE hr_tools SET name=?, serial_number=?, quantity=?, available_qty=?, notes=?
    WHERE id=?
  `).run(name, serial_number ?? null, quantity ?? 1, available_qty ?? 1, notes ?? null, req.params.id);
  res.json(db.prepare("SELECT * FROM hr_tools WHERE id=?").get(req.params.id));
});

router.delete("/hr/tools/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  db.prepare("DELETE FROM hr_tools WHERE id=?").run(req.params.id);
  res.status(204).send();
});

/* ── Tools Movements ── */
router.get("/hr/tools/movements", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const rows = db.prepare(`
    SELECT tm.*, t.name as tool_name, t.serial_number as tool_serial, e.name as employee_name, e.employee_number
    FROM hr_tools_movements tm
    JOIN hr_tools t ON t.id = tm.tool_id
    JOIN hr_employees e ON e.id = tm.employee_id
    ORDER BY tm.date DESC, tm.id DESC
  `).all();
  res.json(rows);
});

router.post("/hr/tools/movements", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { tool_id, employee_id, type, quantity, date, notes } = req.body;
  if (!tool_id || !employee_id || !type || !quantity || !date) {
    res.status(400).json({ error: "جميع الحقول مطلوبة" });
    return;
  }
  
  // Adjust available qty in tools table
  const tool = db.prepare("SELECT * FROM hr_tools WHERE id=?").get(tool_id) as any;
  if (!tool) { res.status(404).json({ error: "الأداة غير موجودة" }); return; }
  
  let newAvail = tool.available_qty;
  if (type === 'out') {
    if (tool.available_qty < quantity) {
      res.status(400).json({ error: "الكمية المتاحة من هذه الأداة غير كافية" });
      return;
    }
    newAvail -= quantity;
  } else if (type === 'in') {
    newAvail += quantity;
    if (newAvail > tool.quantity) newAvail = tool.quantity; // Cap at max
  }
  
  db.prepare("UPDATE hr_tools SET available_qty=? WHERE id=?").run(newAvail, tool_id);
  
  const r = db.prepare(`
    INSERT INTO hr_tools_movements (tool_id, employee_id, type, quantity, date, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(tool_id, employee_id, type, quantity, date, notes ?? null);
  
  res.status(201).json(db.prepare(`
    SELECT tm.*, t.name as tool_name, t.serial_number as tool_serial, e.name as employee_name FROM hr_tools_movements tm
    JOIN hr_tools t ON t.id = tm.tool_id
    JOIN hr_employees e ON e.id = tm.employee_id
    WHERE tm.id=?
  `).get(r.lastInsertRowid));
});

/* ── Entitlements ── */
router.get("/hr/entitlements", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const rows = db.prepare(`
    SELECT en.*, e.name as employee_name, e.employee_number
    FROM hr_entitlements en JOIN hr_employees e ON e.id = en.employee_id
    ORDER BY en.date DESC
  `).all();
  res.json(rows);
});

router.post("/hr/entitlements", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { employee_id, type, amount, date, notes } = req.body;
  if (!employee_id || !type || !amount || !date) {
    res.status(400).json({ error: "جميع الحقول الأساسية مطلوبة" });
    return;
  }
  const r = db.prepare(`
    INSERT INTO hr_entitlements (employee_id, type, amount, date, notes)
    VALUES (?, ?, ?, ?, ?)
  `).run(employee_id, type, amount, date, notes ?? null);
  res.status(201).json(db.prepare(`
    SELECT en.*, e.name as employee_name FROM hr_entitlements en
    JOIN hr_employees e ON e.id = en.employee_id WHERE en.id=?
  `).get(r.lastInsertRowid));
});

router.delete("/hr/entitlements/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  db.prepare("DELETE FROM hr_entitlements WHERE id=?").run(req.params.id);
  res.status(204).send();
});

/* ── Leaves ── */
router.get("/hr/leaves", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const rows = db.prepare(`
    SELECT l.*, e.name as employee_name, e.employee_number
    FROM hr_leaves l JOIN hr_employees e ON e.id = l.employee_id
    ORDER BY l.start_date DESC
  `).all();
  res.json(rows);
});

router.post("/hr/leaves", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { employee_id, start_date, end_date, type, status, notes } = req.body;
  if (!employee_id || !start_date || !end_date || !type) {
    res.status(400).json({ error: "جميع الحقول الأساسية مطلوبة" });
    return;
  }
  const r = db.prepare(`
    INSERT INTO hr_leaves (employee_id, start_date, end_date, type, status, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(employee_id, start_date, end_date, type, status ?? 'approved', notes ?? null);
  res.status(201).json(db.prepare(`
    SELECT l.*, e.name as employee_name FROM hr_leaves l
    JOIN hr_employees e ON e.id = l.employee_id WHERE l.id=?
  `).get(r.lastInsertRowid));
});

router.put("/hr/leaves/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { employee_id, start_date, end_date, type, status, notes } = req.body;
  db.prepare(`
    UPDATE hr_leaves SET employee_id=?, start_date=?, end_date=?, type=?, status=?, notes=?
    WHERE id=?
  `).run(employee_id, start_date, end_date, type, status, notes ?? null, req.params.id);
  res.json(db.prepare(`
    SELECT l.*, e.name as employee_name FROM hr_leaves l
    JOIN hr_employees e ON e.id = l.employee_id WHERE l.id=?
  `).get(req.params.id));
});

router.delete("/hr/leaves/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  db.prepare("DELETE FROM hr_leaves WHERE id=?").run(req.params.id);
  res.status(204).send();
});

/* ── Custodies ── */
router.get("/hr/custodies", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const rows = db.prepare(`
    SELECT c.*, e.name as employee_name, e.employee_number
    FROM hr_custodies c JOIN hr_employees e ON e.id = c.employee_id
    ORDER BY c.received_date DESC
  `).all();
  res.json(rows);
});

router.post("/hr/custodies", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { employee_id, item_name, received_date, returned_date, status, notes } = req.body;
  if (!employee_id || !item_name || !received_date) {
    res.status(400).json({ error: "اسم العهدة والموظف وتاريخ الاستلام حقول مطلوبة" });
    return;
  }
  const r = db.prepare(`
    INSERT INTO hr_custodies (employee_id, item_name, received_date, returned_date, status, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(employee_id, item_name, received_date, returned_date ?? null, status ?? 'held', notes ?? null);
  res.status(201).json(db.prepare(`
    SELECT c.*, e.name as employee_name FROM hr_custodies c
    JOIN hr_employees e ON e.id = c.employee_id WHERE c.id=?
  `).get(r.lastInsertRowid));
});

router.put("/hr/custodies/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { employee_id, item_name, received_date, returned_date, status, notes } = req.body;
  db.prepare(`
    UPDATE hr_custodies SET employee_id=?, item_name=?, received_date=?, returned_date=?, status=?, notes=?
    WHERE id=?
  `).run(employee_id, item_name, received_date, returned_date ?? null, status, notes ?? null, req.params.id);
  res.json(db.prepare(`
    SELECT c.*, e.name as employee_name FROM hr_custodies c
    JOIN hr_employees e ON e.id = c.employee_id WHERE c.id=?
  `).get(req.params.id));
});

router.delete("/hr/custodies/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  db.prepare("DELETE FROM hr_custodies WHERE id=?").run(req.params.id);
  res.status(204).send();
});

/* ── Penalties ── */
router.get("/hr/penalties", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const rows = db.prepare(`
    SELECT p.*, e.name as employee_name, e.employee_number
    FROM hr_penalties p JOIN hr_employees e ON e.id = p.employee_id
    ORDER BY p.date DESC
  `).all();
  res.json(rows);
});

router.post("/hr/penalties", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { employee_id, violation_name, amount, date, notes } = req.body;
  if (!employee_id || !violation_name || !amount || !date) {
    res.status(400).json({ error: "جميع الحقول مطلوبة" });
    return;
  }
  const r = db.prepare(`
    INSERT INTO hr_penalties (employee_id, violation_name, amount, date, notes)
    VALUES (?, ?, ?, ?, ?)
  `).run(employee_id, violation_name, amount, date, notes ?? null);
  res.status(201).json(db.prepare(`
    SELECT p.*, e.name as employee_name FROM hr_penalties p
    JOIN hr_employees e ON e.id = p.employee_id WHERE p.id=?
  `).get(r.lastInsertRowid));
});

router.delete("/hr/penalties/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  db.prepare("DELETE FROM hr_penalties WHERE id=?").run(req.params.id);
  res.status(204).send();
});

/* ── Overtime ── */
router.get("/hr/overtime", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const rows = db.prepare(`
    SELECT o.*, e.name as employee_name, e.employee_number
    FROM hr_overtime o JOIN hr_employees e ON e.id = o.employee_id
    ORDER BY o.date DESC
  `).all();
  res.json(rows);
});

router.post("/hr/overtime", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { employee_id, hours, rate, date, notes } = req.body;
  if (!employee_id || !hours || !rate || !date) {
    res.status(400).json({ error: "جميع الحقول مطلوبة" });
    return;
  }
  const total = Number(hours) * Number(rate);
  const r = db.prepare(`
    INSERT INTO hr_overtime (employee_id, hours, rate, total_amount, date, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(employee_id, hours, rate, total, date, notes ?? null);
  res.status(201).json(db.prepare(`
    SELECT o.*, e.name as employee_name FROM hr_overtime o
    JOIN hr_employees e ON e.id = o.employee_id WHERE o.id=?
  `).get(r.lastInsertRowid));
});

router.delete("/hr/overtime/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  db.prepare("DELETE FROM hr_overtime WHERE id=?").run(req.params.id);
  res.status(204).send();
});

/* ── Temporary Employees ── */
router.get("/hr/temp-employees", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(db.prepare("SELECT * FROM hr_temp_employees ORDER BY name").all());
});

router.post("/hr/temp-employees", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { name, phone, position, daily_rate, hire_date, active } = req.body;
  if (!name) { res.status(400).json({ error: "الاسم مطلوب" }); return; }
  const r = db.prepare(`
    INSERT INTO hr_temp_employees (name, phone, position, daily_rate, hire_date, active)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name, phone ?? null, position ?? null, daily_rate ?? 0, hire_date ?? null, active !== false ? 1 : 0);
  res.status(201).json(db.prepare("SELECT * FROM hr_temp_employees WHERE id=?").get(r.lastInsertRowid));
});

router.put("/hr/temp-employees/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { name, phone, position, daily_rate, hire_date, active } = req.body;
  db.prepare(`
    UPDATE hr_temp_employees SET name=?, phone=?, position=?, daily_rate=?, hire_date=?, active=?
    WHERE id=?
  `).run(name, phone ?? null, position ?? null, daily_rate ?? 0, hire_date ?? null, active !== false ? 1 : 0, req.params.id);
  res.json(db.prepare("SELECT * FROM hr_temp_employees WHERE id=?").get(req.params.id));
});

router.delete("/hr/temp-employees/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  db.prepare("DELETE FROM hr_temp_employees WHERE id=?").run(req.params.id);
  res.status(204).send();
});

/* ── Department Notes ── */
router.get("/hr/notes", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const rows = db.prepare(`
    SELECT n.*, d.name as department_name
    FROM hr_notes n LEFT JOIN hr_departments d ON d.id = n.department_id
    ORDER BY n.created_at DESC
  `).all();
  res.json(rows);
});

router.post("/hr/notes", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { department_id, title, content } = req.body;
  if (!title) { res.status(400).json({ error: "العنوان مطلوب" }); return; }
  const r = db.prepare(`
    INSERT INTO hr_notes (department_id, title, content)
    VALUES (?, ?, ?)
  `).run(department_id ?? null, title, content ?? null);
  res.status(201).json(db.prepare(`
    SELECT n.*, d.name as department_name FROM hr_notes n
    LEFT JOIN hr_departments d ON d.id = n.department_id WHERE n.id=?
  `).get(r.lastInsertRowid));
});

router.delete("/hr/notes/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  db.prepare("DELETE FROM hr_notes WHERE id=?").run(req.params.id);
  res.status(204).send();
});

/* ── Monthly Closure / Payroll Posting ── */
router.post("/hr/monthly-close", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { month } = req.body;
  if (!month) { res.status(400).json({ error: "الشهر مطلوب" }); return; }
  
  // Fetch active employees
  const employees = db.prepare("SELECT * FROM hr_employees WHERE active=1").all() as any[];
  
  let addedCount = 0;
  for (const emp of employees) {
    // Check if salary already added
    const existing = db.prepare("SELECT id FROM hr_salaries WHERE employee_id=? AND month=?").get(emp.id, month);
    if (!existing) {
      // Calculate automatically!
      // Add bonuses = total overtime + total daily/monthly entitlements
      const overtime = db.prepare("SELECT SUM(total_amount) as total FROM hr_overtime WHERE employee_id=? AND strftime('%Y-%m', date)=?").get(emp.id, month) as any;
      const entitlements = db.prepare("SELECT SUM(amount) as total FROM hr_entitlements WHERE employee_id=? AND strftime('%Y-%m', date)=?").get(emp.id, month) as any;
      const bonuses = (overtime?.total ?? 0) + (entitlements?.total ?? 0);
      
      // Add deductions = total meal deductions + penalties + approved loans for this month
      const meals = db.prepare("SELECT SUM(amount) as total FROM meal_deductions WHERE employee_id=? AND strftime('%Y-%m', created_at)=?").get(emp.id, month) as any;
      const penalties = db.prepare("SELECT SUM(amount) as total FROM hr_penalties WHERE employee_id=? AND strftime('%Y-%m', date)=?").get(emp.id, month) as any;
      const loans = db.prepare("SELECT SUM(amount) as total FROM hr_loans WHERE employee_id=? AND strftime('%Y-%m', request_date)=? AND type='loan' AND status='approved'").get(emp.id, month) as any;
      const deductions = (meals?.total ?? 0) + (penalties?.total ?? 0) + (loans?.total ?? 0);
      
      const net = emp.basic_salary + bonuses - deductions;
      
      db.prepare(`
        INSERT INTO hr_salaries (employee_id, month, basic_salary, bonuses, deductions, net_salary, status)
        VALUES (?, ?, ?, ?, ?, ?, 'pending')
      `).run(emp.id, month, emp.basic_salary, bonuses, deductions, net);
      addedCount++;
    }
  }
  
  res.json({ success: true, message: `تم ترحيل رواتب الشهر لعدد ${addedCount} موظف` });
});

/* ── Summary ── */
router.get("/hr/summary", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const totalEmployees = (db.prepare("SELECT COUNT(*) as c FROM hr_employees WHERE active=1").get() as any).c;
  const totalDepts = (db.prepare("SELECT COUNT(*) as c FROM hr_departments").get() as any).c;
  const currentMonth = new Date().toISOString().slice(0, 7);
  const salariesThisMonth = db.prepare(`
    SELECT COALESCE(SUM(net_salary),0) as total, COUNT(*) as count,
           SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) as paid_count
    FROM hr_salaries WHERE month=?
  `).get(currentMonth) as any;
  const todayAttendance = db.prepare(`
    SELECT COUNT(*) as present FROM hr_attendance
    WHERE date=? AND status='present'
  `).get(new Date().toISOString().slice(0, 10)) as any;
  res.json({
    totalEmployees,
    totalDepts,
    currentMonthSalaries: salariesThisMonth.total,
    currentMonthSalaryCount: salariesThisMonth.count,
    paidSalaries: salariesThisMonth.paid_count,
    todayPresent: todayAttendance.present,
  });
});

export default router;
