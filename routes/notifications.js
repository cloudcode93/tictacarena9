const express = require('express');
const router = express.Router();
const { getSupabaseClient } = require('../config/supabase');
const { authMiddleware } = require('../middleware/auth');

const cache = require('../utils/cache');

// Get user notifications
router.get('/', authMiddleware, async (req, res) => {
  try {
    const data = await cache.getOrSet(`notifs_${req.user.id}`, 5, async () => {
      const userClient = getSupabaseClient(req.token);
      const { data: dbData, error } = await userClient
        .from('notifications')
        .select('id, title, message, type, read, action_url, created_at')
        .eq('user_id', req.user.id)
        .order('created_at', { ascending: false })
        .limit(30);

      if (error) throw error;
      return dbData;
    });

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Mark notification as read
router.put('/:id/read', authMiddleware, async (req, res) => {
  try {
    const userClient = getSupabaseClient(req.token);
    const { error } = await userClient
      .from('notifications')
      .update({ read: true })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);

    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Mark all as read
router.put('/read-all', authMiddleware, async (req, res) => {
  try {
    const userClient = getSupabaseClient(req.token);
    const { error } = await userClient
      .from('notifications')
      .update({ read: true })
      .eq('user_id', req.user.id)
      .eq('read', false);

    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
