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
// HTML 파일을 / 로 접속했을 때 서빙하기 위해 추가 설정
app.use(express.static(path.join(__dirname, 'public'))); 
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Google OAuth Client Setup
// Render 환경 변수에서 가져오며, 누락 시 에러 방지를 위해 빈 문자열 허용 후 체크
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
if (!GOOGLE_CLIENT_ID) {
    console.warn("⚠️ Warning: GOOGLE_CLIENT_ID is not set in environment variables!");
}
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_for_dev_only';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || process.env.ADMIN_ID;

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

const requireAdmin = (req, res, next) => {
    if (req.user.role !== 'ADMIN') {
        return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
    }
    next();
};

const requireStaffOrAdmin = (req, res, next) => {
    if (req.user.role !== 'STAFF' && req.user.role !== 'ADMIN') {
        return res.status(403).json({ error: '직원 권한이 필요합니다.' });
    }
    next();
};

// --- 설정 및 설정 정보 전달 API ---
// 프론트엔드에서 하드코딩 없이 Google Client ID를 받아갈 수 있도록 API 추가
app.get('/api/public/config', (req, res) => {
    res.json({
        googleClientId: GOOGLE_CLIENT_ID
    });
});

// --- Authentication Routes (로그인 & 회원가입 통합) ---
app.post('/api/auth/google', async (req, res) => {
    const { credential } = req.body;
    
    if (!GOOGLE_CLIENT_ID) {
        return res.status(500).json({ error: 'Server misconfiguration: Missing Google Client ID' });
    }

    try {
        const ticket = await googleClient.verifyIdToken({
            idToken: credential,
            audience: GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        const { sub, email, name, picture } = payload;

        let userResult = await db.query('SELECT * FROM public.users WHERE email = $1', [email]);
        let user;

        if (userResult.rows.length === 0) {
            // [회원가입 로직] 해당 이메일이 없으면 새로 생성
            // Check if this email matches the Admin Email Environment Variable
            const initialRole = (ADMIN_EMAIL && email === ADMIN_EMAIL) ? 'ADMIN' : 'MEMBER';
            
            const insertUser = await db.query(
                `INSERT INTO public.users (email, name, profile_image_url, login_type, role) 
                 VALUES ($1, $2, $3, 'GOOGLE', $4) RETURNING *`,
                [email, name, picture, initialRole]
            );
            user = insertUser.rows[0];

            await db.query(
                `INSERT INTO public.oauth_accounts (user_id, provider_uid, provider_email) VALUES ($1, $2, $3)`,
                [user.id, sub, email]
            );
        } else {
            // [로그인 로직] 기존 유저 로그인 처리
            user = userResult.rows[0];
            
            // Auto Admin Promotion Check on Login
            if (ADMIN_EMAIL && email === ADMIN_EMAIL && user.role !== 'ADMIN') {
                const updateAdmin = await db.query(
                    `UPDATE public.users SET role = 'ADMIN' WHERE id = $1 RETURNING *`,
                    [user.id]
                );
                user = updateAdmin.rows[0];
            }

            await db.query(`UPDATE public.users SET last_login_at = NOW() WHERE id = $1`, [user.id]);
        }

        const token = jwt.sign(
            { userId: user.id, email: user.email, role: user.role, name: user.name },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, profile: user.profile_image_url } });
    } catch (error) {
        console.error('Google Auth Error:', error);
        res.status(401).json({ error: '유효하지 않은 인증 정보입니다.' });
    }
});

// --- Public Data Routes ---
app.get('/api/public/data', async (req, res) => {
    try {
        const videos = await db.query("SELECT * FROM public.youtube_videos WHERE status = 'PUBLISHED' ORDER BY created_at DESC LIMIT 6");
        const products = await db.query("SELECT * FROM public.products WHERE status = 'PUBLISHED' ORDER BY created_at DESC LIMIT 8");
        res.json({
            videos: videos.rows,
            products: products.rows
        });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

// --- Office (Staff) Routes ---
app.get('/api/office/dashboard', authenticateToken, requireStaffOrAdmin, async (req, res) => {
    try {
        const pendingProducts = await db.query("SELECT * FROM public.products WHERE status = 'PENDING'");
        const pendingVideos = await db.query("SELECT * FROM public.youtube_videos WHERE status = 'PENDING'");
        res.json({
            pendingProducts: pendingProducts.rows,
            pendingVideos: pendingVideos.rows
        });
    } catch(e) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/office/approve', authenticateToken, requireStaffOrAdmin, async (req, res) => {
    try {
        await db.query("UPDATE public.products SET status = 'PUBLISHED' WHERE status = 'PENDING'");
        await db.query("UPDATE public.youtube_videos SET status = 'PUBLISHED' WHERE status = 'PENDING'");
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: 'Server error' });
    }
});

// --- Admin Center Routes ---

app.get('/api/admin/users/search', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) return res.json({ users: [] });

        const users = await db.query(
            `SELECT id, name, email, role, created_at 
             FROM public.users 
             WHERE (email ILIKE $1 OR name ILIKE $1) AND role = 'MEMBER'
             LIMIT 10`,
            [`%${q}%`]
        );
        res.json({ users: users.rows });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/admin/staff', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const staffList = await db.query(
            `SELECT id, name, email, role, staff_position, created_at 
             FROM public.users 
             WHERE role IN ('STAFF', 'ADMIN')
             ORDER BY 
                CASE role WHEN 'ADMIN' THEN 1 ELSE 2 END,
                created_at ASC`
        );
        res.json({ staff: staffList.rows });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/admin/staff/add', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { userId, position } = req.body;
        
        const checkUser = await db.query('SELECT role, email FROM public.users WHERE id = $1', [userId]);
        if(checkUser.rows.length === 0) return res.status(404).json({error: 'User not found'});
        if(checkUser.rows[0].email === ADMIN_EMAIL) return res.status(400).json({error: '최고 관리자 권한은 수정할 수 없습니다.'});

        await db.query(
            `UPDATE public.users SET role = 'STAFF', staff_position = $1 WHERE id = $2`,
            [position, userId]
        );
        res.json({ success: true, message: '직원으로 지정되었습니다.' });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/admin/staff/remove', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { userId } = req.body;
        
        const checkUser = await db.query('SELECT email FROM public.users WHERE id = $1', [userId]);
        if(checkUser.rows.length > 0 && checkUser.rows[0].email === ADMIN_EMAIL) {
            return res.status(400).json({error: '최고 관리자 권한은 해제할 수 없습니다.'});
        }

        await db.query(
            `UPDATE public.users SET role = 'MEMBER', staff_position = NULL WHERE id = $1`,
            [userId]
        );
        res.json({ success: true, message: '일반 회원으로 변경되었습니다.' });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/admin/summary', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const userCount = await db.query("SELECT COUNT(*) FROM public.users");
        const orderCount = await db.query("SELECT COUNT(*) FROM public.orders");
        const productCount = await db.query("SELECT COUNT(*) FROM public.products");
        res.json({
            totalUsers: userCount.rows[0].count,
            totalOrders: orderCount.rows[0].count,
            totalProducts: productCount.rows[0].count
        });
    } catch(e) {
        res.status(500).json({ error: 'Server error' });
    }
});


// Initialization Function to inject mock data if needed
async function initMockData() {
  try {
    const categoryCheck = await db.query("SELECT COUNT(*) FROM public.product_categories");
    let beautyCatId = 'c1eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
    let stationeryCatId = 'c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
    
    if (Number(categoryCheck.rows[0].count) === 0) {
      await db.query(`INSERT INTO public.product_categories (id, name, slug, display_order) VALUES ('${beautyCatId}', 'K-뷰티', 'k-beauty', 1), ('${stationeryCatId}', '도서/문구', 'books-and-stationery', 2)`);
    }

    const videoCheck = await db.query("SELECT COUNT(*) FROM public.youtube_videos");
    if (Number(videoCheck.rows[0].count) === 0) {
        await db.query(`INSERT INTO public.youtube_videos (title, youtube_id, status) VALUES 
        ('한국어 인사말 배우기', 'P0s0N9QeX3Q', 'PUBLISHED'),
        ('TOPIK 1급 단어 모음', 'P0s0N9QeX3Q', 'PUBLISHED'),
        ('한국 길거리 음식 투어', 'P0s0N9QeX3Q', 'PENDING')
        `);
    }

    const productCheck = await db.query("SELECT COUNT(*) FROM public.products");
    if (Number(productCheck.rows[0].count) === 0) {
        await db.query(`INSERT INTO public.products (category_id, name, price, status, image_url) VALUES 
        ('${beautyCatId}', '인기 K-뷰티 마스크팩 세트', 25000, 'PUBLISHED', 'https://images.unsplash.com/photo-1596462502278-27bfdc403348?auto=format&fit=crop&q=80&w=400&h=400'),
        ('${stationeryCatId}', 'TOPIK 종합서 1급-2급', 18000, 'PUBLISHED', 'https://images.unsplash.com/photo-1544947950-fa07a98d237f?auto=format&fit=crop&q=80&w=400&h=400'),
        ('${stationeryCatId}', '귀여운 한글 스티커', 5000, 'PENDING', 'https://images.unsplash.com/photo-1572097486801-b541d4fa4c68?auto=format&fit=crop&q=80&w=400&h=400')
        `);
    }

    console.log("Mock data initialized successfully.");
  } catch (err) {
    console.error("Failed to initialize mock data:", err);
  }
}

// Start server
app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);
  await initMockData();
});
