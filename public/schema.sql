-- STREAMING_CHUNK: 확장 기능 활성화 및 기본 스키마 지정
-- PostgreSQL 15 기준 Ohseyokr DB 스키마 (Explicit Public Schema 지정 및 UUID 함수 절대경로화)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" SCHEMA public;

-- STREAMING_CHUNK: 1. 회원/인증 도메인 테이블 생성
CREATE TABLE IF NOT EXISTS public.users (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255),
    name VARCHAR(100) NOT NULL,
    profile_image_url TEXT,
    role VARCHAR(20) NOT NULL DEFAULT 'MEMBER', -- MEMBER, STAFF, ADMIN
    login_type VARCHAR(20) NOT NULL DEFAULT 'EMAIL', -- EMAIL, GOOGLE, BOTH
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    email_verified_at TIMESTAMPTZ,
    member_grade VARCHAR(20) DEFAULT 'GENERAL',
    topik_level VARCHAR(10),
    invited_by UUID REFERENCES public.users(id),
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.oauth_accounts (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.users(id),
    provider VARCHAR(20) NOT NULL DEFAULT 'GOOGLE',
    provider_uid VARCHAR(255) UNIQUE NOT NULL,
    provider_email VARCHAR(255) NOT NULL,
    access_token TEXT,
    refresh_token TEXT,
    connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.permissions (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    code VARCHAR(50) UNIQUE NOT NULL,
    menu_group VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.staff_permissions (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.users(id),
    permission_id UUID NOT NULL REFERENCES public.permissions(id),
    granted_by UUID NOT NULL REFERENCES public.users(id),
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.addresses (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.users(id),
    recipient_name VARCHAR(50) NOT NULL,
    phone VARCHAR(30) NOT NULL,
    zip_code VARCHAR(20) NOT NULL,
    address1 VARCHAR(255) NOT NULL,
    address2 VARCHAR(255) NOT NULL,
    is_default BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- STREAMING_CHUNK: 2. TOPIK 콘텐츠 도메인 테이블 생성
CREATE TABLE IF NOT EXISTS public.youtube_channels (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    channel_id VARCHAR(50) UNIQUE NOT NULL,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    thumbnail_url TEXT,
    subscriber_count INTEGER,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.youtube_videos (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    channel_id UUID REFERENCES public.youtube_channels(id),
    video_id VARCHAR(30) UNIQUE NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    thumbnail_url TEXT NOT NULL,
    duration_seconds INTEGER,
    published_at TIMESTAMPTZ NOT NULL,
    topik_level VARCHAR(10),
    category VARCHAR(30),
    view_count_cached INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'PENDING',
    tagged_by UUID REFERENCES public.users(id),
    approved_by UUID REFERENCES public.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.video_tags (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    video_id UUID NOT NULL REFERENCES public.youtube_videos(id),
    tag_name VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.learning_progress (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.users(id),
    video_id UUID NOT NULL REFERENCES public.youtube_videos(id),
    watched_seconds INTEGER DEFAULT 0,
    is_completed BOOLEAN DEFAULT FALSE,
    last_watched_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, video_id)
);

-- STREAMING_CHUNK: 3. 상품/카테고리 도메인 테이블 생성
CREATE TABLE IF NOT EXISTS public.product_categories (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    parent_id UUID REFERENCES public.product_categories(id),
    name VARCHAR(50) NOT NULL,
    slug VARCHAR(60) UNIQUE,
    display_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.products (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    category_id UUID NOT NULL REFERENCES public.product_categories(id),
    name VARCHAR(200) NOT NULL,
    description TEXT,
    base_price NUMERIC(12,2) NOT NULL,
    discount_rate NUMERIC(5,2) DEFAULT 0,
    stock_quantity INTEGER NOT NULL DEFAULT 0,
    thumbnail_url TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'DRAFT',
    is_topik_recommended BOOLEAN DEFAULT FALSE,
    created_by UUID REFERENCES public.users(id),
    approved_by UUID REFERENCES public.users(id),
    sales_count INTEGER DEFAULT 0,
    review_count INTEGER DEFAULT 0,
    avg_rating NUMERIC(3,2) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.content_product_mapping (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    video_id UUID NOT NULL REFERENCES public.youtube_videos(id),
    product_id UUID NOT NULL REFERENCES public.products(id),
    display_order INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'REQUESTED',
    created_by UUID REFERENCES public.users(id),
    approved_by UUID REFERENCES public.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.product_skus (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    product_id UUID NOT NULL REFERENCES public.products(id),
    sku_code VARCHAR(50) UNIQUE,
    additional_price NUMERIC(12,2) DEFAULT 0,
    stock_quantity INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- STREAMING_CHUNK: 4. 장바구니/주문 도메인 테이블 생성
CREATE TABLE IF NOT EXISTS public.carts (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    user_id UUID REFERENCES public.users(id),
    session_key VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.cart_items (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    cart_id UUID NOT NULL REFERENCES public.carts(id),
    sku_id UUID NOT NULL REFERENCES public.product_skus(id),
    quantity INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.orders (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    order_no VARCHAR(30) UNIQUE NOT NULL,
    user_id UUID NOT NULL REFERENCES public.users(id),
    address_id UUID REFERENCES public.addresses(id),
    total_amount NUMERIC(12,2) NOT NULL,
    discount_amount NUMERIC(12,2) DEFAULT 0,
    shipping_fee NUMERIC(12,2) DEFAULT 0,
    status VARCHAR(20) DEFAULT 'PENDING_PAYMENT',
    handled_by UUID REFERENCES public.users(id),
    approved_by UUID REFERENCES public.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.order_items (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES public.orders(id),
    sku_id UUID NOT NULL REFERENCES public.product_skus(id),
    quantity INTEGER NOT NULL,
    unit_price NUMERIC(12,2) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- STREAMING_CHUNK: 5. 결제 및 기타 로그 테이블 생성
CREATE TABLE IF NOT EXISTS public.payments (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES public.orders(id),
    pg_provider VARCHAR(30) NOT NULL,
    pg_transaction_id VARCHAR(100) UNIQUE,
    method VARCHAR(20) NOT NULL,
    amount NUMERIC(12,2) NOT NULL,
    status VARCHAR(20) NOT NULL,
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.admin_activity_logs (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    actor_id UUID NOT NULL REFERENCES public.users(id),
    action VARCHAR(50) NOT NULL,
    target_table VARCHAR(50) NOT NULL,
    target_id UUID NOT NULL,
    before_value JSONB,
    after_value JSONB,
    ip_address VARCHAR(45),
    created_at TIMESTAMPTZ DEFAULT NOW()
);