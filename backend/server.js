const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const db = require('./db');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health Check Endpoint (Render 등에서 헬스체크용으로 사용)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date() });
});

// ==========================================
// API Endpoints (스켈레톤)
// ==========================================

// 1. Auth API
app.post('/api/auth/login', async (req, res) => {
  // TODO: 하이브리드 로그인 로직 구현 (이메일 검증 or 구글 OAuth 콜백)
  res.json({ message: 'Login successful', token: 'mock-jwt-token', role: 'MEMBER' });
});

// 2. Contents API (TOPIK 영상)
app.get('/api/contents/videos', async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM youtube_videos WHERE status = 'PUBLISHED' ORDER BY published_at DESC LIMIT 10");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Shop API (K-Goods)
app.get('/api/shop/products', async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM products WHERE status = 'PUBLISHED' ORDER BY created_at DESC LIMIT 10");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Cart API
app.post('/api/shop/cart', (req, res) => {
  // TODO: 세션 카트 또는 회원 카트에 아이템 추가
  res.status(201).json({ message: 'Item added to cart' });
});

// 5. Office API (STAFF/ADMIN 전용)
app.get('/api/office/dashboard/summary', async (req, res) => {
  // TODO: Role Guard 미들웨어 적용 필요
  res.json({
    todaySales: 12345000,
    newOrders: 412,
    pendingInquiries: 15,
    pendingApprovals: 5
  });
});

// 서버 실행
app.listen(PORT, () => {
  console.log(`Ohseyokr Backend API Server is running on port ${PORT}`);
});