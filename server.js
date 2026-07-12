const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');

// 로컬 환경을 위한 .env 설정 (Render에서는 Dashboard의 Env Vars가 우선 적용됨)
dotenv.config({ path: path.join(__dirname, '.env') });

// db 모듈 불러오기 추가 (이 부분이 없으면 아래 API에서 에러 발생)
const db = require('./db_3');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 'public' 폴더 하위에 index.html 및 schema_3.sql이 물리적으로 위치하게 되므로, 정적 미들웨어로 일괄 호스팅합니다.
app.use(express.static(path.join(__dirname, 'public'))); 

// root 경로 접속 시 public 폴더 내부의 index.html을 원활히 서빙합니다.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health Check Endpoint (Render 등에서 컨테이너 수명 주기 모니터링용)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date() });
});

// ==========================================
// API Endpoints
// ==========================================

app.post('/api/auth/login', async (req, res) => {
  res.json({ message: 'Login successful', token: 'mock-jwt-token', role: 'MEMBER' });
});

app.get('/api/contents/videos', async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM public.youtube_videos WHERE status = 'PUBLISHED' ORDER BY published_at DESC LIMIT 10");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/shop/products', async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM public.products WHERE status = 'PUBLISHED' ORDER BY created_at DESC LIMIT 10");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/shop/cart', (req, res) => {
  res.status(201).json({ message: 'Item added to cart' });
});

app.get('/api/office/dashboard/summary', async (req, res) => {
  res.json({
    todaySales: 12345000,
    newOrders: 412,
    pendingInquiries: 15,
    pendingApprovals: 5
  });
});

app.listen(PORT, () => {
  console.log(`Ohseyokr Backend API Server is running on port ${PORT}`);
});