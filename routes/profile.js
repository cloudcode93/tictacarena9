const express = require('express');
const router = express.Router();
const { supabase, getSupabaseClient } = require('../config/supabase');
const { authMiddleware } = require('../middleware/auth');

const cache = require('../utils/cache');

// Get current user profile
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const data = await cache.getOrSet(`profile_me_${req.user.id}`, 5, async () => {
      const userClient = getSupabaseClient(req.token);
      let { data: dbData, error } = await userClient
        .from('profiles')
        .select('id, username, level, rank, xp, xp_to_next, score, coins, wins, losses, draws, equipped_avatar_url, equipped_frame, equipped_skin, equipped_effect, online, role, created_at')
        .eq('id', req.user.id)
        .single();
      
      // Auto-provision profile JIT if it doesn't exist (PGRST116: The result contains 0 rows)
      if (error && error.code === 'PGRST116') {
        const usernameBase = req.user.user_metadata?.full_name || req.user.user_metadata?.name || req.user.email?.split('@')[0] || 'Player';
        const newProfile = {
          id: req.user.id,
          username: usernameBase.substring(0, 50),
          level: 1, xp: 0, xp_to_next: 1000, coins: 50, rank: 'Bronze',
          wins: 0, losses: 0, draws: 0, score: 0, role: 'user', online: true
        };
        const { data: inserted, error: insertErr } = await userClient.from('profiles').insert([newProfile]).select().single();
        if (insertErr) throw insertErr;
        return inserted;
      }
      
      if (error) throw error;
      return dbData;
    });

    res.json(data);
  } catch (err) {
    console.error("Profile /me error:", err);
    res.status(err.code === 'PGRST116' || err.message ? 400 : 500).json({ error: err.message || 'Server error' });
  }
});

// Get any user profile by ID
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const data = await cache.getOrSet(`profile_${req.params.id}`, 10, async () => {
      const userClient = getSupabaseClient(req.token);
      const { data: dbData, error } = await userClient
        .from('profiles')
        .select('id, username, level, rank, xp, score, wins, losses, draws, equipped_avatar_url, online, last_seen')
        .eq('id', req.params.id)
        .single();
      if (error) throw error;
      return dbData;
    });

    res.json(data);
  } catch (err) {
    res.status(err.message ? 404 : 500).json({ error: err.message || 'Server error' });
  }
});

// Update current user profile
router.put('/me', authMiddleware, async (req, res) => {
  try {
    const allowedFields = ['username', 'equipped_avatar_url', 'equipped_frame', 'equipped_skin', 'equipped_effect'];
    const updates = {};
    
    // Username validation: 6-10 chars, letters and numbers only
    if (req.body.username !== undefined) {
      const username = String(req.body.username).trim();
      const userRegex = /^(?=.*[a-zA-Z])(?=.*[0-9])[a-zA-Z0-9]{6,10}$/;
      
      if (!userRegex.test(username)) {
        return res.status(400).json({ error: 'Username must be 6-10 characters long and contain both letters and numbers (no special characters).' });
      }
      updates.username = username;
    }

    for (const field of allowedFields) {
      if (field !== 'username' && req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }
    updates.updated_at = new Date().toISOString();

    const userClient = getSupabaseClient(req.token);
    const { data, error } = await userClient
      .from('profiles')
      .update(updates)
      .eq('id', req.user.id)
      .select()
      .single();

    if (error) {
      // Handle Postgres Unique Constraint Violation (Error 23505)
      if (error.code === '23505' || error.message.includes('unique constraint')) {
        return res.status(409).json({ error: 'This username is already taken by another player. Please choose a different one.' });
      }
      return res.status(400).json({ error: error.message });
    }
    
    // Invalidate local cache instantly so the next load shows fresh data
    cache.invalidate(`profile_me_${req.user.id}`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
