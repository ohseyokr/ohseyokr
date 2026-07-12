const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');

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

// Serve static assets from 'public' folder (holds index.html, schema.sql, etc.)
app.use(express.static(path.join(__dirname, 'public'))); 

// Root page server handler
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date() });
});


// 1. Fetching TOPIK Videos (Only status 'PUBLISHED')
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
    console.error("Error loading videos:", err);
    res.status(500).json({ error: err.message });
  }
});

// 2. Fetching K-Goods (Only status 'PUBLISHED')
app.get('/api/shop/products', async (req, res) => {
  try {
    const { category } = req.query;
    let queryText = "SELECT * FROM public.products WHERE status = 'PUBLISHED'";
    const queryParams = [];

    if (category && category !== '전체') {
      // Map category request names to DB structures
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
    console.error("Error loading products:", err);
    res.status(500).json({ error: err.message });
  }
});


// 3. Real Checkout Integration (Creates records in public.orders & order_items)
app.post('/api/shop/checkout', async (req, res) => {
  const client = await db.getClient();
  try {
    const { items, totalAmount } = req.body;
    if (!items || items.length === 0) {
      return res.status(400).json({ error: "No items in cart" });
    }

    // Begin PG Transaction
    await client.query('BEGIN');

    // Fetch or create a default demo user to associate order with
    const userRes = await client.query("SELECT id FROM public.users WHERE email = 'student@ohseyokr.com' LIMIT 1");
    let userId = userRes.rows[0]?.id;
    if (!userId) {
      const newUser = await client.query(
        "INSERT INTO public.users (email, name, role) VALUES ('student@ohseyokr.com', 'Kim Minjun', 'MEMBER') RETURNING id"
      );
      userId = newUser.rows[0].id;
    }

    // Generate random distinct order number
    const orderNo = `ORD-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${Math.floor(1000 + Math.random() * 9000)}`;

    // Insert into Orders Table
    const orderInsertQuery = `
      INSERT INTO public.orders (order_no, user_id, total_amount, status)
      VALUES ($1, $2, $3, 'PAID')
      RETURNING id
    `;
    const orderInsertRes = await client.query(orderInsertQuery, [orderNo, userId, totalAmount]);
    const orderId = orderInsertRes.rows[0].id;

    // Insert into Order Items Table (Mapping items to dummy or resolved SKUs)
    for (const item of items) {
      // Find or create a default SKU for this product
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

      // Increase sales count for products
      await client.query("UPDATE public.products SET sales_count = sales_count + $1 WHERE id = $2", [item.quantity, item.id]);
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, orderNo, totalAmount });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error("Checkout Transaction Error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});


// 4. Admin Dashboard Summary API
app.get('/api/office/dashboard/summary', async (req, res) => {
  try {
    // Dynamically calculate metrics from actual DB
    const salesRes = await db.query("SELECT COALESCE(SUM(total_amount), 0) as total FROM public.orders");
    const ordersRes = await db.query("SELECT COUNT(*) as count FROM public.orders");
    const usersRes = await db.query("SELECT COUNT(*) as count FROM public.users");
    
    const pendingVideosRes = await db.query("SELECT COUNT(*) as count FROM public.youtube_videos WHERE status = 'PENDING'");
    const pendingProductsRes = await db.query("SELECT COUNT(*) as count FROM public.products WHERE status = 'DRAFT'");
    const pendingCount = Number(pendingVideosRes.rows[0].count) + Number(pendingProductsRes.rows[0].count);

    // Dynamic compilation of approval queue list
    const pendingItemsList = [];

    // Get pending videos mapped
    const videos = await db.query(`
      SELECT '영상' as type, id, title, 'staff_cs' as requester, status 
      FROM public.youtube_videos 
      WHERE status = 'PENDING' 
      ORDER BY created_at DESC
    `);
    
    // Get draft products mapped
    const products = await db.query(`
      SELECT '상품' as type, id, name as title, 'staff_md' as requester, 'PENDING' as status 
      FROM public.products 
      WHERE status = 'DRAFT' 
      ORDER BY created_at DESC
    `);

    // Merge outputs
    const pendingItems = [...videos.rows, ...products.rows];

    // Fetch dynamic recent orders table list
    const recentOrdersQuery = `
      SELECT o.order_no, o.total_amount, o.status, u.name as customer_name
      FROM public.orders o
      JOIN public.users u ON o.user_id = u.id
      ORDER BY o.created_at DESC
      LIMIT 5
    `;
    const recentOrdersRes = await db.query(recentOrdersQuery);
    
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
    console.error("Dashboard error:", err);
    res.status(500).json({ error: err.message });
  }
});

// 5. API to approve draft items (Changes states to PUBLISHED)
app.post('/api/office/approve', async (req, res) => {
  try {
    await db.query("UPDATE public.youtube_videos SET status = 'PUBLISHED' WHERE status = 'PENDING'");
    await db.query("UPDATE public.products SET status = 'PUBLISHED' WHERE status = 'DRAFT'");
    res.json({ success: true, message: 'All pending items successfully published!' });
  } catch (err) {
    console.error("Approval error:", err);
    res.status(500).json({ error: err.message });
  }
});

async function seedDemoData() {
  try {
    // 1. Verify and inject basic categories
    const categoryCheck = await db.query("SELECT COUNT(*) FROM public.product_categories");
    let beautyCatId = 'c1eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
    let stationeryCatId = 'c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
    let foodCatId = 'c3eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

    if (Number(categoryCheck.rows[0].count) === 0) {
      await db.query(`
        INSERT INTO public.product_categories (id, name, slug, display_order)
        VALUES 
        ('${beautyCatId}', 'K-뷰티', 'k-beauty', 1),
        ('${stationeryCatId}', '도서/문구', 'books-and-stationery', 2),
        ('${foodCatId}', 'K-푸드', 'k-food', 3)
      `);
    } else {
      // Fetch existing IDs to avoid constraints
      const cats = await db.query("SELECT id, slug FROM public.product_categories");
      cats.rows.forEach(row => {
        if (row.slug === 'k-beauty') beautyCatId = row.id;
        if (row.slug === 'books-and-stationery') stationeryCatId = row.id;
        if (row.slug === 'k-food') foodCatId = row.id;
      });
    }

    // 2. Inject default user
    const userCheck = await db.query("SELECT COUNT(*) FROM public.users");
    if (Number(userCheck.rows[0].count) === 0) {
      await db.query(`
        INSERT INTO public.users (id, email, name, role, status)
        VALUES 
        ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'student@ohseyokr.com', 'Kim Minjun', 'MEMBER', 'ACTIVE'),
        ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12', 'admin@ohseyokr.com', '관리자', 'ADMIN', 'ACTIVE')
      `);
    }

    // 3. Inject standard published videos
    const videoCheck = await db.query("SELECT COUNT(*) FROM public.youtube_videos WHERE status = 'PUBLISHED'");
    if (Number(videoCheck.rows[0].count) === 0) {
      // Need a channel first
      const channelCheck = await db.query("SELECT id FROM public.youtube_channels LIMIT 1");
      let channelId;
      if (channelCheck.rows.length === 0) {
        const newChan = await db.query(`
          INSERT INTO public.youtube_channels (channel_id, title, thumbnail_url, subscriber_count)
          VALUES ('UC_some_channel_id_1', 'Ohseyokr TOPIK 교실', 'https://placehold.co/100x100/4F46E5/FFF?text=Ohseyo', 125000)
          RETURNING id
        `);
        channelId = newChan.rows[0].id;
      } else {
        channelId = channelCheck.rows[0].id;
      }

      await db.query(`
        INSERT INTO public.youtube_videos (channel_id, video_id, title, description, thumbnail_url, duration_seconds, published_at, topik_level, category, status)
        VALUES 
        ('${channelId}', 'VID_001', 'TOPIK II 듣기 실전 모의고사 1회 풀이', '한국어 듣기 완벽 공략', 'https://placehold.co/400x225/Eef2ff/4f46e5?text=TOPIK+Listening', 2720, NOW(), '고급', '듣기', 'PUBLISHED'),
        ('${channelId}', 'VID_002', '기초 한국어 문법 100선 단기 속성', '한국어 필수 문법 핵심 요약 정리', 'https://placehold.co/400x225/Eef2ff/4f46e5?text=Grammar', 4815, NOW(), '초중급', '문법', 'PUBLISHED')
      `);
    }

    // 4. Inject standard published products
    const productCheck = await db.query("SELECT COUNT(*) FROM public.products WHERE status = 'PUBLISHED'");
    if (Number(productCheck.rows[0].count) === 0) {
      await db.query(`
        INSERT INTO public.products (category_id, name, description, base_price, stock_quantity, thumbnail_url, status, is_topik_recommended)
        VALUES 
        ('${beautyCatId}', 'K-뷰티 스킨케어 입문 세트', '피부 자극 없는 고보습 에디션 패키지', 34000.00, 100, 'https://placehold.co/300x300/f8fafc/94a3b8?text=K-Beauty', 'PUBLISHED', false),
        ('${stationeryCatId}', 'TOPIK II 필수 단어 기출 한권 완성', '최신 경향 단어 완벽 바이블 도서', 17000.00, 200, 'https://placehold.co/300x300/f8fafc/94a3b8?text=Book', 'PUBLISHED', true)
      `);
    }

    // 5. Inject a PENDING Video (Ready to be approved dynamically)
    const pendingVidCheck = await db.query("SELECT COUNT(*) FROM public.youtube_videos WHERE status = 'PENDING'");
    if (Number(pendingVidCheck.rows[0].count) === 0) {
      const chan = await db.query("SELECT id FROM public.youtube_channels LIMIT 1");
      const chanId = chan.rows[0].id;
      await db.query(`
        INSERT INTO public.youtube_videos (channel_id, video_id, title, description, thumbnail_url, duration_seconds, published_at, topik_level, category, status)
        VALUES ('${chanId}', 'PENDING_VID_01', '[대기중] TOPIK 쓰기 54번 만점 작성 전략법', '논리적인 글쓰기 전개 꿀팁', 'https://placehold.co/400x225/f5f3ff/8b5cf6?text=TOPIK+Writing', 3120, NOW(), '고급', '쓰기', 'PENDING')
      `);
    }

    // 6. Inject a PENDING/DRAFT Product (Ready to be approved dynamically)
    const pendingProdCheck = await db.query("SELECT COUNT(*) FROM public.products WHERE status = 'DRAFT'");
    if (Number(pendingProdCheck.rows[0].count) === 0) {
      await db.query(`
        INSERT INTO public.products (category_id, name, description, base_price, stock_quantity, thumbnail_url, status)
        VALUES ('${beautyCatId}', '[대기중] 한국 정통 홍삼 스킨 토닉 세트', '생기 넘치는 피부 장벽 리포밍', 68000.00, 50, 'https://placehold.co/300x300/fdf2f8/ec4899?text=Premium+Ginseng', 'DRAFT')
      `);
    }

    console.log("✔️ [Self-Seeding] Postgres demo data successfully validated & structured!");
  } catch (err) {
    console.error("❌ Seeding fail during startup:", err);
  }
}

// Start Node server
app.listen(PORT, async () => {
  console.log(`=======================================================`);
  console.log(`🚀 Ohseyokr Active Server running on Port: ${PORT}`);
  console.log(`=======================================================`);
  await seedDemoData();
});
