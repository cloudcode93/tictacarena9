const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const cache = require('../utils/cache');

// Get active banners (cached 5 min)
router.get('/', async (req, res) => {
  try {
    const banners = await cache.getOrSet('banners', 300, async () => {
      const { data, error } = await supabase
        .from('banners')
        .select('id, tag, title, subtitle, gradient, image_url, active, sort_order')
        .eq('active', true)
        .order('sort_order');
      if (error) throw error;
      return data || [];
    });
    res.json(banners);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
