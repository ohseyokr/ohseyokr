const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');

// Load environment variables (.env file config)
dotenv.config({ path: path.join(__dirname, '.env') });

// Import PostgreSQL Database connection module
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware setups
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static assets from 'public' folder
// index.html is served explicitly below. Do not expose the project directory:
// it contains server.js, schema.sql and deployment configuration.

// Google OAuth Client Setup
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_for_dev_only';
if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || !process.env.GOOGLE_CLIENT_ID)) {
  throw new Error('JWT_SECRET and GOOGLE_CLIENT_ID must be configured in production');
}
// Use ADMIN_ID in Render. The legacy key is accepted for an existing dashboard.
const ADMIN_EMAIL = (process.env.ADMIN_ID || process.env['Admin ID'] || '').trim().toLowerCase();
const isConfiguredAdmin = (email) => ADMIN_EMAIL && email && email.toLowerCase() === ADMIN_EMAIL;
const writeAuditLog = (client, actorId, action, targetTable, targetId, beforeValue = null, afterValue = null, ip = null) =>
  client.query(`INSERT INTO public.admin_activity_logs
    (actor_id, action, target_table, target_id, before_value, after_value, ip_address)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [actorId, action, targetTable, targetId, beforeValue, afterValue, ip]);

// --- JWT Verification Middleware ---
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (token == null) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
      if (err) return res.sendStatus(403);
      req.user = user;
      next();
  });
};

// Admin Only Middleware
const authenticateAdmin = (req, res, next) => {
    authenticateToken(req, res, () => {
        if (req.user.role !== 'ADMIN') {
            return res.status(403).json({ error: "Forbidden: Admin access required" });
        }
        next();
    });
};

// Root page server handler
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date() });
});

// --- Authentication Endpoints ---

// 0. Provide Frontend with Configs (Client ID)
app.get('/api/config', (req, res) => {
  res.json({ GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '' });
});

// 1. Google Login & Signup Flow
app.post('/api/auth/google', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "Token is required" });

  let client = null;
  try {
    // 1. Verify Google Token
    const ticket = await googleClient.verifyIdToken({
        idToken: token,
        audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const { sub, email, name, picture } = payload; 

    client = await db.getClient();
    await client.query('BEGIN');

    // Resolve the immutable Google subject before the email address; this keeps
    // one Google account from being linked to another account by email alone.
    const linked = await client.query(`SELECT u.* FROM public.oauth_accounts oa
      JOIN public.users u ON u.id = oa.user_id WHERE oa.provider = 'GOOGLE' AND oa.provider_uid = $1`, [sub]);
    let user = linked.rows[0];
    if (!user) {
      const userRes = await client.query('SELECT * FROM public.users WHERE email = $1', [email]);
      user = userRes.rows[0];
    }

    if (!user) {
        // Create new user
        const insertUser = await client.query(
            `INSERT INTO public.users (email, name, profile_image_url, role, login_type) 
             VALUES ($1, $2, $3, 'MEMBER', 'GOOGLE') RETURNING *`,
            [email, name, picture]
        );
        user = insertUser.rows[0];
    }

    // 3. Check and link OAuth Account if not exists
    let oauthRes = await client.query('SELECT * FROM public.oauth_accounts WHERE provider_uid = $1', [sub]);
    if (oauthRes.rows.length === 0) {
        await client.query(
            `INSERT INTO public.oauth_accounts (user_id, provider, provider_uid, provider_email)
             VALUES ($1, 'GOOGLE', $2, $3)`,
             [user.id, sub, email]
        );
    }

    // The configured Render email is automatically and exclusively an admin.
    if (isConfiguredAdmin(email) && user.role !== 'ADMIN') {
      const promoted = await client.query("UPDATE public.users SET role = 'ADMIN', last_login_at = NOW() WHERE id = $1 RETURNING *", [user.id]);
      user = promoted.rows[0];
    } else {
      await client.query('UPDATE public.users SET last_login_at = NOW() WHERE id = $1', [user.id]);
    }
    await client.query('COMMIT');

    // 4. Generate App JWT Token
    const appToken = jwt.sign(
        { userId: user.id, role: user.role, email: user.email, name: user.name },
        JWT_SECRET,
        { expiresIn: '7d' } 
    );

    res.json({ 
      token: appToken, 
      user: { id: user.id, name: user.name, email: user.email, role: user.role, picture: user.profile_image_url } 
    });

  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error("Google Auth Error:", err);
    res.status(401).json({ error: "Invalid Google Token or Server Error" });
  } finally {
    if (client) client.release();
  }
});

// 2. Fetch Current User via App Token
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const userRes = await db.query('SELECT id, email, name, role, profile_image_url FROM public.users WHERE id = $1', [req.user.userId]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: "User not found" });
    
    res.json({ user: userRes.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// --- Business Logic Endpoints (Unchanged) ---

app.get('/api/contents/videos', async (req, res) => {
  try {
    const { category } = req.query;
    let queryText = "SELECT * FROM public.youtube_videos WHERE status = 'PUBLISHED'";
    const queryParams = [];

    if (category && category !== '전체') {
      queryText += " AND category = $1";
      queryParams.push(category);
    }
    
    queryText += " ORDER BY published_at DESC LIMIT 12";
    const result = await db.query(queryText, queryParams);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/shop/products', async (req, res) => {
  try {
    const { category } = req.query;
    let queryText = "SELECT * FROM public.products WHERE status = 'PUBLISHED'";
    const queryParams = [];

    if (category && category !== '전체') {
      let slug = 'k-beauty';
      if (category === '도서/문구') slug = 'books-and-stationery';
      if (category === 'K-푸드') slug = 'k-food';

      queryText += " AND category_id = (SELECT id FROM public.product_categories WHERE slug = $1)";
      queryParams.push(slug);
    }

    queryText += " ORDER BY created_at DESC LIMIT 12";
    const result = await db.query(queryText, queryParams);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/shop/checkout', authenticateToken, async (req, res) => {
  const client = await db.getClient();
  try {
    const { items, totalAmount } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: "No items in cart" });

    await client.query('BEGIN');
    const userId = req.user.userId;
    const orderNo = `ORD-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${Math.floor(1000 + Math.random() * 9000)}`;

    const orderInsertRes = await client.query(
      "INSERT INTO public.orders (order_no, user_id, total_amount, status) VALUES ($1, $2, $3, 'PAID') RETURNING id",
      [orderNo, userId, totalAmount]
    );
    const orderId = orderInsertRes.rows[0].id;

    for (const item of items) {
      let skuRes = await client.query("SELECT id FROM public.product_skus WHERE product_id = $1 LIMIT 1", [item.id]);
      let skuId = skuRes.rows[0]?.id;

      if (!skuId) {
        const newSku = await client.query(
          "INSERT INTO public.product_skus (product_id, sku_code, stock_quantity) VALUES ($1, $2, 100) RETURNING id",
          [item.id, `SKU-${item.id.slice(0,8).toUpperCase()}`]
        );
        skuId = newSku.rows[0].id;
      }

      await client.query(
        "INSERT INTO public.order_items (order_id, sku_id, quantity, unit_price) VALUES ($1, $2, $3, $4)",
        [orderId, skuId, item.quantity, item.price]
      );
      await client.query("UPDATE public.products SET sales_count = sales_count + $1 WHERE id = $2", [item.quantity, item.id]);
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, orderNo, totalAmount });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// --- MyPage Endpoints (Unchanged) ---
app.get('/api/mypage/dashboard', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    const userRes = await db.query('SELECT name, member_grade, created_at FROM public.users WHERE id = $1', [userId]);
    const user = userRes.rows[0];

    const ordersRes = await db.query(`
      SELECT o.order_no, o.created_at, o.total_amount, o.status,
             (SELECT p.name FROM public.order_items oi JOIN public.product_skus ps ON oi.sku_id = ps.id JOIN public.products p ON ps.product_id = p.id WHERE oi.order_id = o.id LIMIT 1) as first_item_name,
             (SELECT COUNT(*) FROM public.order_items WHERE order_id = o.id) as item_count
      FROM public.orders o
      WHERE o.user_id = $1
      ORDER BY o.created_at DESC LIMIT 3
    `, [userId]);

    res.json({
      user: {
        name: user.name,
        grade: user.member_grade || 'SILVER',
        createdAt: user.created_at
      },
      stats: {
        points: 12500,
        coupons: 3,   
        reviews: 24,  
        qna: 16       
      },
      orders: ordersRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// --- Office / Admin Endpoints (Enhanced) ---

/* Legacy dashboard implementation retained for reference; malformed source text
   in its localized status label made the module unparsable. */
/*
app.get('/api/office/dashboard/summary', authenticateToken, async (req, res) => {
  if (req.user.role !== 'ADMIN' && req.user.role !== 'STAFF') return res.status(403).json({ error: "Forbidden" });

  try {
    const salesRes = await db.query("SELECT COALESCE(SUM(total_amount), 0) as total FROM public.orders");
    const ordersRes = await db.query("SELECT COUNT(*) as count FROM public.orders");
    const usersRes = await db.query("SELECT COUNT(*) as count FROM public.users");
    
    const pendingVideosRes = await db.query("SELECT COUNT(*) as count FROM public.youtube_videos WHERE status = 'PENDING'");
    const pendingProductsRes = await db.query("SELECT COUNT(*) as count FROM public.products WHERE status = 'DRAFT'");
    const pendingCount = Number(pendingVideosRes.rows[0].count) + Number(pendingProductsRes.rows[0].count);

    const videos = await db.query(`SELECT '영상' as type, id, title, 'staff_cs' as requester, status FROM public.youtube_videos WHERE status = 'PENDING' ORDER BY created_at DESC`);
    const products = await db.query(`SELECT '상품' as type, id, name as title, 'staff_md' as requester, 'PENDING' as status FROM public.products WHERE status = 'DRAFT' ORDER BY created_at DESC`);
    const pendingItems = [...videos.rows, ...products.rows];

    const recentOrdersRes = await db.query(`
      SELECT o.order_no, o.total_amount, o.status, u.name as customer_name
      FROM public.orders o JOIN public.users u ON o.user_id = u.id ORDER BY o.created_at DESC LIMIT 5
    `);
    
    res.json({
      todaySales: Number(salesRes.rows[0].total),
      newOrders: Number(ordersRes.rows[0].count),
      newUsers: Number(usersRes.rows[0].count),
      pendingApprovals: pendingCount,
      pendingItems: pendingItems,
      recentOrders: recentOrdersRes.rows.map(o => ({
        order_no: o.order_no,
        total_amount: Number(o.total_amount),
        status: o.status === 'PAID' ? '결제완료' : '배송중'
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

*/
app.get('/api/office/dashboard/summary', authenticateToken, async (req, res) => {
  if (!['ADMIN', 'STAFF'].includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const [sales, orders, users, videos, products, recentOrders] = await Promise.all([
      db.query("SELECT COALESCE(SUM(total_amount), 0) AS total FROM public.orders WHERE status <> 'CANCELLED'"),
      db.query('SELECT COUNT(*) AS count FROM public.orders'), db.query('SELECT COUNT(*) AS count FROM public.users'),
      db.query("SELECT id, title, status FROM public.youtube_videos WHERE status = 'PENDING' ORDER BY created_at DESC LIMIT 10"),
      db.query("SELECT id, name AS title, status FROM public.products WHERE status = 'DRAFT' ORDER BY created_at DESC LIMIT 10"),
      db.query('SELECT o.order_no, o.total_amount, o.status, u.name AS customer_name FROM public.orders o JOIN public.users u ON u.id = o.user_id ORDER BY o.created_at DESC LIMIT 5')
    ]);
    const pendingItems = [...videos.rows.map(row => ({ ...row, type: 'video' })), ...products.rows.map(row => ({ ...row, type: 'product' }))];
    res.json({ todaySales: Number(sales.rows[0].total), newOrders: Number(orders.rows[0].count), newUsers: Number(users.rows[0].count), pendingApprovals: pendingItems.length, pendingItems, recentOrders: recentOrders.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/office/approve', authenticateToken, async (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: "Forbidden" });
  try {
    await db.query("UPDATE public.youtube_videos SET status = 'PUBLISHED' WHERE status = 'PENDING'");
    await db.query("UPDATE public.products SET status = 'PUBLISHED' WHERE status = 'DRAFT'");
    res.json({ success: true, message: 'All pending items successfully published!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// 1. GET User List for Admin Panel
app.get('/api/office/admin/users', authenticateAdmin, async (req, res) => {
    try {
        const query = "SELECT id, email, name, role, staff_position, created_at, status FROM public.users ORDER BY created_at DESC";
        const result = await db.query(query);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. GET Search specific User by Exact Email (For Staff Assignment)
app.get('/api/office/admin/users/search', authenticateAdmin, async (req, res) => {
    try {
        const { email } = req.query;
        if (!email) return res.status(400).json({ error: "Email is required" });
        
        const query = "SELECT id, email, name, role FROM public.users WHERE email = $1 LIMIT 1";
        const result = await db.query(query, [email]);
        
        if (result.rows.length === 0) return res.status(404).json({ error: "User not found" });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. PUT Update User Role (Promote to Staff/Admin or Demote)
app.put('/api/office/admin/users/:id/role', authenticateAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { role } = req.body;
        
        // ADMIN is reserved for the Render ADMIN_ID email at Google sign-in.
        const validRoles = ['MEMBER', 'STAFF'];
        if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role provided' });
        
        const target = await db.query('SELECT email, role, staff_position FROM public.users WHERE id = $1', [id]);
        if (!target.rows.length) return res.status(404).json({ error: 'User not found' });
        if (id === req.user.userId || isConfiguredAdmin(target.rows[0].email)) {
            return res.status(400).json({ error: 'Configured administrator cannot be modified' });
        }
        const updated = await db.query('UPDATE public.users SET role = $1, staff_position = $2 WHERE id = $3 RETURNING id, role, staff_position', [role, req.body.position || null, id]);
        await writeAuditLog(db, req.user.userId, 'UPDATE_STAFF_ROLE', 'users', id, target.rows[0], updated.rows[0], req.ip);
        res.json({ success: true, message: `Role updated to ${role}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// --- Admin console APIs: content, products, orders, finance, board and settings ---
app.get('/api/office/admin/overview', authenticateAdmin, async (req, res) => {
  try {
    const [videos, products, orders, finance, notices, faqs, settings, logs] = await Promise.all([
      db.query('SELECT id, title, category, topik_level, status, created_at FROM public.youtube_videos ORDER BY created_at DESC LIMIT 50'),
      db.query('SELECT id, name, base_price, stock_quantity, status, created_at FROM public.products ORDER BY created_at DESC LIMIT 50'),
      db.query(`SELECT o.id, o.order_no, o.total_amount, o.status, o.created_at, u.name AS customer_name
        FROM public.orders o JOIN public.users u ON u.id = o.user_id ORDER BY o.created_at DESC LIMIT 50`),
      db.query(`SELECT COALESCE(SUM(total_amount), 0) AS sales, COUNT(*) AS order_count,
        COUNT(*) FILTER (WHERE status = 'PAID') AS paid_count FROM public.orders WHERE status <> 'CANCELLED'`),
      db.query('SELECT id, title, body, view_count, is_published, created_at FROM public.notices ORDER BY created_at DESC LIMIT 30'),
      db.query('SELECT id, question, answer, display_order, is_published, created_at FROM public.faqs ORDER BY display_order, created_at DESC LIMIT 30'),
      db.query('SELECT setting_key, setting_value, updated_at FROM public.system_settings ORDER BY setting_key'),
      db.query(`SELECT l.*, u.name AS actor_name FROM public.admin_activity_logs l
        JOIN public.users u ON u.id = l.actor_id ORDER BY l.created_at DESC LIMIT 30`)
    ]);
    res.json({ videos: videos.rows, products: products.rows, orders: orders.rows,
      finance: { sales: Number(finance.rows[0].sales), orderCount: Number(finance.rows[0].order_count), paidCount: Number(finance.rows[0].paid_count) },
      notices: notices.rows, faqs: faqs.rows, settings: settings.rows, logs: logs.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/office/admin/:resource/:id/status', authenticateAdmin, async (req, res) => {
  const tableByResource = { video: 'youtube_videos', product: 'products', order: 'orders' };
  const table = tableByResource[req.params.resource];
  const { status } = req.body;
  if (!table || !status || !/^[A-Z_]+$/.test(status)) return res.status(400).json({ error: 'Invalid resource or status' });
  try {
    const before = await db.query(`SELECT status FROM public.${table} WHERE id = $1`, [req.params.id]);
    if (!before.rows.length) return res.status(404).json({ error: 'Not found' });
    const updated = await db.query(`UPDATE public.${table} SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING id, status`, [status, req.params.id]);
    await writeAuditLog(db, req.user.userId, 'UPDATE_STATUS', table, req.params.id, before.rows[0], updated.rows[0], req.ip);
    res.json(updated.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/office/admin/:resource', authenticateAdmin, async (req, res) => {
  const { resource } = req.params;
  try {
    if (resource === 'notices') {
      const { title, body, isPublished = true } = req.body;
      if (!title || !body) return res.status(400).json({ error: 'Title and body are required' });
      const result = await db.query('INSERT INTO public.notices (title, body, is_published, created_by) VALUES ($1,$2,$3,$4) RETURNING *', [title, body, isPublished, req.user.userId]);
      await writeAuditLog(db, req.user.userId, 'CREATE_NOTICE', 'notices', result.rows[0].id, null, result.rows[0], req.ip);
      return res.status(201).json(result.rows[0]);
    }
    if (resource === 'faqs') {
      const { question, answer, displayOrder = 0, isPublished = true } = req.body;
      if (!question || !answer) return res.status(400).json({ error: 'Question and answer are required' });
      const result = await db.query('INSERT INTO public.faqs (question, answer, display_order, is_published, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [question, answer, displayOrder, isPublished, req.user.userId]);
      await writeAuditLog(db, req.user.userId, 'CREATE_FAQ', 'faqs', result.rows[0].id, null, result.rows[0], req.ip);
      return res.status(201).json(result.rows[0]);
    }
    res.status(404).json({ error: 'Unknown resource' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/office/admin/settings', authenticateAdmin, async (req, res) => {
  const { settings } = req.body;
  if (!settings || typeof settings !== 'object') return res.status(400).json({ error: 'settings object is required' });
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    for (const [key, value] of Object.entries(settings)) {
      await client.query(`INSERT INTO public.system_settings (setting_key, setting_value, updated_by)
        VALUES ($1,$2,$3) ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`, [key, String(value), req.user.userId]);
    }
    await writeAuditLog(client, req.user.userId, 'UPDATE_SETTINGS', 'system_settings', req.user.userId, null, settings, req.ip);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

async function synchronizeConfiguredAdmin() {
  // A stale database ADMIN grant must not survive a deployment where ADMIN_ID
  // changes. The configured account is promoted when it next signs in.
  if (ADMIN_EMAIL) {
    await db.query("UPDATE public.users SET role = 'MEMBER' WHERE role = 'ADMIN' AND lower(email) <> $1", [ADMIN_EMAIL]);
  } else {
    await db.query("UPDATE public.users SET role = 'MEMBER' WHERE role = 'ADMIN'");
  }
}

// Seed Initial Data
async function seedDemoData() {
  try {
    const categoryCheck = await db.query("SELECT COUNT(*) FROM public.product_categories");
    let beautyCatId = 'c1eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
    let stationeryCatId = 'c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
    
    if (Number(categoryCheck.rows[0].count) === 0) {
      await db.query(`INSERT INTO public.product_categories (id, name, slug, display_order) VALUES ('${beautyCatId}', 'K-뷰티', 'k-beauty', 1), ('${stationeryCatId}', '도서/문구', 'books-and-stationery', 2)`);
    } else {
      const cats = await db.query("SELECT id, slug FROM public.product_categories");
      cats.rows.forEach(row => { if (row.slug === 'k-beauty') beautyCatId = row.id; if (row.slug === 'books-and-stationery') stationeryCatId = row.id; });
    }

    const userCheck = await db.query("SELECT COUNT(*) FROM public.users");
    if (Number(userCheck.rows[0].count) === 0) {
      // Ensure one Admin user exists initially for testing
      await db.query(`INSERT INTO public.users (id, email, name, role, status) VALUES ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'student@ohseyokr.com', 'Kim Minjun', 'MEMBER', 'ACTIVE'), ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12', 'admin@ohseyokr.com', '총괄 관리자', 'ADMIN', 'ACTIVE')`);
    }
  } catch (err) { console.error("Seeding fail:", err); }
}

app.listen(PORT, async () => {
  console.log(`=======================================================`);
  console.log(`🚀 Ohseyokr Active Server running on Port: ${PORT}`);
  console.log(`=======================================================`);
  await synchronizeConfiguredAdmin();
  await seedDemoData();
});
