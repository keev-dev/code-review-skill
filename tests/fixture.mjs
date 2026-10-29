import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureDir, removeRecursive } from "../scripts/lib/util.mjs";

const BASE_FILES = {
  "package.json": JSON.stringify({
    name: "northwind-orders",
    private: true,
    type: "module",
    scripts: { test: "node --test" },
  }, null, 2) + "\n",
  ".gitignore": "node_modules/\n.env\n",
  "src/db/client.ts": `export const db = {
  async query<T = unknown>(_sql: string, _params?: unknown[]): Promise<T[]> {
    throw new Error("database not configured");
  },
};
`,
  "src/notifications/email.ts": `export async function sendEmail(input: { to: string; subject: string; body: string }) {
  console.log("email queued", input.to);
}
`,
  "src/orders/orderRepository.ts": `import { db } from "../db/client";

export interface Order {
  id: string;
  customerId: string;
  totalCents: number;
  status: "pending" | "paid" | "cancelled";
}

export class OrderRepository {
  async findById(id: string): Promise<Order | null> {
    const rows = await db.query<Order>("SELECT * FROM orders WHERE id = $1", [id]);
    return rows[0] ?? null;
  }

  async save(order: Order): Promise<void> {
    await db.query("UPDATE orders SET status = $1, total_cents = $2 WHERE id = $3", [
      order.status,
      order.totalCents,
      order.id,
    ]);
  }
}
`,
  "src/orders/orderService.ts": `import { Order, OrderRepository } from "./orderRepository";
import { sendEmail } from "../notifications/email";

export class OrderService {
  constructor(private readonly orders: OrderRepository) {}

  async cancel(orderId: string): Promise<Order> {
    const order = await this.orders.findById(orderId);
    if (!order) throw new Error("Order not found");
    order.status = "cancelled";
    await this.orders.save(order);
    await sendEmail({ to: order.customerId, subject: "Order cancelled", body: \`Order \${order.id} was cancelled.\` });
    return order;
  }
}
`,
  "src/api/orders.ts": `import { Router } from "express";
import { OrderRepository } from "../orders/orderRepository";
import { OrderService } from "../orders/orderService";

const router = Router();
const service = new OrderService(new OrderRepository());

router.post("/:id/cancel", async (req, res) => {
  const order = await service.cancel(req.params.id);
  res.json(order);
});

export default router;
`,
  "src/utils/money.ts": `export function formatMoney(cents: number): string {
  return \`$\${(cents / 100).toFixed(2)}\`;
}
`,
  "src/legacy/legacyPricing.ts": `export function legacyTotal(items: any[]): number {
  return items.reduce((sum, item) => sum + item.price, 0) * 1.2;
}
`,
  "src/config/env.ts": `export const env = {
  databaseUrl: process.env.DATABASE_URL!,
  stripeSecret: process.env.STRIPE_SECRET || "sk_test_123",
  adminToken: "admin-dev-token",
};
`,
  "db/schema.sql": `CREATE TABLE customers (
  id text PRIMARY KEY,
  email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id text PRIMARY KEY,
  customer_id text NOT NULL REFERENCES customers(id),
  total_cents integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX orders_customer_id_idx ON orders (customer_id);

CREATE TABLE payments (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id),
  amount integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE refunds (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id),
  amount integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`,
  "tests/orderService.test.ts": `import { OrderService } from "../src/orders/orderService";

test("cancel marks an order as cancelled", async () => {
  const service = new OrderService({} as any);
  const order = await service.cancel("order-1");
  expect(order.status).toBe("cancelled");
});
`,
};

const MODIFIED_FILES = {
  "src/orders/orderRepository.ts": `import { db } from "../db/client";

export interface Order {
  id: string;
  customerId: string;
  totalCents: number;
  status: "pending" | "paid" | "cancelled";
}

export class OrderRepository {
  async findById(id: string): Promise<Order | null> {
    const rows = await db.query<Order>("SELECT * FROM orders WHERE id = $1", [id]);
    return rows[0] ?? null;
  }

  async save(order: Order): Promise<void> {
    await db.query("UPDATE orders SET status = $1, total_cents = $2 WHERE id = $3", [
      order.status,
      order.totalCents,
      order.id,
    ]);
  }

  async findByCustomer(customerId: string): Promise<Order[]> {
    return db.query(\`SELECT * FROM orders WHERE customer_id = '\${customerId}' ORDER BY created_at DESC\`);
  }
}
`,
  "src/orders/orderService.ts": `import { db } from "../db/client";
import { Order, OrderRepository } from "./orderRepository";
import { sendEmail } from "../notifications/email";

export class SmtpEmailClient {
  async send(to: string, subject: string, body: string) {
    return sendEmail({ to, subject, body });
  }
}

export class OrderService {
  private readonly emailClient = new SmtpEmailClient();

  constructor(private readonly orders: OrderRepository) {}

  async checkout(customerId: string, cart: any): Promise<any> {
    let total = 0;
    const lines = [];

    for (const item of cart.items) {
      const product = await db.query(\`SELECT * FROM products WHERE id = '\${item.productId}'\`);
      if (!product) {
        throw new Error("Missing product");
      }
      if (item.quantity <= 0) {
        console.log("bad quantity", cart, customerId);
      }
      total += product.price_cents * item.quantity;
      lines.push({ name: product.name, total: product.price_cents * item.quantity });
    }

    const tax = total * 0.2;
    total = total + tax;

    const order: Order = {
      id: crypto.randomUUID(),
      customerId,
      totalCents: total,
      status: "pending",
    };

    await this.orders.save(order);

    try {
      const payment = await db.query(\`INSERT INTO payments (order_id, amount) VALUES ('\${order.id}', \${total})\`);
      if (!payment) {
        throw new Error("Payment failed");
      }
      const customer = await db.query(\`SELECT email FROM customers WHERE id = '\${customerId}'\`);
      const body = "Thanks for your order!\\n" + lines.map((line) => \`\${line.name}: \${line.total / 100}\`).join("\\n") + \`\\nTax: \${tax / 100}\`;
      await this.emailClient.send(customer.email, "Your order", body);
    } catch (error) {
      console.log("checkout failed", error);
    }

    return { order, lines };
  }

  async cancel(orderId: string): Promise<Order> {
    return this.refund(orderId, Number.MAX_SAFE_INTEGER);
  }

  async refund(orderId: string, amount: number): Promise<any> {
    const order = await db.query(\`SELECT * FROM orders WHERE id = '\${orderId}'\`);
    if (!order) throw new Error("Order not found");
    if (order.total_cents < amount) throw new Error("Refund exceeds total");
    await db.query(\`UPDATE orders SET total_cents = total_cents - \${amount} WHERE id = '\${orderId}'\`);
    await db.query(\`INSERT INTO refunds (order_id, amount) VALUES ('\${orderId}', \${amount})\`);
    return { order, amount };
  }
}
`,
  "src/api/orders.ts": `import { Router } from "express";
import { OrderRepository } from "../orders/orderRepository";
import { OrderService } from "../orders/orderService";

const router = Router();
const service = new OrderService(new OrderRepository());

router.post("/checkout", async (req, res) => {
  const order = await service.checkout(req.body.customerId, req.body.cart);
  res.json(order);
});

router.post("/:id/cancel", async (req, res) => {
  const order = await service.cancel(req.params.id);
  res.json(order);
});

router.post("/:id/refund", async (req, res) => {
  const result = await service.refund(req.params.id, req.body.amount);
  res.json(result);
});

export default router;
`,
  "src/utils/formatMoney.ts": `export function formatMoney(cents: number, locale = "en-US"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(cents / 100);
}
`,
};

const NEW_FILES = {
  "src/orders/refundService.ts": `import { db } from "../db/client";

export async function refundOrder(orderId: string, amount: number) {
  const [order] = await db.query(\`SELECT * FROM orders WHERE id = '\${orderId}'\`);
  if (!order) throw new Error("not found");
  if (order.total_cents < amount) throw new Error("too much");
  await db.query(\`UPDATE orders SET total_cents = total_cents - \${amount} WHERE id = '\${orderId}'\`);
  const [refund] = await db.query(
    \`INSERT INTO refunds (order_id, amount) VALUES ('\${orderId}', \${amount}) RETURNING *\`,
  );
  return refund;
}
`,
  "db/migrations/004_add_order_status.sql": `ALTER TABLE orders ADD COLUMN status text;
UPDATE orders SET status = 'pending' WHERE status IS NULL;
ALTER TABLE orders ALTER COLUMN status SET NOT NULL;
ALTER TABLE orders ALTER COLUMN total_cents TYPE bigint;
CREATE INDEX orders_status_idx ON orders (status);
DROP INDEX orders_customer_id_idx;
`,
  "src/orders/checkout.test.ts": `import { OrderService } from "./orderService";

test("checkout returns an order", async () => {
  const service = new OrderService({} as any);
  const result = await service.checkout("customer-1", { items: [] });
  expect(result).toBeTruthy();
});
`,
};

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZsAAAAASUVORK5CYII=",
  "base64",
);

function write(root, file, content) {
  const target = path.join(root, file);
  ensureDir(path.dirname(target));
  fs.writeFileSync(target, content, "utf8");
}

function git(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed\n${result.stderr || ""}`);
  }
  return result.stdout;
}

export function createFixture({ dir, keepIfExists = false } = {}) {
  const root = dir || fs.mkdtempSync(path.join(os.tmpdir(), "code-review-fixture-"));
  if (keepIfExists && fs.existsSync(root)) {
    return root;
  }
  if (fs.existsSync(root)) removeRecursive(root);
  ensureDir(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "fixture@example.test"]);
  git(root, ["config", "user.name", "Review Fixture"]);
  for (const [file, content] of Object.entries(BASE_FILES)) write(root, file, content);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "base: orders service"]);

  // Rename a utility before changing it so git can detect the rename.
  git(root, ["mv", "src/utils/money.ts", "src/utils/formatMoney.ts"]);
  write(root, "src/utils/formatMoney.ts", MODIFIED_FILES["src/utils/formatMoney.ts"]);

  // Delete the legacy helper.
  fs.rmSync(path.join(root, "src/legacy/legacyPricing.ts"));
  git(root, ["rm", "-q", "src/legacy/legacyPricing.ts"]);

  // Stage one repository change; leave the rest in the working tree.
  write(root, "src/orders/orderRepository.ts", MODIFIED_FILES["src/orders/orderRepository.ts"]);
  git(root, ["add", "src/orders/orderRepository.ts"]);

  // Unstaged edits.
  write(root, "src/orders/orderService.ts", MODIFIED_FILES["src/orders/orderService.ts"]);
  write(root, "src/api/orders.ts", MODIFIED_FILES["src/api/orders.ts"]);

  // Untracked work.
  for (const [file, content] of Object.entries(NEW_FILES)) write(root, file, content);

  // A binary asset should be listed but not rendered as code.
  const assetDir = path.join(root, "assets");
  ensureDir(assetDir);
  fs.writeFileSync(path.join(assetDir, "logo.png"), PNG_1X1);

  return root;
}

if (process.argv[1] && process.argv[1].endsWith("fixture.mjs")) {
  const root = createFixture({ dir: process.argv[2] });
  console.log(root);
}
