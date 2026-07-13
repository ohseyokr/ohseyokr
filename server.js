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
app.use(express.static(path.join(__dirname, 'public'))); 

// Google OAuth Client Setup
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_for_dev_only';

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

// --- Admin Verification Middleware ---
const authenticateAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'ADMIN') {
      next();
  } else {
      res.status(403).json({ error: "Access denied. Admin privileges required." });
  }
};

// Root page server handler
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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

// 1. Google Login & Signup Flow (Includes ADMIN auto-assignment via Environment Variables)
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
    const { sub, email, name, picture } = payload; // sub is Google's unique User ID

    // Render Cloud Environment Variable check
    const adminEmail = process.env.ADMIN_ID; 
    let targetRole = (email === adminEmail) ? 'ADMIN' : 'MEMBER';

    client = await db.getClient();
    await client.query('BEGIN');

    // 2. Check if user exists by email
    let userRes = await client.query('SELECT * FROM public.users WHERE email = $1', [email]);
    let user = userRes.rows[0];

    if (!user) {
        // Create new user with assigned role
        const insertUser = await client.query(
            `INSERT INTO public.users (email, name, profile_image_url, role, login_type) 
             VALUES ($1, $2, $3, $4, 'GOOGLE') RETURNING *`,
            [email, name, picture, targetRole]
        );
        user = insertUser.rows[0];
    } else {
        // If user exists but their role needs to be upgraded to ADMIN based on ENV variable
        if (targetRole === 'ADMIN' && user.role !== 'ADMIN') {
            const updateUser = await client.query(
                `UPDATE public.users SET role = 'ADMIN' WHERE id = $1 RETURNING *`,
                [user.id]
            );
            user = updateUser.rows[0];
        }
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

    // Update last login
    await client.query('UPDATE public.users SET last_login_at = NOW() WHERE id = $1', [user.id]);
    await client.query('COMMIT');

    // 4. Generate App JWT Token
    const appToken = jwt.sign(
        { userId: user.id, role: user.role, email: user.email, name: user.name },
        JWT_SECRET,
        { expiresIn: '7d' } // Session valid for 7 days
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


// --- Business Logic Endpoints ---

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

// --- MyPage Endpoints ---
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
      user: { name: user.name, grade: user.member_grade || 'SILVER', createdAt: user.created_at },
      stats: { points: 12500, coupons: 3, reviews: 24, qna: 16 },
      orders: ordersRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Admin (OFFICE) Endpoints ---

// Dashboard Summary (Requires ADMIN role)
app.get('/api/office/dashboard/summary', authenticateToken, authenticateAdmin, async (req, res) => {
    try {
        // In a real scenario, these queries would filter by date (e.g., today)
        // For demonstration of the wireframe, we return aggregated totals or mock data if tables are empty.
        
        // 1. Total Sales (Mocking daily filter for brevity)
        const salesRes = await db.query("SELECT COALESCE(SUM(total_amount), 0) as total FROM public.orders WHERE status = 'PAID'");
        
        // 2. Total Orders
        const ordersRes = await db.query("SELECT COUNT(*) as count FROM public.orders");
        
        // 3. Total Users
        const usersRes = await db.query("SELECT COUNT(*) as count FROM public.users");
        
        // 4. Pending Approvals (Videos + Products combined conceptually)
        const pendingVideosRes = await db.query("SELECT COUNT(*) as count FROM public.youtube_videos WHERE status = 'PENDING'");
        
        res.json({
            todaySales: Number(salesRes.rows[0].total) || 1245000,
            newOrders: Number(ordersRes.rows[0].count) || 152,
            newUsers: Number(usersRes.rows[0].count) || 34,
            pendingApprovals: Number(pendingVideosRes.rows[0].count) || 8
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Users List for Admin
app.get('/api/office/users', authenticateToken, authenticateAdmin, async (req, res) => {
    try {
        const usersRes = await db.query("SELECT id, name, email, role, created_at, status FROM public.users ORDER BY created_at DESC LIMIT 50");
        res.json(usersRes.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Orders List for Admin
app.get('/api/office/orders', authenticateToken, authenticateAdmin, async (req, res) => {
    try {
        const ordersRes = await db.query(`
            SELECT o.id, o.order_no, o.total_amount, o.status, o.created_at, u.name as user_name
            FROM public.orders o
            JOIN public.users u ON o.user_id = u.id
            ORDER BY o.created_at DESC LIMIT 50
        `);
        res.json(ordersRes.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Batch Approve Action
app.post('/api/office/approve', authenticateToken, authenticateAdmin, async (req, res) => {
    try {
        await db.query("UPDATE public.youtube_videos SET status = 'PUBLISHED' WHERE status = 'PENDING'");
        res.json({ success: true, message: "All pending items approved." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});