import { Router } from "express";
import { db, logAudit, createDoubleEntryJournal } from "../lib/sqlite";
import { getAuthUser } from "./auth";

const router = Router();

function requireAuth(req: any, res: any): any {
  const user = getAuthUser(req);
  if (!user) {
    res.status(401).json({ error: "غير مصرح" });
    return null;
  }
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

// Get all safes
router.get("/safes", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;

  try {
    const safes = db.prepare("SELECT * FROM safes ORDER BY id DESC").all();
    res.json(safes);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Add new safe
router.post("/safes", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;

  const { name, balance, currency, notes, branch_id, cashier_id } = req.body;
  if (!name) {
    res.status(400).json({ error: "اسم الصندوق مطلوب" });
    return;
  }

  try {
    const r = db.prepare(`
      INSERT INTO safes (name, balance, currency, notes, active, opening_balance, status, branch_id, cashier_id)
      VALUES (?, ?, ?, ?, 1, ?, 'open', ?, ?)
    `).run(
      name,
      Number(balance ?? 0),
      currency ?? "ريال",
      notes ?? null,
      Number(balance ?? 0),
      branch_id ? Number(branch_id) : null,
      cashier_id ? Number(cashier_id) : null
    );

    const safeId = r.lastInsertRowid;

    // Create a double entry for the initial capital of the safe
    if (Number(balance ?? 0) > 0) {
      try {
        createDoubleEntryJournal(
          new Date().toISOString().slice(0, 10),
          `إثبات رصيد افتتاحي للصندوق الجديد: ${name}`,
          "voucher",
          safeId,
          [
            { account_code: "11100", debit: Number(balance), credit: 0, description: `رصيد افتتاحي - صندوق ${name}` },
            { account_code: "31000", debit: 0, credit: Number(balance), description: `تمويل رأس المال التأسيسي` }
          ]
        );
      } catch (err: any) {
        console.error("Initial safe balance journal failed:", err.message);
      }
    }

    logAudit(user.id, user.name, "إضافة صندوق", `إضافة صندوق جديد: ${name} برصيد افتتاحي ${balance}`);
    res.status(201).json({
      id: safeId,
      name,
      balance: Number(balance ?? 0),
      currency: currency ?? "ريال",
      notes: notes ?? null,
      active: 1,
      status: "open",
      opening_balance: Number(balance ?? 0),
      branch_id,
      cashier_id
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Edit safe
router.put("/safes/:id", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;

  const { name, balance, currency, notes, active, branch_id, cashier_id } = req.body;
  if (!name) {
    res.status(400).json({ error: "اسم الصندوق مطلوب" });
    return;
  }

  try {
    db.prepare(`
      UPDATE safes
      SET name = ?, balance = ?, currency = ?, notes = ?, active = ?, branch_id = ?, cashier_id = ?
      WHERE id = ?
    `).run(
      name,
      Number(balance ?? 0),
      currency ?? "ريال",
      notes ?? null,
      active ? 1 : 0,
      branch_id ? Number(branch_id) : null,
      cashier_id ? Number(cashier_id) : null,
      req.params.id
    );

    logAudit(user.id, user.name, "تعديل صندوق", `تعديل صندوق: ${name} برصيد ${balance}`);
    res.json({
      id: Number(req.params.id),
      name,
      balance: Number(balance ?? 0),
      currency: currency ?? "ريال",
      notes: notes ?? null,
      active: active ? 1 : 0,
      branch_id,
      cashier_id
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Delete safe
router.delete("/safes/:id", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;

  try {
    const safe = db.prepare("SELECT * FROM safes WHERE id = ?").get(req.params.id) as any;
    if (!safe) {
      res.status(404).json({ error: "الصندوق غير موجود" });
      return;
    }

    if (safe.name === "الصندوق الرئيسي") {
      res.status(400).json({ error: "لا يمكن حذف الصندوق الرئيسي للنظام" });
      return;
    }

    db.prepare("DELETE FROM safes WHERE id = ?").run(req.params.id);
    logAudit(user.id, user.name, "حذف صندوق", `حذف صندوق: ${safe.name}`);
    res.status(204).send();
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── SAFE FUND TRANSFER (تحويل نقدية بين الصناديق) ───
router.post("/safes/transfer", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;

  const { source_safe_id, destination_safe_id, amount, notes } = req.body;
  if (!source_safe_id || !destination_safe_id || !amount || Number(amount) <= 0) {
    res.status(400).json({ error: "الرجاء توفير صندوق المصدر والمستهدف والمبلغ المراد تحويله" });
    return;
  }

  try {
    const src = db.prepare("SELECT * FROM safes WHERE id = ?").get(source_safe_id) as any;
    const dst = db.prepare("SELECT * FROM safes WHERE id = ?").get(destination_safe_id) as any;

    if (!src || !dst) {
      res.status(404).json({ error: "أحد الصناديق المحددة غير موجود" });
      return;
    }

    if (src.balance < Number(amount)) {
      res.status(400).json({ error: `رصيد صندوق المصدر (${src.name}) لا يكفي للتحويل! الرصيد الحالي: ${src.balance}` });
      return;
    }

    // Update balances
    db.prepare("UPDATE safes SET balance = balance - ? WHERE id = ?").run(amount, source_safe_id);
    db.prepare("UPDATE safes SET balance = balance + ? WHERE id = ?").run(amount, destination_safe_id);

    // Create balanced double-entry journal
    try {
      createDoubleEntryJournal(
        new Date().toISOString().slice(0, 10),
        `تحويل نقدية داخلي من صندوق [${src.name}] إلى صندوق [${dst.name}]`,
        "voucher",
        source_safe_id,
        [
          { account_code: "11100", debit: Number(amount), credit: 0, description: `استلام نقدية محولة إلى ${dst.name}` },
          { account_code: "11100", debit: 0, credit: Number(amount), description: `تحويل نقدية صادرة من ${src.name}` }
        ]
      );
    } catch (journalErr: any) {
      console.error("Safe transfer journal failed:", journalErr.message);
    }

    logAudit(user.id, user.name, "تحويل نقدية", `تم تحويل مبلغ ${amount} من صندوق ${src.name} إلى صندوق ${dst.name}`);
    res.json({ success: true, amount, source: src.name, destination: dst.name });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DEPOSIT TO SAFE (إيداع نقدي) ───
router.post("/safes/:id/deposit", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;

  const { amount, notes } = req.body;
  if (!amount || Number(amount) <= 0) {
    res.status(400).json({ error: "المبلغ مطلوب ويجب أن يكون أكبر من الصفر" });
    return;
  }

  try {
    const safe = db.prepare("SELECT * FROM safes WHERE id = ?").get(req.params.id) as any;
    if (!safe) {
      res.status(404).json({ error: "الصندوق غير موجود" });
      return;
    }

    db.prepare("UPDATE safes SET balance = balance + ? WHERE id = ?").run(amount, safe.id);

    // Double entry: Debit Safe, Credit Capital/Equity
    try {
      createDoubleEntryJournal(
        new Date().toISOString().slice(0, 10),
        `إيداع نقدي مباشر لصندوق [${safe.name}] — البيان: ${notes ?? "تغذية صندوق بطلب الإدارة"}`,
        "voucher",
        safe.id,
        [
          { account_code: "11100", debit: Number(amount), credit: 0, description: `إيداع نقدي لصندوق ${safe.name}` },
          { account_code: "31000", debit: 0, credit: Number(amount), description: `تمويل نقدية إضافية - رأس مال` }
        ]
      );
    } catch (jeErr: any) {
      console.error("Deposit journal failed:", jeErr.message);
    }

    logAudit(user.id, user.name, "إيداع صندوق", `إيداع مبلغ ${amount} لصندوق ${safe.name}`);
    res.json({ success: true, new_balance: safe.balance + Number(amount) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── WITHDRAW FROM SAFE (سحب نقدي مباشر) ───
router.post("/safes/:id/withdraw", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;

  const { amount, notes } = req.body;
  if (!amount || Number(amount) <= 0) {
    res.status(400).json({ error: "المبلغ مطلوب ويجب أن يكون أكبر من الصفر" });
    return;
  }

  try {
    const safe = db.prepare("SELECT * FROM safes WHERE id = ?").get(req.params.id) as any;
    if (!safe) {
      res.status(404).json({ error: "الصندوق غير موجود" });
      return;
    }

    if (safe.balance < Number(amount)) {
      res.status(400).json({ error: "رصيد الصندوق الحالي لا يكفي لإتمام عملية السحب" });
      return;
    }

    db.prepare("UPDATE safes SET balance = balance - ? WHERE id = ?").run(amount, safe.id);

    // Double entry: Debit Expenses (Operating/General) or Equity Withdrawal, Credit Safe
    try {
      createDoubleEntryJournal(
        new Date().toISOString().slice(0, 10),
        `سحب نقدي مباشر من صندوق [${safe.name}] — البيان: ${notes ?? "مسحوبات نقدية إدارية"}`,
        "voucher",
        safe.id,
        [
          { account_code: "61000", debit: Number(amount), credit: 0, description: `مسحوبات ومصاريف مباشرة من صندوق ${safe.name}` },
          { account_code: "11100", debit: 0, credit: Number(amount), description: `تخفيض نقدية صندوق ${safe.name}` }
        ]
      );
    } catch (jeErr: any) {
      console.error("Withdrawal journal failed:", jeErr.message);
    }

    logAudit(user.id, user.name, "سحب صندوق", `سحب مبلغ ${amount} من صندوق ${safe.name}`);
    res.json({ success: true, new_balance: safe.balance - Number(amount) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── OPEN SAFE (فتح صندوق / وردية جديدة) ───
router.post("/safes/:id/open", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;

  const { opening_balance } = req.body;

  try {
    const safe = db.prepare("SELECT * FROM safes WHERE id = ?").get(req.params.id) as any;
    if (!safe) {
      res.status(404).json({ error: "الصندوق غير موجود" });
      return;
    }

    db.prepare(`
      UPDATE safes
      SET status = 'open', opening_balance = ?, balance = ?, actual_balance = 0, difference = 0, reconciliation_reason = NULL
      WHERE id = ?
    `).run(Number(opening_balance ?? 0), Number(opening_balance ?? 0), safe.id);

    logAudit(user.id, user.name, "فتح صندوق", `تم فتح صندوق ${safe.name} برصيد افتتاحي ${opening_balance ?? 0}`);
    res.json({ success: true, status: "open", opening_balance });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── RECONCILE / REQUEST CLOSE SAFE (تسوية ومطابقة الرصيد الفعلي) ───
router.post("/safes/:id/reconcile", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;

  const { actual_balance, reconciliation_reason } = req.body;
  if (actual_balance === undefined) {
    res.status(400).json({ error: "الرجاء إدخال الرصيد الفعلي الموجود بالصندوق للمطابقة" });
    return;
  }

  try {
    const safe = db.prepare("SELECT * FROM safes WHERE id = ?").get(req.params.id) as any;
    if (!safe) {
      res.status(404).json({ error: "الصندوق غير موجود" });
      return;
    }

    const expected = safe.balance;
    const diff = Number(actual_balance) - expected;

    // Strict validation: if there is a difference, a reason must be provided
    if (Math.abs(diff) > 0.01 && !reconciliation_reason) {
      res.status(400).json({ error: "يوجد عجز أو زيادة في الصندوق! لا يسمح بالإغلاق إلا بعد كتابة سبب العجز/الزيادة بالتفصيل لمطابقة الحسابات." });
      return;
    }

    db.prepare(`
      UPDATE safes
      SET status = 'pending_approval', actual_balance = ?, difference = ?, reconciliation_reason = ?
      WHERE id = ?
    `).run(Number(actual_balance), diff, reconciliation_reason ?? null, safe.id);

    logAudit(user.id, user.name, "طلب إغلاق وتسوية صندوق", `تقديم طلب تسوية صندوق ${safe.name}: الرصيد الفعلي ${actual_balance}، المتوقع ${expected}، الفارق ${diff}`);
    res.json({ success: true, status: "pending_approval", expected, actual: Number(actual_balance), difference: diff });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── APPROVE RECONCILIATION / CLOSING (اعتماد الإغلاق والتسوية محاسبياً) ───
router.post("/safes/:id/approve-closing", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const user = getAuthUser(req);

  try {
    const safe = db.prepare("SELECT * FROM safes WHERE id = ?").get(req.params.id) as any;
    if (!safe) {
      res.status(404).json({ error: "الصندوق غير موجود" });
      return;
    }

    if (safe.status !== "pending_approval") {
      res.status(400).json({ error: "الصندوق ليس في حالة انتظار الاعتماد" });
      return;
    }

    const diff = safe.difference || 0;

    // If there's a difference, generate a double-entry journal entry to record overage/shortage
    if (Math.abs(diff) > 0.01) {
      try {
        if (diff > 0) {
          // Overage: Debit safe cash, Credit other revenue
          createDoubleEntryJournal(
            new Date().toISOString().slice(0, 10),
            `اعتماد زيادة صندوق [${safe.name}] عند الإغلاق المالي`,
            "shift_difference",
            safe.id,
            [
              { account_code: "11100", debit: Math.abs(diff), credit: 0, description: `زيادة نقدية معتمدة بصندوق ${safe.name}` },
              { account_code: "41000", debit: 0, credit: Math.abs(diff), description: `أرباح وإيرادات فروقات جرد صناديق الكاشير` }
            ]
          );
        } else {
          // Shortage: Debit expense (losses), Credit safe cash
          createDoubleEntryJournal(
            new Date().toISOString().slice(0, 10),
            `اعتماد عجز صندوق [${safe.name}] عند الإغلاق المالي`,
            "shift_difference",
            safe.id,
            [
              { account_code: "62000", debit: Math.abs(diff), credit: 0, description: `خسائر وعجز نقدية معتمد بصندوق ${safe.name}` },
              { account_code: "11100", debit: 0, credit: Math.abs(diff), description: `تخفيض رصيد صندوق ${safe.name} بقيمة العجز` }
            ]
          );
        }
      } catch (journalErr: any) {
        console.error("Shift reconciliation journal failed:", journalErr.message);
      }
    }

    // Update safe with reconciled actual balance and mark as closed
    db.prepare(`
      UPDATE safes
      SET status = 'closed', balance = actual_balance, last_closing_date = datetime('now')
      WHERE id = ?
    `).run(safe.id);

    logAudit(user.id, user.name, "اعتماد إغلاق صندوق", `تم اعتماد الإغلاق النهائي وتصفية فروقات صندوق ${safe.name}`);
    res.json({ success: true, status: "closed" });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── REJECT CLOSING (رفض الإغلاق وإعادة الصندوق للمراجعة) ───
router.post("/safes/:id/reject-closing", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const user = getAuthUser(req);

  try {
    const safe = db.prepare("SELECT * FROM safes WHERE id = ?").get(req.params.id) as any;
    if (!safe) {
      res.status(404).json({ error: "الصندوق غير موجود" });
      return;
    }

    if (safe.status !== "pending_approval") {
      res.status(400).json({ error: "الصندوق ليس في حالة انتظار الاعتماد" });
      return;
    }

    db.prepare(`
      UPDATE safes
      SET status = 'open', actual_balance = 0, difference = 0, reconciliation_reason = NULL
      WHERE id = ?
    `).run(safe.id);

    logAudit(user.id, user.name, "رفض إغلاق صندوق", `تم رفض إغلاق صندوق ${safe.name} وإعادته للمراجعة وإعادة المطابقة الفورية`);
    res.json({ success: true, status: "open" });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
