const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');

// 로컬 환경을 위한 .env 설정 (Render에서는 Dashboard의 Env Vars가 우선 적용됨)
dotenv.config({ path: path.join(__dirname, '.env') });

// 실제 DB 모듈 연결
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 'public' 폴더 정적 서빙 (index.html 및 schema.sql 포함)
app.use(express.static(path.join(__dirname, 'public'))); 

// root 경로 접속 시 public 폴더 내부의 index.html을 서빙합니다.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health Check Endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date() });
});

// ==========================================
// API Endpoints
// ==========================================

// 1. Auth API
app.post('/api/auth/login', async (req, res) => {
  res.json({ message: 'Login successful', token: 'mock-jwt-token', role: 'MEMBER' });
});

// 2. Contents API (TOPIK 영상 - PUBLISHED 상태만 조회)
app.get('/api/contents/videos', async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM public.youtube_videos WHERE status = 'PUBLISHED' ORDER BY published_at DESC LIMIT 10");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Shop API (K-Goods - PUBLISHED 상태만 조회)
app.get('/api/shop/products', async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM public.products WHERE status = 'PUBLISHED' ORDER BY created_at DESC LIMIT 10");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Cart API
app.post('/api/shop/cart', (req, res) => {
  res.status(201).json({ message: 'Item added to cart' });
});

// 5. Office KPI & 승인 대기 리스트 조회 API
app.get('/api/office/dashboard/summary', async (req, res) => {
  try {
    // 실제 데이터베이스 종합 통계 쿼리 실행
    const salesRes = await db.query("SELECT COALESCE(SUM(total_amount), 0) as total FROM public.orders");
    const ordersRes = await db.query("SELECT COUNT(*) as count FROM public.orders");
    const usersRes = await db.query("SELECT COUNT(*) as count FROM public.users");
    
    const pendingVideosRes = await db.query("SELECT COUNT(*) as count FROM public.youtube_videos WHERE status = 'PENDING'");
    const pendingProductsRes = await db.query("SELECT COUNT(*) as count FROM public.products WHERE status = 'DRAFT'");
    const pendingCount = Number(pendingVideosRes.rows[0].count) + Number(pendingProductsRes.rows[0].count);

    // 승인 대기함 목록 조회용 결합 배열 생성
    const pendingItemsList = [];
    const videos = await db.query("SELECT '영상' as type, title, 'staff_cs' as requester, status FROM public.youtube_videos WHERE status = 'PENDING' ORDER BY created_at DESC");
    const products = await db.query("SELECT '상품' as type, name as title, 'staff_md' as requester, status FROM public.products WHERE status = 'DRAFT' ORDER BY created_at DESC");
    
    res.json({
      todaySales: Number(salesRes.rows[0].total),
      newOrders: Number(ordersRes.rows[0].count),
      newUsers: Number(usersRes.rows[0].count),
      pendingApprovals: pendingCount,
      pendingItems: [...videos.rows, ...products.rows]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. 일괄 승인 처리 API (PENDING -> PUBLISHED)
app.post('/api/office/approve', async (req, res) => {
  try {
    await db.query("UPDATE public.youtube_videos SET status = 'PUBLISHED' WHERE status = 'PENDING'");
    await db.query("UPDATE public.products SET status = 'PUBLISHED' WHERE status = 'DRAFT'");
    res.json({ success: true, message: 'All pending contents and products approved successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 🛠️ 데모용 데이터 자가 발전 (Self-Seeding) 함수
// ==========================================
async function seedDemoData() {
  try {
    // 1. 유저 데이터 자가 발전
    const userCheck = await db.query("SELECT COUNT(*) FROM public.users");
    if (Number(userCheck.rows[0].count) === 0) {
      await db.query(`
        INSERT INTO public.users (id, email, name, role, status)
        VALUES 
        ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'student@ohseyokr.com', 'Kim Minjun', 'MEMBER', 'ACTIVE'),
        ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12', 'admin@ohseyokr.com', '관리자', 'ADMIN', 'ACTIVE')
      `);
    }

    // 2. 데모 주문 데이터 자가 발전 (대시보드 실시간 매출 표기용)
    const orderCheck = await db.query("SELECT COUNT(*) FROM public.orders");
    if (Number(orderCheck.rows[0].count) === 0) {
      await db.query(`
        INSERT INTO public.orders (id, order_no, user_id, total_amount, status)
        VALUES 
        ('e1eebc99-9c0b-4ef8-bb6d-6bb9bd380123', '20260710-001', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 34000.00, 'PAID'),
        ('e1eebc99-9c0b-4ef8-bb6d-6bb9bd380124', '20260710-002', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 19000.00, 'SHIPPED')
      `);
    }

    // 3. 테스트용 승인 대기 영상 강제 주입
    const pendingVideoCheck = await db.query("SELECT COUNT(*) FROM public.youtube_videos WHERE status = 'PENDING'");
    if (Number(pendingVideoCheck.rows[0].count) === 0) {
      await db.query(`
        INSERT INTO public.youtube_videos (id, video_id, title, description, thumbnail_url, duration_seconds, published_at, topik_level, category, status)
        VALUES (
          'e1eebc99-9c0b-4ef8-bb6d-6bb9bd380a33', 
          'PENDING_VIDEO_DEMO', 
          '[대기중] TOPIK II 쓰기 만점 전략 - 54번 논설문 완벽 해부', 
          '점수 배점이 가장 높은 쓰기 영역 완벽 고득점 공략법 강의입니다.', 
          'https://placehold.co/400x225/f5f3ff/8b5cf6?text=TOPIK+Writing', 
          3120, 
          NOW(), 
          '고급', 
          '쓰기', 
          'PENDING'
        )
        ON CONFLICT (video_id) DO NOTHING
      `);
    }

    // 4. 테스트용 승인 대기 상품 강제 주입
    const pendingProductCheck = await db.query("SELECT COUNT(*) FROM public.products WHERE status = 'DRAFT'");
    if (Number(pendingProductCheck.rows[0].count) === 0) {
      await db.query(`
        INSERT INTO public.products (id, category_id, name, description, base_price, discount_rate, stock_quantity, thumbnail_url, status)
        VALUES (
          'e1eebc99-9c0b-4ef8-bb6d-6bb9bd380a44', 
          'c1eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 
          '[대기중] 한국 정통 홍삼 진액 에센스 에디션 세트', 
          '해외 고객이 극찬한 피부 활력 프리미엄 기획 세트 구성', 
          68000.00, 
          10.00, 
          99, 
          'https://placehold.co/300x300/fdf2f8/ec4899?text=Ginseng+Essence', 
          'DRAFT'
        )
        ON CONFLICT (id) DO NOTHING
      `);
    }
    console.log("🚀 Demo data self-seeding checking/execution completed!");
  } catch (err) {
    console.error("❌ Self-seeding error occurred:", err);
  }
}

app.listen(PORT, async () => {
  console.log(`Ohseyokr Backend API Server is running on port ${PORT}`);
  // 서버가 켜질 때 DB에 필요한 기본 유저 및 승인 대기 체험용 데이터를 체크 및 강제 입력합니다.
  await seedDemoData();
});
