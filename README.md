Ohseyokr (오세요코리아) E-Commerce Platform

TOPIK(한국어능력시험) 무료 학습 콘텐츠를 매개로 해외 학습자를 유입시키고, K-Goods 구매로 전환시키는 콘텐츠-커머스 결합형(Content-to-Commerce) 플랫폼입니다.

📂 프로젝트 구조

본 프로젝트는 Render Cloud 배포에 최적화된 분리형 아키텍처(Backend REST API + Frontend Static Site)로 구성되어 있습니다.

my-render-project/
├── backend/                  # [Render Web Service로 배포]
│   ├── models/
│   │   └── schema.sql        # 데이터베이스 스키마 정의 (PostgreSQL)
│   ├── .env.example          # 환경변수 템플릿 파일
│   ├── .gitignore            # Git 제외 설정 파일
│   ├── db.js                 # PostgreSQL 커넥션 풀 설정 파일
│   ├── package.json          # Node.js 의존성 및 스크립트 설정
│   └── server.js             # Express 서버 진입점 및 API 라우팅
├── frontend/                 # [Render Static Site로 배포]
│   └── index.html            # [통합 파일] HTML 마크업, Tailwind CSS, Vanilla JS 앱 로직 
└── README.md                 # 프로젝트 가이드 (현재 파일)


⚠️ 참고사항: 시스템의 'Single-File Mandate(단일 파일 렌더링 규칙)' 정책에 따라, 프론트엔드 환경에서 요구하신 index.html, style.css, app.js는 모두 frontend/index.html 내부에 <style> 및 <script> 태그를 활용하여 통합 구현되었습니다.

🚀 배포 가이드 (Render Cloud)

1. Database (Managed PostgreSQL)

Render 대시보드에서 New PostgreSQL을 생성합니다.

데이터베이스가 생성되면 제공되는 External Database URL을 복사합니다.

데이터베이스 툴(DBeaver, pgAdmin 등)에 접속하여 backend/models/schema.sql의 쿼리를 실행하여 테이블을 생성합니다.

2. Backend (Web Service)

Render 대시보드에서 New Web Service를 생성합니다.

GitHub Repository를 연결하고, Root Directory를 backend로 설정합니다.

Build Command: npm install

Start Command: npm start

Environment Variables 탭에서 backend/.env.example을 참고하여 환경변수를 입력합니다. (특히 DATABASE_URL에 1단계에서 복사한 Internal Database URL 입력)

3. Frontend (Static Site)

Render 대시보드에서 New Static Site를 생성합니다.

동일한 GitHub Repository를 연결하고, Root Directory를 frontend로 설정합니다.

별도의 Build Command 없이 Publish Directory를 . (현재 디렉토리) 또는 비워둡니다.

💡 주요 기능 (Frontend 데모)

frontend/index.html 파일을 브라우저에서 실행하면 UI를 체험할 수 있습니다.

우측 상단의 회원가입/로그인 버튼을 클릭하여 회원(Member) 모드로 전환.

(Admin 체험) 버튼을 클릭하여 관리자 권한으로 로그인 후, 상단 GNB에 활성화되는 Office (관리자) 버튼을 통해 오피스 대시보드 확인 가능.