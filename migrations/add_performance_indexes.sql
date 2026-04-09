-- ============================================================
-- TicTacArena — Performance Indexes Migration
-- Run this in your Supabase SQL Editor (Dashboard > SQL Editor)
-- ============================================================

-- Leaderboard: profiles sorted by score
CREATE INDEX IF NOT EXISTS idx_profiles_score ON profiles (score DESC);

-- Match history: lookup by player IDs + order by created_at
CREATE INDEX IF NOT EXISTS idx_matches_player1 ON matches (player1_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_matches_player2 ON matches (player2_id, created_at DESC);

-- Friends: lookup by user_id and friend_id
CREATE INDEX IF NOT EXISTS idx_friends_user_id ON friends (user_id);
CREATE INDEX IF NOT EXISTS idx_friends_friend_id ON friends (friend_id);

-- Notifications: lookup by user + unread filter
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications (user_id, read, created_at DESC);

-- World chat: order by created_at for history
CREATE INDEX IF NOT EXISTS idx_world_chat_created ON world_chat (created_at DESC);

-- Direct messages: conversation lookup
CREATE INDEX IF NOT EXISTS idx_dm_sender ON direct_messages (sender_id, created_at);
CREATE INDEX IF NOT EXISTS idx_dm_receiver ON direct_messages (receiver_id, created_at);

-- Banners: active banners sorted
CREATE INDEX IF NOT EXISTS idx_banners_active ON banners (active, sort_order);

-- Shop items: active items sorted by price
CREATE INDEX IF NOT EXISTS idx_shop_items_active ON shop_items (active, price);

-- User items: lookup by user
CREATE INDEX IF NOT EXISTS idx_user_items_user ON user_items (user_id);
